use std::io::Write;
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::process::ChildStdin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Instant;

use ffmpeg_sidecar::child::FfmpegChild;
use scap::capturer::{Capturer, Options, Resolution};
use scap::frame::{Frame, FrameType, VideoFrame};
use scap::Target;
use serde::Serialize;
use tauri::AppHandle;

use crate::audio::MicCapture;

#[derive(Serialize)]
pub struct DisplayInfo {
    pub id: u32,
    pub title: String,
}

#[derive(Serialize)]
pub struct StopResult {
    pub path: String,
    /// Set when the mic was requested but couldn't be captured (recording fell back to video-only).
    pub mic_warning: Option<String>,
}

/// The active recording segment in progress: its own ffmpeg encoder + mic capture.
/// Each pause closes the current segment and the next resume opens a fresh one, so
/// the paused time never lands in any segment — there is no frozen frame on concat.
struct ActiveSegment {
    ffmpeg: FfmpegChild,
    video_path: PathBuf,
    mic: Option<MicCapture>,
    mic_wav_path: Option<PathBuf>,
}

/// A finished segment flushed to disk, ready to be muxed/concatenated at stop.
struct CompletedSegment {
    video_path: PathBuf,
    mic_wav_path: Option<PathBuf>,
}

/// State held across the start/stop command boundary while a recording runs.
struct Session {
    stop_flag: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    frame_count: Arc<AtomicU64>,
    started_at: Instant,
    capture_thread: JoinHandle<()>,
    /// Shared slot holding the stdin of the *active* segment's ffmpeg. The capture
    /// thread writes frames here when not paused; pause/stop set it to `None`
    /// (dropping the stdin → EOF → ffmpeg flushes that segment).
    stdin_slot: Arc<Mutex<Option<ChildStdin>>>,
    /// Active segment, or `None` while paused (between pause and resume).
    current: Option<ActiveSegment>,
    /// Segments already flushed to disk (everything except the in-progress one).
    completed: Vec<CompletedSegment>,
    width: u32,
    height: u32,
    mic_device_id: Option<String>,
    /// Whether the mic started OK in segment 0. If the mic was never requested or
    /// failed, later segments also record without mic.
    has_mic: bool,
    dir: PathBuf,
    stamp: String,
    final_path: PathBuf,
    seg_index: u32,
    /// Warning surfaced at stop time if the mic failed to start.
    mic_warning: Option<String>,
}

#[derive(Default)]
pub struct RecorderState {
    session: Mutex<Option<Session>>,
}

/// Wraps `scap::get_all_targets`, which can panic (e.g. scap 0.0.8 unwraps when
/// the macOS Screen Recording permission isn't granted). A panic here would
/// abort the whole process, so we catch it and turn it into an `Err`. The
/// closure isn't `UnwindSafe`, but there is no shared state to leave corrupted
/// on a panic, so `AssertUnwindSafe` is sound.
fn safe_get_all_targets() -> Result<Vec<Target>, String> {
    std::panic::catch_unwind(AssertUnwindSafe(scap::get_all_targets)).map_err(|_| {
        "No se pudieron enumerar las pantallas (¿falta el permiso de grabación?).".to_string()
    })
}

pub fn list_displays() -> Result<Vec<DisplayInfo>, String> {
    if !scap::is_supported() {
        return Err("La captura de pantalla no es compatible en este sistema.".into());
    }
    // Gate on the permission BEFORE touching get_all_targets: without it,
    // scap panics on macOS and aborts the app. With the gate, the empty list
    // surfaces cleanly and the UI shows the "grant permission" screen.
    if !scap::has_permission() {
        return Ok(Vec::new());
    }
    let displays = safe_get_all_targets()?
        .into_iter()
        .filter_map(|t| match t {
            Target::Display(d) => Some(DisplayInfo {
                id: d.id,
                title: d.title,
            }),
            _ => None,
        })
        .collect::<Vec<_>>();
    Ok(displays)
}

pub fn permission_status() -> &'static str {
    if !scap::is_supported() {
        return "unsupported";
    }
    if scap::has_permission() {
        "granted"
    } else {
        "denied"
    }
}

/// Triggers the OS permission prompt (macOS TCC) if not yet granted.
pub fn request_permission() {
    scap::request_permission();
}

/// Debug helper: logs the window titles scap can see, so we can confirm whether
/// our high-level panels (camera / control bar) appear in the capture window list
/// — i.e. whether they can be excluded from the recording by title.
pub fn log_capture_window_titles() {
    match safe_get_all_targets() {
        Ok(targets) => {
            let titles: Vec<String> = targets
                .into_iter()
                .filter_map(|t| match t {
                    Target::Window(w) => Some(format!("[{}] {:?}", w.id, w.title)),
                    _ => None,
                })
                .collect();
            eprintln!("scap windows ({}): {}", titles.len(), titles.join(" | "));
        }
        Err(e) => eprintln!("log_capture_window_titles error: {e}"),
    }
}

fn output_dir() -> Result<PathBuf, String> {
    let home = dirs_home().ok_or("No se pudo localizar el directorio de usuario.")?;
    let dir = home.join("Movies").join("FunLead");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("No se pudo crear la carpeta de salida: {e}"))?;
    Ok(dir)
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Spawns a capture-encoder ffmpeg with EXACTLY the recorder's tuned args
/// (rawvideo BGRA in → libx264 yuv420p out, wall-clock timestamps + VFR, no
/// `-shortest`). Reused by `start_recording` and each `resume_recording`.
fn spawn_capture_ffmpeg(
    app: &AppHandle,
    data_dir: &Path,
    width: u32,
    height: u32,
    out_path: &Path,
) -> Result<FfmpegChild, String> {
    let out_str = out_path
        .to_str()
        .ok_or("La ruta de salida no es UTF-8 válido.")?;
    crate::ffmpeg::command(app, data_dir)?
        .args(["-f", "rawvideo"])
        .args(["-pix_fmt", "bgra"])
        .args(["-s", &format!("{width}x{height}")])
        // scap delivers frames at a variable, slower-than-requested real rate (a
        // single BGRA frame at Retina resolution is tens of MB, so the pipe to
        // ffmpeg is the bottleneck — ~6 fps in practice on a 4K display). Tag each
        // frame with the wall-clock instant it arrives instead of assuming a fixed
        // input rate; otherwise ffmpeg packs the slow frames as if they were `fps`
        // apart and the clip plays back sped up (an 18 s capture became 3.7 s).
        .args(["-use_wallclock_as_timestamps", "1"])
        .args(["-i", "-"])
        .args(["-c:v", "libx264"])
        .args(["-preset", "veryfast"])
        .args(["-pix_fmt", "yuv420p"])
        // Variable frame rate: preserve the real per-frame timing (no duplicated
        // frames) so the encoded duration equals wall-clock time.
        .args(["-fps_mode", "vfr"])
        .args(["-movflags", "+faststart"])
        .arg("-y")
        .arg(out_str)
        .spawn()
        .map_err(|e| format!("No se pudo lanzar ffmpeg: {e}"))
}

#[allow(clippy::too_many_arguments)]
pub fn start_recording(
    app: &AppHandle,
    state: &RecorderState,
    data_dir: &std::path::Path,
    display_id: u32,
    fps: u32,
    mic_device_id: Option<String>,
    // Titles of our own windows (e.g. the floating control bar) to keep OUT of the
    // capture: the user sees them on screen but they never land in the video.
    exclude_titles: &[String],
    // "auto" keeps the native captured resolution; "720"/"1080" cap it.
    quality: &str,
) -> Result<(), String> {
    let mut guard = state.session.lock().map_err(|_| "Estado bloqueado.")?;
    if guard.is_some() {
        return Err("Ya hay una grabación en curso.".into());
    }

    if !scap::is_supported() {
        return Err("La captura de pantalla no es compatible en este sistema.".into());
    }
    if !scap::has_permission() {
        return Err("Falta el permiso de Grabación de pantalla. Concédelo en Ajustes del Sistema → Privacidad y seguridad → Grabación de pantalla y reabre FunLead Recorder.".into());
    }

    // One enumeration: pick the display to capture and resolve any windows we want
    // excluded (matched by title). Window exclusion is macOS-only in scap.
    let all_targets = safe_get_all_targets()?;
    let target = all_targets
        .iter()
        .find(|t| matches!(t, Target::Display(d) if d.id == display_id))
        .cloned()
        .ok_or("No se encontró la pantalla seleccionada.")?;

    let excluded: Vec<Target> = if exclude_titles.is_empty() {
        Vec::new()
    } else {
        all_targets
            .iter()
            .filter(|t| {
                matches!(t, Target::Window(w) if exclude_titles.iter().any(|x| x == &w.title))
            })
            .cloned()
            .collect()
    };

    let output_resolution = match quality {
        "720" => Resolution::_720p,
        "1080" => Resolution::_1080p,
        _ => Resolution::Captured,
    };

    let options = Options {
        fps,
        show_cursor: true,
        target: Some(target),
        output_type: FrameType::BGRAFrame,
        output_resolution,
        excluded_targets: if excluded.is_empty() {
            None
        } else {
            Some(excluded)
        },
        ..Default::default()
    };

    let mut capturer =
        Capturer::build(options).map_err(|e| format!("No se pudo iniciar la captura: {e}"))?;
    capturer.start_capture();

    // The first frame tells us the real pixel dimensions (Retina-safe);
    // we must feed exactly those to ffmpeg or the rawvideo stream desyncs.
    let first = capturer
        .get_next_frame()
        .map_err(|e| format!("No llegó el primer frame: {e}"))?;
    let (width, height, first_bytes) = match first {
        Frame::Video(VideoFrame::BGRA(f)) => (f.width as u32, f.height as u32, f.data),
        Frame::Video(_) => {
            capturer.stop_capture();
            return Err("El formato de frame recibido no es BGRA.".into());
        }
        Frame::Audio(_) => {
            capturer.stop_capture();
            return Err("Se recibió audio en lugar de vídeo.".into());
        }
    };

    let dir = output_dir()?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let final_path = dir.join(format!("FunLead-{stamp}.mp4"));

    // Try to start the mic first; if it fails, fall back to video-only.
    let (mic, mic_wav_path, mic_warning) = if let Some(ref id) = mic_device_id {
        let wav = dir.join(format!("FunLead-{stamp}.seg0.mic.wav"));
        match MicCapture::start(Some(id.as_str()), wav.clone()) {
            Ok(cap) => (Some(cap), Some(wav), None),
            Err(e) => (
                None,
                None,
                Some(format!(
                    "Se grabó solo vídeo (micrófono no disponible: {e})."
                )),
            ),
        }
    } else {
        (None, None, None)
    };
    let has_mic = mic.is_some();

    // Segment 0 is always a temp file (FunLead-<stamp>.seg0.mp4); the final output
    // is decided at stop (single segment → rename; multiple → concat).
    let video_path = dir.join(format!("FunLead-{stamp}.seg0.mp4"));

    let mut ffmpeg = spawn_capture_ffmpeg(app, data_dir, width, height, &video_path)?;
    let stdin: ChildStdin = ffmpeg
        .take_stdin()
        .ok_or("No se pudo abrir el stdin de ffmpeg.")?;

    let stop_flag = Arc::new(AtomicBool::new(false));
    let paused = Arc::new(AtomicBool::new(false));
    let frame_count = Arc::new(AtomicU64::new(0));
    let stdin_slot: Arc<Mutex<Option<ChildStdin>>> = Arc::new(Mutex::new(Some(stdin)));
    let started_at = Instant::now();

    let thread_flag = stop_flag.clone();
    let thread_paused = paused.clone();
    let thread_frames = frame_count.clone();
    let thread_slot = stdin_slot.clone();

    let capture_thread = std::thread::spawn(move || {
        // Write the first frame (we already consumed it to learn the dimensions).
        write_frame_to_slot(&thread_slot, &first_bytes, &thread_frames);
        while !thread_flag.load(Ordering::Relaxed) {
            match capturer.get_next_frame() {
                Ok(Frame::Video(VideoFrame::BGRA(f))) => {
                    // While paused, keep pulling frames (re-arming scap is costly
                    // and re-prompts for permission) but DROP them: no active
                    // segment should contain paused time.
                    if thread_paused.load(Ordering::Relaxed) {
                        continue;
                    }
                    write_frame_to_slot(&thread_slot, &f.data, &thread_frames);
                }
                Ok(_) => continue,
                // stop_capture() drops the sender → RecvError ends the loop.
                Err(_) => break,
            }
        }
        capturer.stop_capture();
        // Drop whatever stdin is still active → EOF so its ffmpeg flushes & exits.
        if let Ok(mut slot) = thread_slot.lock() {
            *slot = None;
        }
    });

    *guard = Some(Session {
        stop_flag,
        paused,
        frame_count,
        started_at,
        capture_thread,
        stdin_slot,
        current: Some(ActiveSegment {
            ffmpeg,
            video_path,
            mic,
            mic_wav_path,
        }),
        completed: Vec::new(),
        width,
        height,
        mic_device_id,
        has_mic,
        dir,
        stamp,
        final_path,
        seg_index: 0,
        mic_warning,
    });

    Ok(())
}

/// Writes one frame to the active stdin held in `slot`. If the slot is empty
/// (paused/closing) the frame is dropped. A write error (segment EOF) clears the
/// slot but never tears down the whole capture thread — the next resume re-arms it.
fn write_frame_to_slot(
    slot: &Arc<Mutex<Option<ChildStdin>>>,
    bytes: &[u8],
    frames: &Arc<AtomicU64>,
) {
    let Ok(mut guard) = slot.lock() else {
        return;
    };
    let Some(stdin) = guard.as_mut() else {
        return;
    };
    if stdin.write_all(bytes).is_err() {
        // The active ffmpeg went away (segment ended); drop the stale stdin and
        // wait for resume to install a fresh one.
        *guard = None;
        return;
    }
    frames.fetch_add(1, Ordering::Relaxed);
}

pub fn pause_recording(state: &RecorderState) -> Result<(), String> {
    // Take the active segment out from under the lock; the ffmpeg wait() below is
    // milliseconds, but we mirror stop's pattern and avoid holding the mutex while
    // blocking on a child process.
    let active = {
        let mut guard = state.session.lock().map_err(|_| "Estado bloqueado.")?;
        let session = guard.as_mut().ok_or("No hay ninguna grabación en curso.")?;
        if session.paused.load(Ordering::Relaxed) {
            return Err("La grabación ya está en pausa.".into());
        }
        // Stop frames flowing and close the active segment's stdin → EOF → flush.
        session.paused.store(true, Ordering::Relaxed);
        if let Ok(mut slot) = session.stdin_slot.lock() {
            *slot = None;
        }
        session
            .current
            .take()
            .ok_or("No hay ningún segmento activo que pausar.")?
    };

    // Flush the segment to disk (outside the lock).
    let mut ffmpeg = active.ffmpeg;
    ffmpeg
        .wait()
        .map_err(|e| format!("ffmpeg no terminó correctamente al pausar: {e}"))?;
    let mic_wav_path = match active.mic {
        Some(mic) => match mic.stop() {
            Ok(r) => Some(r.wav_path),
            Err(e) => {
                eprintln!("el micrófono no se cerró limpiamente al pausar: {e}");
                None
            }
        },
        None => active.mic_wav_path,
    };

    let mut guard = state.session.lock().map_err(|_| "Estado bloqueado.")?;
    let session = guard.as_mut().ok_or("No hay ninguna grabación en curso.")?;
    session.completed.push(CompletedSegment {
        video_path: active.video_path,
        mic_wav_path,
    });
    Ok(())
}

pub fn resume_recording(
    app: &AppHandle,
    state: &RecorderState,
    data_dir: &std::path::Path,
) -> Result<(), String> {
    // Read the params we need under the lock, then do the slow work, then commit.
    let (width, height, dir, stamp, has_mic, mic_device_id, seg_index, slot) = {
        let mut guard = state.session.lock().map_err(|_| "Estado bloqueado.")?;
        let session = guard.as_mut().ok_or("No hay ninguna grabación en curso.")?;
        if !session.paused.load(Ordering::Relaxed) {
            return Err("La grabación no está en pausa.".into());
        }
        let next_index = session.seg_index + 1;
        (
            session.width,
            session.height,
            session.dir.clone(),
            session.stamp.clone(),
            session.has_mic,
            session.mic_device_id.clone(),
            next_index,
            session.stdin_slot.clone(),
        )
    };

    let video_path = dir.join(format!("FunLead-{stamp}.seg{seg_index}.mp4"));

    // Start a fresh mic for this segment (if the recording had one). A failure
    // here only drops the mic for this segment; the recording continues.
    let (mic, mic_wav_path, seg_warning) = if has_mic {
        let wav = dir.join(format!("FunLead-{stamp}.seg{seg_index}.mic.wav"));
        match MicCapture::start(mic_device_id.as_deref(), wav.clone()) {
            Ok(cap) => (Some(cap), Some(wav), None),
            Err(e) => (
                None,
                None,
                Some(format!(
                    "Un tramo se grabó sin micrófono (no disponible al reanudar: {e})."
                )),
            ),
        }
    } else {
        (None, None, None)
    };

    let mut ffmpeg = spawn_capture_ffmpeg(app, data_dir, width, height, &video_path)?;
    let stdin: ChildStdin = ffmpeg.take_stdin().ok_or_else(|| {
        // Don't leak the started mic if stdin can't be taken.
        "No se pudo abrir el stdin de ffmpeg al reanudar.".to_string()
    })?;

    // Install the new stdin and clear pause so the capture thread starts writing.
    {
        let mut s = slot.lock().map_err(|_| "Estado de stdin bloqueado.")?;
        *s = Some(stdin);
    }

    let mut guard = state.session.lock().map_err(|_| "Estado bloqueado.")?;
    let session = guard.as_mut().ok_or("No hay ninguna grabación en curso.")?;
    session.seg_index = seg_index;
    session.current = Some(ActiveSegment {
        ffmpeg,
        video_path,
        mic,
        mic_wav_path,
    });
    if let Some(w) = seg_warning {
        // Keep the first warning if one already exists; otherwise record this one.
        if session.mic_warning.is_none() {
            session.mic_warning = Some(w);
        }
    }
    session.paused.store(false, Ordering::Relaxed);
    Ok(())
}

pub fn stop_recording(
    app: &AppHandle,
    state: &RecorderState,
    data_dir: &std::path::Path,
) -> Result<StopResult, String> {
    let session = {
        let mut guard = state.session.lock().map_err(|_| "Estado bloqueado.")?;
        guard.take().ok_or("No hay ninguna grabación en curso.")?
    };

    // Stop video capture; the capture thread drops the active stdin → EOF.
    session.stop_flag.store(true, Ordering::Relaxed);
    let elapsed_secs = session.started_at.elapsed().as_secs_f64();
    let _ = session.capture_thread.join();

    // Diagnostic only: scap's real delivery rate sits well below the requested fps
    // on high-resolution displays. The clip's duration is correct regardless (the
    // encoder stamps frames by wall clock), but this surfaces the true capture rate.
    let frames = session.frame_count.load(Ordering::Relaxed);
    if elapsed_secs > 0.0 {
        eprintln!(
            "captura {frames} frames en {elapsed_secs:.1}s = {:.1} fps efectivos",
            frames as f64 / elapsed_secs
        );
    }

    let Session {
        current,
        mut completed,
        final_path,
        mut mic_warning,
        ..
    } = session;

    // Close the in-flight segment if we stopped while recording (not while paused).
    if let Some(active) = current {
        let mut ffmpeg = active.ffmpeg;
        ffmpeg
            .wait()
            .map_err(|e| format!("ffmpeg no terminó correctamente: {e}"))?;
        let mic_wav_path = match active.mic {
            Some(mic) => match mic.stop() {
                Ok(r) => Some(r.wav_path),
                Err(e) => {
                    eprintln!("el micrófono no se cerró limpiamente: {e}");
                    None
                }
            },
            None => active.mic_wav_path,
        };
        completed.push(CompletedSegment {
            video_path: active.video_path,
            mic_wav_path,
        });
    }

    if completed.is_empty() {
        return Err("No se grabó ningún segmento.".into());
    }

    // Track every temp file we create so we can clean them up best-effort at the end.
    let mut temps: Vec<PathBuf> = Vec::new();

    // Build a "ready" mp4 per segment: mux video+wav when there's audio, else use
    // the raw video as-is. No -shortest (matches the original mux behavior).
    let mut ready: Vec<PathBuf> = Vec::with_capacity(completed.len());
    for seg in &completed {
        temps.push(seg.video_path.clone());
        match &seg.mic_wav_path {
            Some(wav) => {
                temps.push(wav.clone());
                let muxed = with_extension_suffix(&seg.video_path, "muxed.mp4");
                match mux_segment(app, data_dir, &seg.video_path, wav, &muxed) {
                    Ok(()) => {
                        temps.push(muxed.clone());
                        ready.push(muxed);
                    }
                    Err(e) => {
                        // Degrade: keep the video-only segment so audio loss doesn't
                        // drop the segment entirely.
                        eprintln!("mux de segmento falló ({e}); se usa solo vídeo");
                        if mic_warning.is_none() {
                            mic_warning = Some("Un tramo perdió el audio al mezclar.".to_string());
                        }
                        ready.push(seg.video_path.clone());
                    }
                }
            }
            None => ready.push(seg.video_path.clone()),
        }
    }

    // Single segment (the "0 pauses" path) → just move it to the final path.
    if ready.len() == 1 {
        let only = &ready[0];
        std::fs::rename(only, &final_path)
            .map_err(|e| format!("No se pudo guardar la grabación: {e}"))?;
        // Don't delete the file we just moved into place.
        cleanup_temps(&temps, &final_path);
        return Ok(StopResult {
            path: path_string(&final_path)?,
            mic_warning,
        });
    }

    // Multiple segments → concat with the demuxer (stream copy, no re-encode).
    let list_path = with_extension_suffix(&final_path, "concat.txt");
    write_concat_list(&list_path, &ready)?;
    temps.push(list_path.clone());

    let final_str = path_string(&final_path)?;
    let list_str = path_string(&list_path)?;
    let concat = crate::ffmpeg::command(app, data_dir)?
        .args(["-f", "concat"])
        .args(["-safe", "0"])
        .args(["-i", &list_str])
        .args(["-c", "copy"])
        .args(["-movflags", "+faststart"])
        .arg("-y")
        .arg(&final_str)
        .spawn()
        .map_err(|e| format!("No se pudo lanzar ffmpeg para unir los tramos: {e}"))?
        .wait()
        .map_err(|e| format!("La unión de los tramos falló: {e}"))?;

    if !concat.success() {
        // Degrade: don't lose the recording. Keep the first ready segment as the
        // final file and warn that the join failed.
        let _ = std::fs::rename(&ready[0], &final_path);
        cleanup_temps(&temps, &final_path);
        return Ok(StopResult {
            path: path_string(&final_path)?,
            mic_warning: Some(
                "No se pudieron unir los tramos de la pausa; se guardó el primer tramo.".into(),
            ),
        });
    }

    cleanup_temps(&temps, &final_path);
    Ok(StopResult {
        path: final_str,
        mic_warning,
    })
}

/// Re-encodes a precise [in_sec, out_sec) slice of `path` to a new mp4 next to it.
/// `-ss`/`-to` before `-i` index the input timeline; the re-encode makes the cut
/// frame-accurate. Returns the absolute path of the trimmed file.
pub fn trim_recording(
    app: &AppHandle,
    data_dir: &std::path::Path,
    path: &str,
    in_sec: f64,
    out_sec: f64,
) -> Result<String, String> {
    // Reject NaN/negative/inverted ranges explicitly (don't trust the UI).
    if in_sec.is_nan() || out_sec.is_nan() {
        return Err("Los tiempos de recorte no son válidos.".into());
    }
    if in_sec < 0.0 {
        return Err("El inicio del recorte no puede ser negativo.".into());
    }
    if out_sec <= in_sec {
        return Err("El fin del recorte debe ser posterior al inicio.".into());
    }
    if out_sec - in_sec < 0.1 {
        return Err("El recorte es demasiado corto (mínimo 0,1 s).".into());
    }

    let src = PathBuf::from(path);
    let dir = src
        .parent()
        .ok_or("No se pudo determinar la carpeta del vídeo original.")?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let out_path = dir.join(format!("FunLead-{stamp}.trim.mp4"));
    let out_str = path_string(&out_path)?;

    let status = crate::ffmpeg::command(app, data_dir)?
        .args(["-ss", &format!("{in_sec}")])
        .args(["-to", &format!("{out_sec}")])
        .args(["-i", path])
        .args(["-c:v", "libx264"])
        .args(["-preset", "veryfast"])
        .args(["-pix_fmt", "yuv420p"])
        .args(["-c:a", "aac"])
        .args(["-b:a", "192k"])
        .args(["-movflags", "+faststart"])
        .arg("-y")
        .arg(&out_str)
        .spawn()
        .map_err(|e| format!("No se pudo lanzar ffmpeg para recortar: {e}"))?
        .wait()
        .map_err(|e| format!("El recorte falló: {e}"))?;

    if !status.success() {
        return Err("El recorte del vídeo no se completó correctamente.".into());
    }
    Ok(out_str)
}

/// Muxes one segment's video + WAV into `out` (video stream-copied, audio→AAC).
/// No -shortest: both tracks span the same real-time active window.
fn mux_segment(
    app: &AppHandle,
    data_dir: &Path,
    video: &Path,
    wav: &Path,
    out: &Path,
) -> Result<(), String> {
    let video_str = path_string(video)?;
    let wav_str = path_string(wav)?;
    let out_str = path_string(out)?;
    let status = crate::ffmpeg::command(app, data_dir)?
        .args(["-i", &video_str])
        .args(["-i", &wav_str])
        .args(["-c:v", "copy"])
        .args(["-c:a", "aac"])
        .args(["-b:a", "192k"])
        .args(["-movflags", "+faststart"])
        .arg("-y")
        .arg(&out_str)
        .spawn()
        .map_err(|e| format!("No se pudo lanzar ffmpeg para el mux: {e}"))?
        .wait()
        .map_err(|e| format!("El mux de audio+vídeo falló: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("El mux de audio+vídeo no se completó.".into())
    }
}

/// Writes a concat-demuxer list. Paths are absolute and single-quoted with any
/// embedded single quotes escaped per ffmpeg's concat syntax.
fn write_concat_list(list_path: &Path, files: &[PathBuf]) -> Result<(), String> {
    let mut body = String::new();
    for f in files {
        let s = f
            .to_str()
            .ok_or("Una ruta de segmento no es UTF-8 válido.")?;
        let escaped = s.replace('\'', "'\\''");
        body.push_str(&format!("file '{escaped}'\n"));
    }
    std::fs::write(list_path, body)
        .map_err(|e| format!("No se pudo escribir la lista de unión: {e}"))
}

/// Appends a suffix to a path's file name (e.g. `FunLead-X.seg0.mp4` + `muxed.mp4`
/// → `FunLead-X.seg0.muxed.mp4`), keeping it in the same directory.
fn with_extension_suffix(path: &Path, suffix: &str) -> PathBuf {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("FunLead");
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    dir.join(format!("{stem}.{suffix}"))
}

/// Best-effort removal of temp files, never touching the file we kept as final.
fn cleanup_temps(temps: &[PathBuf], keep: &Path) {
    for t in temps {
        if t != keep {
            let _ = std::fs::remove_file(t);
        }
    }
}

fn path_string(p: &Path) -> Result<String, String> {
    p.to_str()
        .ok_or_else(|| "La ruta de salida no es UTF-8 válido.".to_string())
        .map(|s| s.to_string())
}
