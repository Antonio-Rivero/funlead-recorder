mod audio;
mod camera;
mod controls;
mod ffmpeg;
mod project;
mod recorder;
mod render;
mod transcribe;

use std::path::PathBuf;

use audio::InputDeviceInfo;
use recorder::{DisplayInfo, RecorderState, StopResult};
use tauri::{AppHandle, Manager, State};

/// Writable per-app directory where we cache a downloaded ffmpeg binary.
/// Never inside the (read-only, code-signed) .app bundle.
fn ffmpeg_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("ffmpeg"))
        .map_err(|e| format!("No se pudo localizar la carpeta de datos de la app: {e}"))
}

#[tauri::command]
fn list_displays() -> Result<Vec<DisplayInfo>, String> {
    recorder::list_displays()
}

#[tauri::command]
fn list_input_devices() -> Vec<InputDeviceInfo> {
    audio::list_input_devices()
}

#[tauri::command]
fn check_permission() -> Result<String, String> {
    Ok(recorder::permission_status().to_string())
}

#[tauri::command]
fn request_permission() -> Result<(), String> {
    recorder::request_permission();
    Ok(())
}

/// Returns true if a usable ffmpeg is already available (no download needed).
/// The UI calls this to decide whether to show a "descargando ffmpeg…" notice.
#[tauri::command]
fn ffmpeg_available(app: AppHandle) -> bool {
    ffmpeg_data_dir(&app)
        .map(|dir| ffmpeg::is_available(&app, &dir))
        .unwrap_or(false)
}

/// Ensures ffmpeg is present, downloading it once if needed. Run before the
/// first recording so the (potentially slow) download surfaces with feedback
/// instead of stalling the start. Runs on a blocking thread to avoid freezing
/// the UI during the download.
#[tauri::command]
async fn ensure_ffmpeg(app: AppHandle) -> Result<(), String> {
    let dir = ffmpeg_data_dir(&app)?;
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || ffmpeg::ensure(&app2, &dir).map(|_| ()))
        .await
        .map_err(|e| format!("La preparación de ffmpeg se interrumpió: {e}"))?
}

#[tauri::command]
fn start_recording(
    app: AppHandle,
    state: State<'_, RecorderState>,
    display_id: u32,
    fps: u32,
    mic_device_id: Option<String>,
    quality: Option<String>,
) -> Result<(), String> {
    let data_dir = ffmpeg_data_dir(&app)?;
    // Keep the floating control bar out of the recording (it stays visible to the
    // user but never lands in the video).
    let exclude = [controls::CONTROLS_TITLE.to_string()];
    let quality = quality.unwrap_or_else(|| "auto".to_string());
    recorder::start_recording(
        &app,
        state.inner(),
        &data_dir,
        display_id,
        fps,
        mic_device_id,
        &exclude,
        &quality,
    )
}

#[tauri::command]
fn stop_recording(app: AppHandle, state: State<'_, RecorderState>) -> Result<StopResult, String> {
    let data_dir = ffmpeg_data_dir(&app)?;
    recorder::stop_recording(&app, state.inner(), &data_dir)
}

#[tauri::command]
fn pause_recording(state: State<'_, RecorderState>) -> Result<(), String> {
    recorder::pause_recording(state.inner())
}

#[tauri::command]
fn resume_recording(app: AppHandle, state: State<'_, RecorderState>) -> Result<(), String> {
    let data_dir = ffmpeg_data_dir(&app)?;
    recorder::resume_recording(&app, state.inner(), &data_dir)
}

#[tauri::command]
fn trim_recording(
    app: AppHandle,
    path: String,
    in_sec: f64,
    out_sec: f64,
) -> Result<String, String> {
    let data_dir = ffmpeg_data_dir(&app)?;
    recorder::trim_recording(&app, &data_dir, &path, in_sec, out_sec)
}

#[tauri::command]
fn toggle_camera_window(app: AppHandle, device_id: Option<String>) -> Result<bool, String> {
    camera::toggle(&app, device_id)
}

#[tauri::command]
fn is_camera_window_open(app: AppHandle) -> bool {
    camera::is_open(&app)
}

#[tauri::command]
fn set_camera_device(app: AppHandle, device_id: Option<String>) -> Result<(), String> {
    camera::set_device(&app, device_id)
}

#[tauri::command]
fn show_controls_window(app: AppHandle) -> Result<(), String> {
    controls::show(&app)
}

#[tauri::command]
fn hide_controls_window(app: AppHandle) -> Result<(), String> {
    controls::hide(&app)
}

#[tauri::command]
fn is_controls_window_open(app: AppHandle) -> bool {
    controls::is_open(&app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // Required so the camera bubble can be reclassed into a non-activating NSPanel
    // (the only thing that floats over ANOTHER app's native fullscreen Space).
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|_app| {
            // Debug-only: auto-open the camera bubble ~1.2s after start so the
            // panel-over-fullscreen behavior can be verified from a terminal run
            // without needing the camera UI or a real camera. Gated strictly on
            // FUNLEAD_RECORDER_DEBUG_CAM=1 — never fires otherwise.
            if std::env::var("FUNLEAD_RECORDER_DEBUG_CAM").as_deref() == Ok("1") {
                let handle = _app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1200));
                    if let Err(e) = camera::open(&handle, None) {
                        eprintln!("debug-cam auto-open failed: {e}");
                    }
                    // Also bring up the control bar and log the windows scap sees, so a
                    // terminal run can confirm both high-level panels are listed (hence
                    // excludable from the capture by title).
                    if let Err(e) = controls::show(&handle) {
                        eprintln!("debug-cam controls open failed: {e}");
                    }
                    std::thread::sleep(std::time::Duration::from_millis(600));
                    recorder::log_capture_window_titles();
                    // Exercise the NSPanel safe-close path (the one that used to
                    // abort with window.close()). The process must survive this.
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    if let Err(e) = controls::hide(&handle) {
                        eprintln!("controls hide failed: {e}");
                    } else {
                        eprintln!("controls hide dispatched OK");
                    }
                });
            }

            Ok(())
        })
        .manage(RecorderState::default())
        .invoke_handler(tauri::generate_handler![
            list_displays,
            list_input_devices,
            check_permission,
            request_permission,
            ffmpeg_available,
            ensure_ffmpeg,
            start_recording,
            stop_recording,
            pause_recording,
            resume_recording,
            trim_recording,
            render::render_video,
            transcribe::transcribe_recording,
            project::save_project,
            project::save_transcript,
            project::open_project,
            project::list_projects,
            toggle_camera_window,
            is_camera_window_open,
            set_camera_device,
            show_controls_window,
            hide_controls_window,
            is_controls_window_open
        ])
        .run(tauri::generate_context!())
        .expect("error al arrancar FunLead Recorder");
}
