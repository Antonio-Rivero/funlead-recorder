use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Sample, SampleFormat};
use serde::Serialize;

#[derive(Serialize)]
pub struct InputDeviceInfo {
    pub id: String,
    pub name: String,
}

/// Enumerates available microphone input devices. The default device is first.
/// `id` is the device name (cpal's stable identifier on both CoreAudio and WASAPI).
// name() is soft-deprecated in cpal 0.17, but the human-readable name is the
// portable picker key we want here; id()/description() add non-portable types for no gain.
#[allow(deprecated)]
pub fn list_input_devices() -> Vec<InputDeviceInfo> {
    let host = cpal::default_host();
    let default_name = host.default_input_device().and_then(|d| d.name().ok());

    let mut devices: Vec<InputDeviceInfo> = match host.input_devices() {
        Ok(iter) => iter
            .filter_map(|d| {
                d.name().ok().map(|name| InputDeviceInfo {
                    id: name.clone(),
                    name,
                })
            })
            .collect(),
        Err(_) => Vec::new(),
    };

    // Surface the default device first so the UI can preselect it.
    if let Some(def) = default_name {
        if let Some(pos) = devices.iter().position(|d| d.id == def) {
            devices.swap(0, pos);
        }
    }
    devices
}

#[allow(deprecated)]
fn host_device(device_id: Option<&str>) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    match device_id {
        Some(id) => host
            .input_devices()
            .map_err(|e| format!("No se pudieron enumerar los micrófonos: {e}"))?
            .find(|d| d.name().map(|n| n == id).unwrap_or(false))
            .ok_or_else(|| format!("No se encontró el micrófono «{id}».")),
        None => host
            .default_input_device()
            .ok_or_else(|| "No hay micrófono por defecto disponible.".into()),
    }
}

/// Result of a finished microphone capture.
pub struct MicResult {
    pub wav_path: PathBuf,
}

/// A running microphone capture. The cpal `Stream` is not `Send`, so it lives
/// entirely inside a dedicated thread; we only communicate via a stop channel.
pub struct MicCapture {
    stop_tx: Sender<()>,
    thread: JoinHandle<Result<MicResult, String>>,
}

impl MicCapture {
    /// Starts capturing the chosen (or default) microphone into a temp WAV (16-bit PCM).
    /// Returns `Err` if the device can't be opened (no permission / unplugged); the
    /// caller is expected to continue with a video-only recording in that case.
    pub fn start(device_id: Option<&str>, wav_path: PathBuf) -> Result<Self, String> {
        let device = host_device(device_id)?;
        let supported = device
            .default_input_config()
            .map_err(|e| format!("No se pudo leer la configuración del micrófono: {e}"))?;

        let sample_format = supported.sample_format();
        let config: cpal::StreamConfig = supported.into();
        let channels = config.channels;

        let spec = hound::WavSpec {
            channels,
            sample_rate: config.sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let writer = hound::WavWriter::create(&wav_path, spec)
            .map_err(|e| format!("No se pudo crear el WAV temporal: {e}"))?;
        let writer = Arc::new(Mutex::new(Some(writer)));

        let (stop_tx, stop_rx): (Sender<()>, Receiver<()>) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();

        // The thread owns the Stream for its whole lifetime (Stream: !Send).
        let thread = std::thread::spawn(move || {
            let w = writer.clone();
            let err_w = writer.clone();
            let err_cb = move |e: cpal::StreamError| {
                // On a mid-recording device error, finalize what we have rather than panic.
                eprintln!("error del stream de micrófono: {e}");
                if let Ok(mut guard) = err_w.lock() {
                    if let Some(active) = guard.take() {
                        let _ = active.finalize();
                    }
                }
            };

            let stream = match sample_format {
                SampleFormat::F32 => build_stream::<f32>(&device, &config, w, err_cb),
                SampleFormat::I16 => build_stream::<i16>(&device, &config, w, err_cb),
                SampleFormat::U16 => build_stream::<u16>(&device, &config, w, err_cb),
                other => Err(format!("Formato de micrófono no soportado: {other:?}")),
            };

            let stream = match stream {
                Ok(s) => s,
                Err(e) => {
                    let _ = ready_tx.send(Err(e.clone()));
                    return Err(e);
                }
            };

            if let Err(e) = stream.play() {
                let e = format!("No se pudo arrancar la captura de micrófono: {e}");
                let _ = ready_tx.send(Err(e.clone()));
                return Err(e);
            }
            let _ = ready_tx.send(Ok(()));

            // Block until stop is requested (or the channel drops).
            let _ = stop_rx.recv();
            drop(stream); // stop the stream before flushing the writer

            let finalized = match writer.lock() {
                Ok(mut guard) => guard.take(),
                Err(_) => None,
            };
            if let Some(active) = finalized {
                active
                    .finalize()
                    .map_err(|e| format!("No se pudo cerrar el WAV: {e}"))?;
            }

            Ok(MicResult { wav_path })
        });

        // Surface device-open failures synchronously so the caller can fall back to video-only.
        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Self { stop_tx, thread }),
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => Err("El hilo de captura de micrófono terminó antes de tiempo.".into()),
        }
    }

    /// Signals the capture thread to stop and returns the finished WAV.
    pub fn stop(self) -> Result<MicResult, String> {
        let _ = self.stop_tx.send(());
        self.thread
            .join()
            .map_err(|_| "El hilo de captura de micrófono entró en pánico.".to_string())?
    }
}

type SharedWriter = Arc<Mutex<Option<hound::WavWriter<std::io::BufWriter<std::fs::File>>>>>;

fn build_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    writer: SharedWriter,
    err_cb: impl Fn(cpal::StreamError) + Send + 'static,
) -> Result<cpal::Stream, String>
where
    T: Sample + cpal::SizedSample,
    i16: cpal::FromSample<T>,
{
    let data_cb = move |data: &[T], _: &cpal::InputCallbackInfo| {
        if let Ok(mut guard) = writer.lock() {
            if let Some(w) = guard.as_mut() {
                for &sample in data {
                    let s: i16 = sample.to_sample();
                    let _ = w.write_sample(s);
                }
            }
        }
    };

    device
        .build_input_stream(config, data_cb, err_cb, None)
        .map_err(|e| format!("No se pudo construir el stream de micrófono: {e}"))
}
