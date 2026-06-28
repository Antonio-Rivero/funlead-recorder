//! Robust, PATH-independent resolution of the ffmpeg binary.
//!
//! Order of preference:
//!   1. the ffmpeg **static** binary bundled inside the .app (resource dir),
//!   2. an ffmpeg previously downloaded into a writable app-data dir,
//!   3. well-known absolute install locations (Homebrew, etc.),
//!   4. `ffmpeg` on the inherited PATH (works in `cargo`/dev runs),
//!   5. a one-time download into app-data as a last resort.
//!
//! A `.app` launched from Finder inherits a minimal PATH without
//! `/opt/homebrew/bin`, so we never rely on PATH in production: the bundled
//! static binary (T1.9) is the primary path, resolved via `new_with_path`.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use ffmpeg_sidecar::command::FfmpegCommand;
use ffmpeg_sidecar::download::{
    download_ffmpeg_package, ffmpeg_download_url, unpack_ffmpeg_without_extras,
};
use tauri::{AppHandle, Manager};

/// Caches the resolved ffmpeg path so we don't probe the filesystem (or worse,
/// re-download) on every recording. `None` until first successful resolution.
static RESOLVED: Mutex<Option<PathBuf>> = Mutex::new(None);

fn binary_name() -> &'static str {
    if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    }
}

/// File name of the static ffmpeg bundled as a resource, named per target triple
/// (matches `scripts/fetch-ffmpeg.sh` and `bundle.resources` in tauri.conf.json).
fn bundled_binary_name() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "ffmpeg-aarch64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "ffmpeg-x86_64-apple-darwin"
    } else if cfg!(windows) {
        "ffmpeg-x86_64-pc-windows-msvc.exe"
    } else {
        "ffmpeg-x86_64-unknown-linux-gnu"
    }
}

/// Path to the ffmpeg static binary bundled inside the app's `bin/` resource dir.
fn bundled_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?;
    let candidate = dir.join("bin").join(bundled_binary_name());
    if candidate.exists() {
        Some(candidate)
    } else {
        None
    }
}

/// Absolute paths where a system ffmpeg commonly lives, checked before we ever
/// consider downloading. Covers the dev-machine case (Homebrew) and typical
/// manual installs without depending on the inherited PATH.
fn well_known_paths() -> Vec<PathBuf> {
    if cfg!(target_os = "macos") {
        vec![
            PathBuf::from("/opt/homebrew/bin/ffmpeg"),
            PathBuf::from("/usr/local/bin/ffmpeg"),
            PathBuf::from("/usr/bin/ffmpeg"),
        ]
    } else if cfg!(target_os = "windows") {
        vec![
            PathBuf::from(r"C:\ProgramData\chocolatey\bin\ffmpeg.exe"),
            PathBuf::from(r"C:\Program Files\ffmpeg\bin\ffmpeg.exe"),
        ]
    } else {
        vec![
            PathBuf::from("/usr/bin/ffmpeg"),
            PathBuf::from("/usr/local/bin/ffmpeg"),
        ]
    }
}

/// Verifies a candidate binary actually runs (`ffmpeg -version` exits 0). This
/// rejects stale/corrupt downloads and dangling well-known paths.
fn is_runnable(path: &Path) -> bool {
    use std::process::{Command, Stdio};
    Command::new(path)
        .arg("-version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(unix)]
fn ensure_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(path) {
        let mut perms = meta.permissions();
        perms.set_mode(perms.mode() | 0o755);
        let _ = std::fs::set_permissions(path, perms);
    }
}

#[cfg(not(unix))]
fn ensure_executable(_path: &Path) {}

/// Resolution order (see module docs), returning the first runnable absolute
/// path. Returns `Ok(None)` when nothing usable is found yet (caller may download).
fn try_resolve(app: &AppHandle, data_dir: &Path) -> Result<Option<PathBuf>, String> {
    if let Some(cached) = RESOLVED
        .lock()
        .map_err(|_| "Estado de ffmpeg bloqueado.")?
        .clone()
    {
        return Ok(Some(cached));
    }

    // 1. ffmpeg static bundled inside the .app (preferred — no PATH, no @loader_path).
    if let Some(bundled) = bundled_path(app) {
        ensure_executable(&bundled);
        if is_runnable(&bundled) {
            return Ok(Some(bundled));
        }
    }

    // 2. previously downloaded into app-data.
    let downloaded = data_dir.join(binary_name());
    if downloaded.exists() && is_runnable(&downloaded) {
        return Ok(Some(downloaded));
    }

    // 3. well-known absolute install locations.
    for candidate in well_known_paths() {
        if candidate.exists() && is_runnable(&candidate) {
            return Ok(Some(candidate));
        }
    }

    // 4. PATH lookup (bare name); spawning resolves it against the process PATH.
    let bare = PathBuf::from(binary_name());
    if is_runnable(&bare) {
        return Ok(Some(bare));
    }

    Ok(None)
}

fn cache(path: PathBuf) -> PathBuf {
    if let Ok(mut guard) = RESOLVED.lock() {
        *guard = Some(path.clone());
    }
    path
}

/// Downloads ffmpeg into `data_dir` (writable app-data) and returns its path.
/// Uses the platform-correct release URL baked into ffmpeg-sidecar and unpacks
/// only the `ffmpeg` binary (skips ffplay/ffprobe to keep it small). This is the
/// last-resort fallback; production builds ship the static binary as a resource.
fn download_into(data_dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(data_dir)
        .map_err(|e| format!("No se pudo crear la carpeta de datos: {e}"))?;

    let url = ffmpeg_download_url()
        .map_err(|e| format!("Plataforma no soportada para descargar ffmpeg: {e}"))?;
    let archive = download_ffmpeg_package(url, data_dir)
        .map_err(|e| format!("No se pudo descargar ffmpeg (¿sin conexión?): {e}"))?;
    unpack_ffmpeg_without_extras(&archive, data_dir)
        .map_err(|e| format!("No se pudo descomprimir ffmpeg: {e}"))?;

    let binary = data_dir.join(binary_name());
    ensure_executable(&binary);
    if !is_runnable(&binary) {
        return Err("ffmpeg se descargó pero no se pudo ejecutar.".into());
    }
    Ok(binary)
}

/// Returns whether a usable ffmpeg is already present without downloading.
/// Lets the UI decide whether to show a "descargando ffmpeg…" notice.
pub fn is_available(app: &AppHandle, data_dir: &Path) -> bool {
    try_resolve(app, data_dir).ok().flatten().is_some()
}

/// Resolves an absolute, runnable ffmpeg path, downloading it once into
/// `data_dir` if needed. The result is cached for the process lifetime.
pub fn ensure(app: &AppHandle, data_dir: &Path) -> Result<PathBuf, String> {
    if let Some(found) = try_resolve(app, data_dir)? {
        return Ok(cache(found));
    }
    let downloaded = download_into(data_dir)?;
    Ok(cache(downloaded))
}

/// Builds an `FfmpegCommand` bound to the explicitly resolved binary, never
/// relying on PATH. `data_dir` must point to a writable app-data directory.
pub fn command(app: &AppHandle, data_dir: &Path) -> Result<FfmpegCommand, String> {
    let path = ensure(app, data_dir)?;
    Ok(FfmpegCommand::new_with_path(&path))
}


/// Caches whether the resolved ffmpeg exposes Apple's hardware H.264 encoder
/// (`h264_videotoolbox`). Probed once; `None` until the first check.
static VIDEOTOOLBOX: Mutex<Option<bool>> = Mutex::new(None);

/// Whether the resolved ffmpeg can encode with `h264_videotoolbox` (the Apple
/// Media Engine). Probed once via `ffmpeg -encoders` and cached for the process.
/// On any failure it reports `false`, so the recorder falls back to libx264.
pub fn supports_videotoolbox(app: &AppHandle, data_dir: &Path) -> bool {
    if let Ok(guard) = VIDEOTOOLBOX.lock() {
        if let Some(cached) = *guard {
            return cached;
        }
    }
    let detected = probe_videotoolbox(app, data_dir);
    if let Ok(mut guard) = VIDEOTOOLBOX.lock() {
        *guard = Some(detected);
    }
    detected
}

fn probe_videotoolbox(app: &AppHandle, data_dir: &Path) -> bool {
    use std::process::{Command, Stdio};
    let Ok(path) = ensure(app, data_dir) else {
        return false;
    };
    Command::new(&path)
        .args(["-hide_banner", "-encoders"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("h264_videotoolbox"))
        .unwrap_or(false)
}
