//! Local project persistence (FR-106). A project is a small JSON file holding the
//! edit manifest plus the absolute path of the raw recording it edits. Files live
//! under `~/Movies/FunLead/projects/` — no dialog plugin, no cloud, no extra fs
//! capability (the renderer already owns that directory tree).
//!
//! The manifest is stored verbatim as opaque JSON: the schema's single source of
//! truth is the Zod schema in the editor and the re-validation inside the renderer;
//! this module only round-trips bytes, it never interprets the manifest.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// On-disk project document. `raw_path` points at the original recording in
/// `~/Movies/FunLead/`; `manifest` is the edit manifest as opaque JSON.
/// `transcript` is the locally-generated whisper.cpp text, ready to travel when
/// "upload to my server" is implemented; absent on older project files.
#[derive(Serialize, Deserialize)]
pub struct Project {
    pub raw_path: String,
    pub manifest: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript: Option<String>,
}

/// Summary row for the "open project" picker.
#[derive(Serialize)]
pub struct ProjectInfo {
    /// Stable name (file stem) used to open/save the project.
    pub name: String,
    pub raw_path: String,
}

fn projects_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or("No se pudo localizar el directorio de usuario.")?;
    let dir = home.join("Movies").join("FunLead").join("projects");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("No se pudo crear la carpeta de proyectos: {e}"))?;
    Ok(dir)
}

/// Rejects empty names and any separator/`..` so a name can never escape the
/// projects directory. Names are user-facing labels, not paths.
fn safe_file_for(dir: &Path, name: &str) -> Result<PathBuf, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("El nombre del proyecto no puede estar vacío.".into());
    }
    if trimmed.len() > 120
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
        || trimmed.starts_with('.')
    {
        return Err("Nombre de proyecto no válido.".into());
    }
    Ok(dir.join(format!("{trimmed}.funlead.json")))
}

fn write_project(file: &Path, project: &Project) -> Result<(), String> {
    let body = serde_json::to_vec_pretty(project)
        .map_err(|e| format!("No se pudo serializar el proyecto: {e}"))?;
    std::fs::write(file, body).map_err(|e| format!("No se pudo guardar el proyecto: {e}"))
}

/// Persists `project` under `name`, overwriting the manifest/raw_path while
/// preserving a previously-saved transcript (the editor's autosave doesn't carry
/// it, so a manifest save must not wipe the transcript).
#[tauri::command]
pub fn save_project(name: String, raw_path: String, manifest: Value) -> Result<(), String> {
    let dir = projects_dir()?;
    let file = safe_file_for(&dir, &name)?;
    let transcript = std::fs::read(&file)
        .ok()
        .and_then(|b| serde_json::from_slice::<Project>(&b).ok())
        .and_then(|p| p.transcript);
    write_project(&file, &Project { raw_path, manifest, transcript })
}

/// Stores the locally-generated transcript on the project, keeping its manifest.
/// Creates the project (with an empty manifest) if it doesn't exist yet — a
/// recording can be transcribed straight from the preview, before any edit.
#[tauri::command]
pub fn save_transcript(name: String, raw_path: String, transcript: String) -> Result<(), String> {
    let dir = projects_dir()?;
    let file = safe_file_for(&dir, &name)?;
    let manifest = std::fs::read(&file)
        .ok()
        .and_then(|b| serde_json::from_slice::<Project>(&b).ok())
        .map(|p| p.manifest)
        .unwrap_or(Value::Null);
    write_project(&file, &Project { raw_path, manifest, transcript: Some(transcript) })
}

/// Loads the project stored under `name`.
#[tauri::command]
pub fn open_project(name: String) -> Result<Project, String> {
    let dir = projects_dir()?;
    let file = safe_file_for(&dir, &name)?;
    let bytes = std::fs::read(&file).map_err(|e| format!("No se pudo abrir el proyecto: {e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("El proyecto está dañado: {e}"))
}

/// Lists saved projects (newest first), skipping any unreadable file.
#[tauri::command]
pub fn list_projects() -> Result<Vec<ProjectInfo>, String> {
    let dir = projects_dir()?;
    let mut rows: Vec<(std::time::SystemTime, ProjectInfo)> = Vec::new();
    let entries =
        std::fs::read_dir(&dir).map_err(|e| format!("No se pudieron listar los proyectos: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = strip_project_name(&path) else {
            continue;
        };
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let Ok(project) = serde_json::from_slice::<Project>(&bytes) else {
            continue;
        };
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        rows.push((
            modified,
            ProjectInfo {
                name,
                raw_path: project.raw_path,
            },
        ));
    }
    rows.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(rows.into_iter().map(|(_, info)| info).collect())
}

/// Returns the project name (file stem before `.funlead.json`) for a path that is
/// one of our project files, else `None`.
fn strip_project_name(path: &Path) -> Option<String> {
    let file = path.file_name()?.to_str()?;
    file.strip_suffix(".funlead.json").map(str::to_string)
}
