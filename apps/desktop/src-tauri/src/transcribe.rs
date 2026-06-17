//! Local, offline transcription with whisper.cpp. The recording's audio is
//! extracted to 16 kHz mono WAV with the **bundled** ffmpeg, then transcribed by
//! a **bundled** whisper.cpp binary against a local GGML model. Fully offline:
//! this module performs no network I/O of any kind (the binary/model are fetched
//! once by `scripts/fetch-whisper.sh`, never at runtime).
//!
//! Binary/model resolution mirrors `ffmpeg.rs`: prefer the resource bundled in
//! the .app, then a writable app-data copy, then well-known installs (Homebrew),
//! then the inherited PATH (works in `cargo`/dev runs).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

/// Caches the resolved whisper binary path for the process lifetime.
static RESOLVED_BIN: Mutex<Option<PathBuf>> = Mutex::new(None);

/// File name of the whisper CLI bundled as a resource, named per target triple
/// (matches `scripts/fetch-whisper.sh` and the `bin/*` resource glob).
fn bundled_binary_name() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "whisper-cli-aarch64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "whisper-cli-x86_64-apple-darwin"
    } else if cfg!(windows) {
        "whisper-cli-x86_64-pc-windows-msvc.exe"
    } else {
        "whisper-cli-x86_64-unknown-linux-gnu"
    }
}

/// Bare CLI names to try on PATH / well-known dirs. whisper.cpp renamed `main` to
/// `whisper-cli`; Homebrew installs the latter.
fn cli_aliases() -> &'static [&'static str] {
    if cfg!(windows) {
        &["whisper-cli.exe", "main.exe"]
    } else {
        &["whisper-cli", "main"]
    }
}

fn resource_bin_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().resource_dir().ok().map(|d| d.join("bin"))
}

fn is_runnable(path: &Path) -> bool {
    use std::process::{Command, Stdio};
    Command::new(path)
        .arg("--help")
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

fn well_known_binaries() -> Vec<PathBuf> {
    if cfg!(target_os = "macos") {
        vec![
            PathBuf::from("/opt/homebrew/bin/whisper-cli"),
            PathBuf::from("/usr/local/bin/whisper-cli"),
            PathBuf::from("/opt/homebrew/bin/main"),
        ]
    } else if cfg!(target_os = "windows") {
        vec![]
    } else {
        vec![
            PathBuf::from("/usr/bin/whisper-cli"),
            PathBuf::from("/usr/local/bin/whisper-cli"),
        ]
    }
}

/// Resolves a runnable whisper binary (cached). Returns a friendly error pointing
/// at the setup script when nothing usable is found — never downloads at runtime.
fn resolve_binary(app: &AppHandle, data_dir: &Path) -> Result<PathBuf, String> {
    if let Some(cached) = RESOLVED_BIN
        .lock()
        .map_err(|_| "Estado de whisper bloqueado.")?
        .clone()
    {
        return Ok(cached);
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = resource_bin_dir(app) {
        candidates.push(dir.join(bundled_binary_name()));
    }
    for name in cli_aliases() {
        candidates.push(data_dir.join(name));
    }
    candidates.extend(well_known_binaries());
    // Bare names resolved against the process PATH (dev runs).
    for name in cli_aliases() {
        candidates.push(PathBuf::from(name));
    }

    for cand in candidates {
        if cand.is_absolute() || cand.exists() {
            ensure_executable(&cand);
        }
        if is_runnable(&cand) {
            if let Ok(mut guard) = RESOLVED_BIN.lock() {
                *guard = Some(cand.clone());
            }
            return Ok(cand);
        }
    }

    Err("No se encontró whisper.cpp. Ejecuta scripts/fetch-whisper.sh (o brew install whisper-cpp).".into())
}

/// Resolves a GGML model file: the bundled one first, then app-data, then any
/// `ggml-*.bin` next to the resolved binary or in the app-data models dir.
fn resolve_model(app: &AppHandle, data_dir: &Path) -> Result<PathBuf, String> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(dir) = resource_bin_dir(app) {
        roots.push(dir.join("models"));
        roots.push(dir);
    }
    roots.push(data_dir.join("models"));
    roots.push(data_dir.to_path_buf());

    // Preferred default first, then any GGML weight we can find.
    for root in &roots {
        let preferred = root.join("ggml-base.bin");
        if preferred.is_file() {
            return Ok(preferred);
        }
    }
    for root in &roots {
        if let Ok(entries) = std::fs::read_dir(root) {
            for e in entries.flatten() {
                let p = e.path();
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if name.starts_with("ggml-") && name.ends_with(".bin") {
                    return Ok(p);
                }
            }
        }
    }
    Err("No se encontró un modelo de whisper (ggml-*.bin). Ejecuta scripts/fetch-whisper.sh.".into())
}

fn path_str(p: &Path) -> Result<String, String> {
    p.to_str().map(str::to_string).ok_or_else(|| "Ruta no es UTF-8 válido.".into())
}

/// Extracts the audio of `input` to a 16 kHz mono PCM WAV (whisper.cpp's required
/// format) using the bundled ffmpeg. Returns the WAV path.
fn extract_wav(app: &AppHandle, data_dir: &Path, input: &str, work: &Path) -> Result<PathBuf, String> {
    let wav = work.join("audio16k.wav");
    let wav_str = path_str(&wav)?;
    let mut child = crate::ffmpeg::command(app, data_dir)?
        .arg("-y")
        .args(["-i", input])
        .args(["-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"])
        .arg(&wav_str)
        .spawn()
        .map_err(|e| format!("No se pudo extraer el audio: {e}"))?;
    let status = child.wait().map_err(|e| format!("La extracción de audio no terminó: {e}"))?;
    if !status.success() {
        return Err("No se pudo extraer el audio del vídeo.".into());
    }
    if !wav.is_file() {
        return Err("El vídeo no tiene audio para transcribir.".into());
    }
    Ok(wav)
}

/// Parses whisper.cpp's stderr line for a progress percentage. whisper prints
/// `whisper_print_progress_callback: progress = NN%` with `--print-progress`.
fn parse_progress(line: &str) -> Option<f64> {
    let idx = line.find("progress =")?;
    let rest = line[idx + "progress =".len()..].trim_start();
    let num: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    let pct: f64 = num.parse().ok()?;
    if (0.0..=100.0).contains(&pct) {
        Some(pct)
    } else {
        None
    }
}

/// Cleans whisper's `-otxt` output into a single transcript string: trims each
/// line, drops blank lines, joins with spaces, and collapses runs of whitespace.
/// (whisper's plain-text output has no timestamps, but tolerate stray `[..]`
/// timestamp prefixes from older builds.)
fn clean_transcript(raw: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    for line in raw.lines() {
        let mut s = line.trim();
        // Strip a leading "[HH:MM:SS.mmm --> HH:MM:SS.mmm]" prefix if present.
        if s.starts_with('[') {
            if let Some(end) = s.find(']') {
                s = s[end + 1..].trim_start();
            }
        }
        if !s.is_empty() {
            parts.push(s.to_string());
        }
    }
    parts.join(" ").split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Runs whisper.cpp over `wav` and returns the cleaned transcript text. Emits
/// `transcribe-progress` (0..100). `language` is an ISO code (e.g. "es") or
/// `None` for whisper's auto-detection.
fn run_whisper(
    app: &AppHandle,
    bin: &Path,
    model: &Path,
    wav: &Path,
    language: Option<&str>,
    work: &Path,
) -> Result<String, String> {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};

    let out_prefix = work.join("transcript");
    let model_str = path_str(model)?;
    let wav_str = path_str(wav)?;
    let out_str = path_str(&out_prefix)?;

    let mut cmd = Command::new(bin);
    cmd.args(["-m", &model_str])
        .args(["-f", &wav_str])
        .arg("-otxt")
        .args(["-of", &out_str])
        .arg("--no-prints")
        .arg("--print-progress")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    cmd.args(["-l", language.unwrap_or("auto")]);

    let _ = app.emit("transcribe-progress", 0.0_f64);
    let mut child = cmd.spawn().map_err(|e| format!("No se pudo lanzar whisper: {e}"))?;

    if let Some(stderr) = child.stderr.take() {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            if let Some(pct) = parse_progress(&line) {
                let _ = app.emit("transcribe-progress", pct);
            }
        }
    }

    let status = child.wait().map_err(|e| format!("whisper no terminó: {e}"))?;
    if !status.success() {
        return Err("whisper salió con error al transcribir.".into());
    }

    let txt_path = out_prefix.with_extension("txt");
    let raw = std::fs::read_to_string(&txt_path)
        .map_err(|e| format!("No se pudo leer la transcripción: {e}"))?;
    let _ = app.emit("transcribe-progress", 100.0_f64);
    Ok(clean_transcript(&raw))
}

fn transcribe(app: &AppHandle, data_dir: &Path, raw_path: &str, language: Option<&str>) -> Result<String, String> {
    if !Path::new(raw_path).is_file() {
        return Err("El vídeo original no existe.".into());
    }
    let bin = resolve_binary(app, data_dir)?;
    let model = resolve_model(app, data_dir)?;

    let work = std::env::temp_dir().join(format!(
        "funlead-transcribe-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&work).map_err(|e| format!("No se pudo crear el espacio de trabajo: {e}"))?;

    let result = (|| -> Result<String, String> {
        let wav = extract_wav(app, data_dir, raw_path, &work)?;
        run_whisper(app, &bin, &model, &wav, language, &work)
    })();

    let _ = std::fs::remove_dir_all(&work);
    result
}

/// Transcribes `raw_path` locally with whisper.cpp and returns the text. `lang`
/// is an ISO code (e.g. "es") or `null`/empty for auto-detection. Emits
/// `transcribe-progress` (0..100). Runs the CPU-bound work on a blocking thread.
#[tauri::command]
pub async fn transcribe_recording(
    app: AppHandle,
    raw_path: String,
    lang: Option<String>,
) -> Result<String, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map(|d| d.join("whisper"))
        .map_err(|e| format!("No se pudo localizar la carpeta de datos: {e}"))?;
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let lang = lang.as_deref().filter(|s| !s.is_empty());
        transcribe(&app2, &data_dir, &raw_path, lang)
    })
    .await
    .map_err(|e| format!("La transcripción se interrumpió: {e}"))?
}

// ---------------------------------------------------------------------------
// Tests — pure parsing logic, no ffmpeg/whisper.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_is_parsed_from_whisper_stderr() {
        assert_eq!(
            parse_progress("whisper_print_progress_callback: progress =  42%"),
            Some(42.0)
        );
        assert_eq!(parse_progress("progress = 100%"), Some(100.0));
        assert_eq!(parse_progress("no progress here"), None);
        assert_eq!(parse_progress("progress = 999%"), None);
    }

    #[test]
    fn clean_transcript_joins_and_collapses() {
        let raw = "  Hola mundo.\n\nEsto es   una   prueba.\n";
        assert_eq!(clean_transcript(raw), "Hola mundo. Esto es una prueba.");
    }

    #[test]
    fn clean_transcript_strips_timestamp_prefixes() {
        let raw = "[00:00:00.000 --> 00:00:02.000]   Primera línea\n[00:00:02.000 --> 00:00:04.000]  Segunda";
        assert_eq!(clean_transcript(raw), "Primera línea Segunda");
    }

    #[test]
    fn clean_transcript_empty_is_empty() {
        assert_eq!(clean_transcript("\n  \n"), "");
    }
}
