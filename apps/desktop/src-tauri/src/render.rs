//! Local render of the post-recording editor (clean-room port of the worker's
//! `render.py`). Takes the raw recording + an edit manifest and produces the
//! polished MP4 with the **bundled** ffmpeg — fully offline, no network.
//!
//! Two time domains (same as the reference):
//!   t_src = seconds of the original clip (trims, speed, and the zoom/text the
//!           user marked on the raw footage in the editor)
//!   t_out = seconds of the final timeline (after cutting/speeding)
//! PASS 1 cuts/speeds in t_src → an intermediate clip. Zoom/text are mapped from
//! t_src to t_out with the segment table and applied in PASS 2.
//!
//! Defense in depth: the manifest is already Zod-validated in the UI, but the
//! renderer re-validates every number/range/hex here and feeds drawtext text via
//! a textfile (never the command line) so nothing unsanitized reaches ffmpeg.
//!
//! Privacy: `background.image` accepts ONLY a local file path. A remote URL is
//! rejected — this module performs no downloads of any kind.

use std::path::{Path, PathBuf};

use ffmpeg_sidecar::event::{FfmpegEvent, StreamTypeSpecificData};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

const HEX_LEN: usize = 8; // "0xRRGGBB"

/// Probed facts about the input clip.
struct Probe {
    width: u32,
    height: u32,
    has_audio: bool,
    duration: f64,
}

/// A kept tramo in t_src with its unique speed factor.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Segment {
    a: f64,
    b: f64,
    factor: f64,
}

/// Row of the t_src → t_out mapping table.
#[derive(Clone, Copy, Debug)]
struct MapRow {
    a: f64,
    b: f64,
    factor: f64,
    out_a: f64,
}

// ---------------------------------------------------------------------------
// Validation helpers (mirror render.py: _hex / _int / _float)
// ---------------------------------------------------------------------------

fn is_hex(v: &str) -> bool {
    v.len() == HEX_LEN
        && v.starts_with("0x")
        && v[2..].chars().all(|c| c.is_ascii_hexdigit())
}

fn req_hex(v: Option<&Value>, name: &str) -> Result<String, String> {
    let s = v.and_then(Value::as_str).unwrap_or("");
    if is_hex(s) {
        Ok(s.to_string())
    } else {
        Err(format!("{name}: color hex inválido"))
    }
}

/// A finite f64, or error. Rejects NaN/Inf and booleans-as-numbers (serde keeps
/// bools out of `as_f64`, so a `bool` value naturally fails the number check).
fn as_num(v: Option<&Value>, name: &str) -> Result<f64, String> {
    match v {
        Some(Value::Number(n)) => n
            .as_f64()
            .filter(|x| x.is_finite())
            .ok_or_else(|| format!("{name}: número inválido")),
        _ => Err(format!("{name}: debe ser número")),
    }
}

fn req_float(v: Option<&Value>, lo: f64, hi: f64, name: &str) -> Result<f64, String> {
    let x = as_num(v, name)?;
    if x < lo || x > hi {
        return Err(format!("{name}: fuera de rango [{lo},{hi}]"));
    }
    Ok(x)
}

fn req_int(v: Option<&Value>, lo: i64, hi: i64, name: &str) -> Result<i64, String> {
    let x = as_num(v, name)?;
    let iv = x as i64;
    if iv < lo || iv > hi {
        return Err(format!("{name}: fuera de rango [{lo},{hi}]"));
    }
    Ok(iv)
}

fn opt_int(v: &Value, key: &str, default: i64, lo: i64, hi: i64, name: &str) -> Result<i64, String> {
    match v.get(key) {
        None | Some(Value::Null) => Ok(default),
        other => req_int(other, lo, hi, name),
    }
}

fn opt_float(v: &Value, key: &str, default: f64, lo: f64, hi: f64, name: &str) -> Result<f64, String> {
    match v.get(key) {
        None | Some(Value::Null) => Ok(default),
        other => req_float(other, lo, hi, name),
    }
}

fn arr<'a>(m: &'a Value, key: &str) -> &'a [Value] {
    m.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

// ---------------------------------------------------------------------------
// PASS 1 — temporal cut (trims + speed) — pure logic, unit-tested.
// ---------------------------------------------------------------------------

fn merge_intervals(mut ivs: Vec<(f64, f64)>) -> Vec<(f64, f64)> {
    ivs.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut out: Vec<(f64, f64)> = Vec::new();
    for (a, b) in ivs {
        if let Some(last) = out.last_mut() {
            if a <= last.1 {
                last.1 = last.1.max(b);
                continue;
            }
        }
        out.push((a, b));
    }
    out
}

/// Trims/speeds in t_src: (t0, t1) for trims; (t0, t1, factor) for speeds.
/// Returns the tramos to KEEP, subdivided by speed-region boundaries, each with
/// a single factor (1.0 by default). Faithful to render.py:compute_segments.
fn compute_segments(
    trims: &[(f64, f64)],
    speeds: &[(f64, f64, f64)],
    duration: f64,
) -> Vec<Segment> {
    let cut = merge_intervals(
        trims
            .iter()
            .filter(|(t0, t1)| t1 > t0)
            .map(|(t0, t1)| (t0.max(0.0), t1.min(duration)))
            .collect(),
    );

    let mut keeps: Vec<(f64, f64)> = Vec::new();
    let mut cursor = 0.0_f64;
    for (a, b) in cut {
        if a > cursor {
            keeps.push((cursor, a));
        }
        cursor = cursor.max(b);
    }
    if cursor < duration {
        keeps.push((cursor, duration));
    }
    if keeps.is_empty() {
        keeps.push((0.0, duration));
    }

    let factor_at = |t: f64| -> f64 {
        for (s0, s1, f) in speeds {
            if *s0 <= t && t < *s1 {
                return *f;
            }
        }
        1.0
    };

    let mut segments: Vec<Segment> = Vec::new();
    for (ka, kb) in keeps {
        let mut bounds: Vec<f64> = vec![ka, kb];
        for (s0, s1, _) in speeds {
            for x in [*s0, *s1] {
                if ka < x && x < kb {
                    bounds.push(x);
                }
            }
        }
        bounds.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        bounds.dedup_by(|a, b| (*a - *b).abs() < f64::EPSILON);
        for w in bounds.windows(2) {
            let (a, b) = (w[0], w[1]);
            if b - a < 0.02 {
                continue;
            }
            let mid = (a + b) / 2.0;
            segments.push(Segment { a, b, factor: factor_at(mid) });
        }
    }
    segments
}

/// Builds the t_src → t_out mapping table and the total output duration.
/// Faithful to render.py:build_src_to_out.
fn build_src_to_out(segments: &[Segment]) -> (Vec<MapRow>, f64) {
    let mut table: Vec<MapRow> = Vec::with_capacity(segments.len());
    let mut out_cursor = 0.0_f64;
    for s in segments {
        table.push(MapRow { a: s.a, b: s.b, factor: s.factor, out_a: out_cursor });
        out_cursor += (s.b - s.a) / s.factor;
    }
    (table, out_cursor)
}

/// Maps a t_src instant to t_out. Points falling inside a trim clamp to the
/// nearest kept edge (render.py:map_t).
fn map_t(table: &[MapRow], total_out: f64, t_src: f64) -> f64 {
    for r in table {
        if r.a <= t_src && t_src <= r.b {
            return r.out_a + (t_src - r.a) / r.factor;
        }
    }
    if let Some(first) = table.first() {
        if t_src < first.a {
            return 0.0;
        }
    }
    total_out
}

/// atempo accepts 0.5..2.0 only → chain for factors outside that range.
fn atempo_chain(factor: f64) -> Vec<String> {
    if (factor - 1.0).abs() < 1e-3 {
        return Vec::new();
    }
    let mut chain = Vec::new();
    let mut f = factor;
    while f > 2.0 + 1e-9 {
        chain.push("atempo=2.0".to_string());
        f /= 2.0;
    }
    while f < 0.5 - 1e-9 {
        chain.push("atempo=0.5".to_string());
        f /= 0.5;
    }
    chain.push(format!("atempo={f:.4}"));
    chain
}

// ---------------------------------------------------------------------------
// PASS 2 — visual composition expression builders (zoom smoothstep + alpha)
// ---------------------------------------------------------------------------

fn smoothstep_in(t0: f64, ramp: f64) -> String {
    let p = format!("clip((t-{t0:.3})/{ramp:.3},0,1)");
    format!("({p}*{p}*(3-2*{p}))")
}

fn smoothstep_out(t1: f64, ramp: f64) -> String {
    let p = format!("clip((t-{:.3})/{ramp:.3},0,1)", t1 - ramp);
    format!("({p}*{p}*(3-2*{p}))")
}

/// One zoom region after t_out mapping + re-validation.
struct Zoom {
    t0: f64,
    t1: f64,
    level: f64,
    cx: f64,
    cy: f64,
    ramp: f64,
}

/// Builds (scale_w, scale_h, crop_x, crop_y) exprs for animated zoom over the
/// native (w0×h0) frame. Z(t) = 1 + Σ (level-1)·e(t); active focus per region.
fn zoom_exprs(zooms: &[Zoom], w0: u32, h0: u32) -> Option<(String, String, String, String)> {
    if zooms.is_empty() {
        return None;
    }
    let mut z_terms = Vec::new();
    let mut cx_terms = Vec::new();
    let mut cy_terms = Vec::new();
    let mut active = Vec::new();
    for z in zooms {
        let ramp = z.ramp.min((z.t1 - z.t0) / 2.0);
        let e = format!("({}-{})", smoothstep_in(z.t0, ramp), smoothstep_out(z.t1, ramp));
        z_terms.push(format!("({:.4}*{e})", z.level - 1.0));
        let ind = format!("between(t,{:.3},{:.3})", z.t0, z.t1);
        cx_terms.push(format!("{:.4}*{ind}", z.cx));
        cy_terms.push(format!("{:.4}*{ind}", z.cy));
        active.push(format!("between(t,{:.3},{:.3})", z.t0, z.t1));
    }
    let zexpr = format!("(1+{})", z_terms.join("+"));
    let any_active = active.join("+");
    let cx = format!("(if(gt({any_active},0),({}),0.5))", cx_terms.join("+"));
    let cy = format!("(if(gt({any_active},0),({}),0.5))", cy_terms.join("+"));
    let sw = format!("ceil({w0}*{zexpr}/2)*2");
    let sh = format!("ceil({h0}*{zexpr}/2)*2");
    let crop_x = format!("(in_w-{w0})*{cx}");
    let crop_y = format!("(in_h-{h0})*{cy}");
    Some((sw, sh, crop_x, crop_y))
}

// ---------------------------------------------------------------------------
// ffmpeg execution helpers (bundled binary only)
// ---------------------------------------------------------------------------

fn even_fit(sw: u32, sh: u32, bw: u32, bh: u32) -> (u32, u32) {
    let scale = (bw as f64 / sw as f64).min(bh as f64 / sh as f64);
    let w = ((sw as f64 * scale).round() as u32 / 2 * 2).max(2);
    let h = ((sh as f64 * scale).round() as u32 / 2 * 2).max(2);
    (w, h)
}

fn path_str(p: &Path) -> Result<String, String> {
    p.to_str().map(str::to_string).ok_or_else(|| "Ruta no es UTF-8 válido.".into())
}

/// Probes the input by running the bundled `ffmpeg -i <input>` and reading the
/// parsed input-stream + duration events from its stderr (no `ffprobe` binary is
/// bundled). ffmpeg exits non-zero because no output is given; we ignore that and
/// rely on the parsed metadata.
fn probe(app: &AppHandle, data_dir: &Path, input: &str) -> Result<Probe, String> {
    let mut child = crate::ffmpeg::command(app, data_dir)?
        .arg("-i")
        .arg(input)
        .spawn()
        .map_err(|e| format!("No se pudo analizar el vídeo: {e}"))?;
    let mut width = 0u32;
    let mut height = 0u32;
    let mut has_audio = false;
    let mut duration = 0.0f64;
    let events = child.iter().map_err(|e| format!("No se pudo leer el análisis del vídeo: {e}"))?;
    for ev in events {
        match ev {
            FfmpegEvent::ParsedInputStream(s) => {
                if let StreamTypeSpecificData::Video(v) = &s.type_specific_data {
                    if width == 0 {
                        width = v.width;
                        height = v.height;
                    }
                } else if let StreamTypeSpecificData::Audio(_) = &s.type_specific_data {
                    has_audio = true;
                }
            }
            FfmpegEvent::ParsedDuration(d) if duration == 0.0 => {
                duration = d.duration;
            }
            _ => {}
        }
    }
    let _ = child.wait();
    if width == 0 || height == 0 {
        return Err("El vídeo no tiene una pista de vídeo legible.".into());
    }
    if duration <= 0.0 {
        return Err("No se pudo determinar la duración del vídeo.".into());
    }
    Ok(Probe { width, height, has_audio, duration })
}

/// Runs a one-shot ffmpeg command (built externally) to completion, failing on a
/// non-zero exit. Captures stderr tail for diagnostics.
fn run_to_completion(mut child: ffmpeg_sidecar::child::FfmpegChild, what: &str) -> Result<(), String> {
    let status = child.wait().map_err(|e| format!("{what}: ffmpeg no terminó ({e})"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{what}: ffmpeg salió con error."))
    }
}

/// "HH:MM:SS.xx" → seconds. Returns None on malformed input.
fn parse_time(s: &str) -> Option<f64> {
    let mut total = 0.0f64;
    for part in s.split(':') {
        total = total * 60.0 + part.parse::<f64>().ok()?;
    }
    Some(total)
}

// ---------------------------------------------------------------------------
// PASS 1 — produce the cut/sped intermediate clip.
// ---------------------------------------------------------------------------

fn pass1_cut(
    app: &AppHandle,
    data_dir: &Path,
    input: &str,
    segments: &[Segment],
    has_audio: bool,
    work: &Path,
) -> Result<PathBuf, String> {
    let out = work.join("edit_limpio.mp4");
    let out_str = path_str(&out)?;
    let mut parts: Vec<String> = Vec::new();
    let mut labels: Vec<String> = Vec::new();
    for (i, s) in segments.iter().enumerate() {
        parts.push(format!(
            "[0:v]trim={:.3}:{:.3},setpts=(PTS-STARTPTS)/{:.4}[v{i}]",
            s.a, s.b, s.factor
        ));
        if has_audio {
            let mut ap = format!("[0:a]atrim={:.3}:{:.3},asetpts=PTS-STARTPTS", s.a, s.b);
            let chain = atempo_chain(s.factor);
            if !chain.is_empty() {
                ap.push(',');
                ap.push_str(&chain.join(","));
            }
            parts.push(format!("{ap}[a{i}]"));
            labels.push(format!("[v{i}][a{i}]"));
        } else {
            labels.push(format!("[v{i}]"));
        }
    }
    let n = segments.len();
    let mut maps: Vec<String> = Vec::new();
    if has_audio {
        parts.push(format!("{}concat=n={n}:v=1:a=1[v][a]", labels.concat()));
        maps.extend(["-map", "[v]", "-map", "[a]", "-c:a", "aac", "-b:a", "160k"].map(String::from));
    } else {
        parts.push(format!("{}concat=n={n}:v=1:a=0[v]", labels.concat()));
        maps.extend(["-map", "[v]"].map(String::from));
    }
    let fc = parts.join(";");

    let mut cmd = crate::ffmpeg::command(app, data_dir)?;
    cmd.arg("-y").args(["-i", input]).args(["-filter_complex", &fc]);
    for m in &maps {
        cmd.arg(m);
    }
    cmd.args(["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"])
        .arg(&out_str);
    let child = cmd.spawn().map_err(|e| format!("No se pudo lanzar ffmpeg (pasada 1): {e}"))?;
    run_to_completion(child, "Corte temporal (pasada 1)")?;
    Ok(out)
}

// ---------------------------------------------------------------------------
// PASS 2 — build the intermediate PNG assets (mask / shadow / background).
// ---------------------------------------------------------------------------

fn make_round_mask(app: &AppHandle, data_dir: &Path, vw: u32, vh: u32, radius: i64, work: &Path) -> Result<PathBuf, String> {
    let mask = work.join("mask.png");
    let mask_str = path_str(&mask)?;
    let r = radius.min((vw / 2) as i64).min((vh / 2) as i64);
    let expr = if r <= 0 {
        "255".to_string()
    } else {
        let dx = format!("max(0,{r}-X)+max(0,X-(W-1-{r}))");
        let dy = format!("max(0,{r}-Y)+max(0,Y-(H-1-{r}))");
        format!("clip(255-(hypot({dx},{dy})-{r})*255,0,255)")
    };
    let child = crate::ffmpeg::command(app, data_dir)?
        .arg("-y")
        .args(["-f", "lavfi"])
        .args(["-i", &format!("color=c=white:s={vw}x{vh}")])
        .args(["-vf", &format!("format=rgba,geq=r=255:g=255:b=255:a='{expr}'")])
        .args(["-frames:v", "1"])
        .arg(&mask_str)
        .spawn()
        .map_err(|e| format!("No se pudo generar la máscara: {e}"))?;
    run_to_completion(child, "Máscara de bordes")?;
    Ok(mask)
}

#[allow(clippy::too_many_arguments)]
fn make_shadow_png(
    app: &AppHandle,
    data_dir: &Path,
    mask: &Path,
    vw: u32,
    vh: u32,
    opacity: f64,
    blur: i64,
    work: &Path,
) -> Result<(PathBuf, i64), String> {
    let pad = blur * 2;
    let sigma = (blur as f64 / 2.0).max(0.1);
    let out = work.join("shadow.png");
    let mask_str = path_str(mask)?;
    let out_str = path_str(&out)?;
    let vf = format!(
        "format=rgba,colorchannelmixer=rr=0:gg=0:bb=0:aa={opacity:.3},pad={}:{}:{pad}:{pad}:color=0x00000000,gblur=sigma={sigma:.2}",
        vw as i64 + 2 * pad,
        vh as i64 + 2 * pad
    );
    let child = crate::ffmpeg::command(app, data_dir)?
        .arg("-y")
        .args(["-i", &mask_str])
        .args(["-vf", &vf])
        .args(["-frames:v", "1"])
        .arg(&out_str)
        .spawn()
        .map_err(|e| format!("No se pudo generar la sombra: {e}"))?;
    run_to_completion(child, "Sombra")?;
    Ok((out, pad))
}

/// Renders the background PNG. `background.image` accepts ONLY a local file path:
/// a remote URL (http/https) is rejected — this module never downloads anything.
fn make_background_png(app: &AppHandle, data_dir: &Path, bg: &Value, cw: u32, ch: u32, work: &Path) -> Result<PathBuf, String> {
    let out = work.join("bg.png");
    let out_str = path_str(&out)?;
    let btype = bg.get("type").and_then(Value::as_str).unwrap_or("");
    match btype {
        "color" => {
            let color = req_hex(bg.get("color"), "background.color")?;
            let child = crate::ffmpeg::command(app, data_dir)?
                .arg("-y")
                .args(["-f", "lavfi"])
                .args(["-i", &format!("color=c={color}:s={cw}x{ch}")])
                .args(["-frames:v", "1"])
                .arg(&out_str)
                .spawn()
                .map_err(|e| format!("No se pudo generar el fondo: {e}"))?;
            run_to_completion(child, "Fondo (color)")?;
        }
        "gradient" => {
            let g = bg.get("gradient").ok_or("background.gradient: requerido")?;
            let c0 = req_hex(g.get("c0"), "gradient.c0")?;
            let c1 = req_hex(g.get("c1"), "gradient.c1")?;
            req_int(g.get("angle"), 0, 360, "gradient.angle")?;
            let child = crate::ffmpeg::command(app, data_dir)?
                .arg("-y")
                .args(["-f", "lavfi"])
                .args(["-i", &format!("gradients=s={cw}x{ch}:c0={c0}:c1={c1}:nb_colors=2:d=1")])
                .args(["-frames:v", "1"])
                .arg(&out_str)
                .spawn()
                .map_err(|e| format!("No se pudo generar el fondo: {e}"))?;
            run_to_completion(child, "Fondo (gradiente)")?;
        }
        "image" => {
            let img = bg.get("image").and_then(Value::as_str).unwrap_or("");
            let lower = img.to_ascii_lowercase();
            if lower.starts_with("http://") || lower.starts_with("https://") {
                return Err("background.image debe ser un archivo local (no se descargan URLs).".into());
            }
            if img.is_empty() {
                return Err("background.image: requerido".into());
            }
            if !Path::new(img).is_file() {
                return Err("background.image: el archivo local no existe.".into());
            }
            let child = crate::ffmpeg::command(app, data_dir)?
                .arg("-y")
                .args(["-i", img])
                .args(["-vf", &format!(
                    "scale={cw}:{ch}:force_original_aspect_ratio=increase,crop={cw}:{ch}"
                )])
                .args(["-frames:v", "1"])
                .arg(&out_str)
                .spawn()
                .map_err(|e| format!("No se pudo procesar la imagen de fondo: {e}"))?;
            run_to_completion(child, "Fondo (imagen)")?;
        }
        _ => return Err("background.type inválido".into()),
    }
    Ok(out)
}

/// Writes each text region's content to its own textfile (anti-injection: the
/// arbitrary user string never touches the command line). Returns their paths.
fn write_text_files(texts: &[Value], work: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::with_capacity(texts.len());
    for (i, t) in texts.iter().enumerate() {
        let content = t.get("content").and_then(Value::as_str).unwrap_or("");
        let fp = work.join(format!("text_{i}.txt"));
        std::fs::write(&fp, content).map_err(|e| format!("No se pudo escribir el texto: {e}"))?;
        files.push(fp);
    }
    Ok(files)
}

/// ffmpeg drawtext needs `:` `\` `'` escaped inside option values that we DO put
/// on the command line (font path, textfile path). Text content goes via
/// textfile and is never escaped here.
fn esc_opt(s: &str) -> String {
    s.replace('\\', "\\\\").replace(':', "\\:").replace('\'', "\\'")
}

// ---------------------------------------------------------------------------
// PASS 2 — compose.
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn pass2_compose(
    app: &AppHandle,
    data_dir: &Path,
    video: &Path,
    manifest: &Value,
    zooms: &[Zoom],
    texts: &[Value],
    font: &str,
    out: &Path,
    work: &Path,
) -> Result<(), String> {
    let canvas = manifest.get("canvas").cloned().unwrap_or(Value::Null);
    let cw = req_int(canvas.get("w"), 320, 3840, "canvas.w")? as u32;
    let ch = req_int(canvas.get("h"), 320, 2160, "canvas.h")? as u32;
    let frame = manifest.get("frame").cloned().unwrap_or(Value::Null);
    let padding = opt_int(&frame, "padding", 80, 0, 400, "frame.padding")? as u32;
    let radius = opt_int(&frame, "radius", 0, 0, 200, "frame.radius")?;
    let shadow = frame.get("shadow").cloned();

    let video_str = path_str(video)?;
    let probe = probe(app, data_dir, &video_str)?;
    let (sw0, sh0) = (probe.width, probe.height);

    let inner_w = cw.saturating_sub(2 * padding).max(2);
    let inner_h = ch.saturating_sub(2 * padding).max(2);
    let (vw, vh) = even_fit(sw0, sh0, inner_w, inner_h);
    let px = (cw - vw) / 2;
    let py = (ch - vh) / 2;

    let mask = make_round_mask(app, data_dir, vw, vh, radius, work)?;
    let bg = make_background_png(app, data_dir, &manifest.get("background").cloned().unwrap_or(Value::Null), cw, ch, work)?;

    let use_shadow = match &shadow {
        Some(s) => req_float(s.get("opacity"), 0.0, 1.0, "shadow.opacity").unwrap_or(0.0) > 0.0,
        None => false,
    };
    let mut shadow_asset: Option<(PathBuf, i64)> = None;
    if use_shadow {
        let s = shadow.as_ref().unwrap();
        let op = req_float(s.get("opacity"), 0.0, 1.0, "shadow.opacity")?;
        let blur = opt_int(s, "blur", 0, 0, 100, "shadow.blur")?;
        shadow_asset = Some(make_shadow_png(app, data_dir, &mask, vw, vh, op, blur, work)?);
    }

    let mask_str = path_str(&mask)?;
    let bg_str = path_str(&bg)?;

    // Inputs: 0=video, 1=mask (looped still), 2=bg (looped still), [3=shadow].
    let mut cmd = crate::ffmpeg::command(app, data_dir)?;
    cmd.arg("-y")
        .args(["-i", &video_str])
        .args(["-loop", "1", "-i", &mask_str])
        .args(["-loop", "1", "-i", &bg_str]);
    if let Some((ref sp, _)) = shadow_asset {
        let sp_str = path_str(sp)?;
        cmd.args(["-loop", "1", "-i", &sp_str]);
    }

    let mut parts: Vec<String> = Vec::new();
    let mut vsrc = "0:v".to_string();
    if let Some((sw, sh, cx, cy)) = zoom_exprs(zooms, sw0, sh0) {
        parts.push(format!(
            "[{vsrc}]scale=w='{sw}':h='{sh}':eval=frame,crop={sw0}:{sh0}:'{cx}':'{cy}'[vz]"
        ));
        vsrc = "vz".to_string();
    }
    parts.push(format!(
        "[{vsrc}]scale={vw}:{vh}:force_original_aspect_ratio=decrease,pad={vw}:{vh}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,setsar=1,format=rgba[vsc]"
    ));
    parts.push("[vsc][1:v]alphamerge[vr]".to_string());
    parts.push("[2:v]setsar=1[bg]".to_string());
    let mut last = "bg".to_string();
    if let Some((_, pad)) = shadow_asset {
        let s = shadow.as_ref().unwrap();
        let dx = opt_int(s, "dx", 0, -100, 100, "shadow.dx")?;
        let dy = opt_int(s, "dy", 0, 0, 100, "shadow.dy")?;
        parts.push(format!(
            "[bg][3:v]overlay=x={}:y={}[bgsh]",
            px as i64 + dx - pad,
            py as i64 + dy - pad
        ));
        last = "bgsh".to_string();
    }
    parts.push(format!("[{last}][vr]overlay=x={px}:y={py}:shortest=1:format=auto[comp]"));

    // Text (drawtext via textfile; alpha fade), already mapped to t_out.
    let text_files = write_text_files(texts, work)?;
    let mut cur = "comp".to_string();
    for (i, t) in texts.iter().enumerate() {
        let t0 = req_float(t.get("t0"), 0.0, f64::MAX, "text.t0")?;
        let t1 = req_float(t.get("t1"), 0.0, f64::MAX, "text.t1")?;
        if t1 <= t0 {
            continue;
        }
        let fade = opt_float(t, "fade", 0.3, 0.0, 1.0, "text.fade")?.min((t1 - t0) / 2.0).max(0.01);
        let size = opt_int(t, "size", 48, 12, 128, "text.size")?;
        let color = match t.get("color") {
            Some(Value::String(s)) if s == "white" => "white".to_string(),
            other => req_hex(other, "text.color")?,
        };
        let xexpr = match t.get("x") {
            Some(Value::String(s)) if s == "center" => "(w-text_w)/2".to_string(),
            other => format!("(w-text_w)*{:.4}", req_float(other, 0.0, 1.0, "text.x")?),
        };
        let y = opt_float(t, "y", 0.85, 0.0, 1.0, "text.y")?;
        let yexpr = format!("(h-text_h)*{y:.4}");
        let alpha = format!(
            "if(lt(t,{t0:.3}),0,if(lt(t,{:.3}),(t-{t0:.3})/{fade:.3},if(lt(t,{:.3}),1,if(lt(t,{t1:.3}),({t1:.3}-t)/{fade:.3},0))))",
            t0 + fade,
            t1 - fade
        );
        let mut boxpart = String::new();
        if let Some(Value::String(b)) = t.get("box") {
            if let Some((c, a)) = parse_box(b) {
                boxpart = format!(":box=1:boxcolor={c}@{a}:boxborderw=20");
            }
        }
        let tf = path_str(&text_files[i])?;
        parts.push(format!(
            "[{cur}]drawtext=fontfile={}:textfile={}:x={xexpr}:y={yexpr}:fontsize={size}:fontcolor={color}:alpha='{alpha}':enable='between(t,{t0:.3},{t1:.3})'{boxpart}[txt{i}]",
            esc_opt(font),
            esc_opt(&tf)
        ));
        cur = format!("txt{i}");
    }
    parts.push(format!("[{cur}]format=yuv420p[outv]"));

    let fc = parts.join(";");
    cmd.args(["-filter_complex", &fc]).args(["-map", "[outv]"]);
    if probe.has_audio {
        cmd.args(["-map", "0:a", "-c:a", "aac", "-b:a", "160k"]);
    }
    let out_str = path_str(out)?;
    cmd.args(["-t", &format!("{:.3}", probe.duration)])
        .args(["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"])
        .args(["-movflags", "+faststart"])
        .arg(&out_str);

    // Stream progress to the UI instead of polling: parse Progress events and
    // emit a 0..100 percentage against the known output duration.
    let mut child = cmd.spawn().map_err(|e| format!("No se pudo lanzar ffmpeg (pasada 2): {e}"))?;
    let events = child.iter().map_err(|e| format!("No se pudo leer el progreso: {e}"))?;
    let total = probe.duration.max(0.001);
    for ev in events {
        if let FfmpegEvent::Progress(p) = ev {
            if let Some(secs) = parse_time(&p.time) {
                let pct = ((secs / total) * 100.0).clamp(0.0, 100.0);
                let _ = app.emit("render-progress", pct);
            }
        }
    }
    let status = child.wait().map_err(|e| format!("Composición (pasada 2): ffmpeg no terminó ({e})"))?;
    if !status.success() {
        return Err("Composición (pasada 2): ffmpeg salió con error.".into());
    }
    let _ = app.emit("render-progress", 100.0_f64);
    Ok(())
}

fn parse_box(b: &str) -> Option<(String, String)> {
    let (color, alpha) = b.split_once('@')?;
    if !is_hex(color) {
        return None;
    }
    let a: f64 = alpha.parse().ok()?;
    if !(0.0..=1.0).contains(&a) {
        return None;
    }
    Some((color.to_string(), alpha.to_string()))
}

// ---------------------------------------------------------------------------
// Manifest timeline parsing (trims/speed/zoom/text) + t_out mapping.
// ---------------------------------------------------------------------------

fn parse_trims(m: &Value, duration: f64) -> Result<Vec<(f64, f64)>, String> {
    arr(m, "trims")
        .iter()
        .map(|t| {
            let t0 = req_float(t.get("t0"), 0.0, duration, "trim.t0")?;
            let t1 = req_float(t.get("t1"), 0.0, duration + 1.0, "trim.t1")?;
            Ok((t0, t1))
        })
        .collect()
}

fn parse_speeds(m: &Value) -> Result<Vec<(f64, f64, f64)>, String> {
    arr(m, "speed")
        .iter()
        .map(|s| {
            let t0 = req_float(s.get("t0"), 0.0, f64::MAX, "speed.t0")?;
            let t1 = req_float(s.get("t1"), 0.0, f64::MAX, "speed.t1")?;
            let factor = req_float(s.get("factor"), 0.25, 4.0, "speed.factor")?;
            Ok((t0, t1, factor))
        })
        .collect()
}

/// Re-validates a zoom region. `t0`/`t1` arrive already mapped to t_out, so they
/// are only checked for finiteness/order, not against the source duration.
fn parse_zoom(z: &Value, t0: f64, t1: f64) -> Result<Zoom, String> {
    Ok(Zoom {
        t0,
        t1,
        level: req_float(z.get("level"), 1.0, 5.0, "zoom.level")?,
        cx: req_float(z.get("cx"), 0.0, 1.0, "zoom.cx")?,
        cy: req_float(z.get("cy"), 0.0, 1.0, "zoom.cy")?,
        ramp: opt_float(z, "ramp", 0.3, 0.1, 2.0, "zoom.ramp")?,
    })
}

// ---------------------------------------------------------------------------
// Command entry point.
// ---------------------------------------------------------------------------

fn resolve_font(app: &AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("No se pudo localizar la carpeta de recursos: {e}"))?;
    let font = dir.join("resources").join("DejaVuSans-Bold.ttf");
    if !font.is_file() {
        return Err("No se encontró la fuente empaquetada para los textos.".into());
    }
    path_str(&font)
}

fn output_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or("No se pudo localizar el directorio de usuario.")?;
    let dir = home.join("Movies").join("FunLead");
    std::fs::create_dir_all(&dir).map_err(|e| format!("No se pudo crear la carpeta de salida: {e}"))?;
    Ok(dir)
}

/// Renders `raw_path` with `manifest` and returns the absolute path of the MP4.
fn render(app: &AppHandle, data_dir: &Path, raw_path: &str, manifest: &Value) -> Result<String, String> {
    if manifest.get("version").and_then(Value::as_i64) != Some(1) {
        return Err("Versión de manifest no soportada.".into());
    }
    if !Path::new(raw_path).is_file() {
        return Err("El vídeo original no existe.".into());
    }

    let font = resolve_font(app)?;
    let probe0 = probe(app, data_dir, raw_path)?;
    let duration = probe0.duration;

    let trims = parse_trims(manifest, duration)?;
    let speeds = parse_speeds(manifest)?;
    let has_cut = !trims.is_empty() || speeds.iter().any(|(_, _, f)| (f - 1.0).abs() > 1e-3);

    let work = std::env::temp_dir().join(format!(
        "funlead-render-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&work).map_err(|e| format!("No se pudo crear el espacio de trabajo: {e}"))?;

    let result = (|| -> Result<String, String> {
        // Build zoom/text in t_out (mapped through PASS 1's segment table, or
        // identity when there's no cut).
        let (video, zooms, texts) = if has_cut {
            let segments = compute_segments(&trims, &speeds, duration);
            if segments.is_empty() {
                return Err("Los recortes no dejan ningún tramo.".into());
            }
            let (table, total_out) = build_src_to_out(&segments);
            let video = pass1_cut(app, data_dir, raw_path, &segments, probe0.has_audio, &work)?;

            let mut zooms = Vec::new();
            for z in arr(manifest, "zoom") {
                let z0 = req_float(z.get("t0"), 0.0, f64::MAX, "zoom.t0")?;
                let z1 = req_float(z.get("t1"), 0.0, f64::MAX, "zoom.t1")?;
                let (m0, m1) = (map_t(&table, total_out, z0), map_t(&table, total_out, z1));
                if m1 > m0 {
                    zooms.push(parse_zoom(z, m0, m1)?);
                }
            }
            let texts = map_texts(manifest, &table, total_out)?;
            (video, zooms, texts)
        } else {
            let mut zooms = Vec::new();
            for z in arr(manifest, "zoom") {
                let z0 = req_float(z.get("t0"), 0.0, f64::MAX, "zoom.t0")?;
                let z1 = req_float(z.get("t1"), 0.0, f64::MAX, "zoom.t1")?;
                if z1 > z0 {
                    zooms.push(parse_zoom(z, z0, z1)?);
                }
            }
            let texts: Vec<Value> = arr(manifest, "text")
                .iter()
                .filter(|t| {
                    let a = t.get("t0").and_then(Value::as_f64).unwrap_or(0.0);
                    let b = t.get("t1").and_then(Value::as_f64).unwrap_or(0.0);
                    b > a
                })
                .cloned()
                .collect();
            (PathBuf::from(raw_path), zooms, texts)
        };

        let out_path = output_dir()?.join(format!(
            "FunLead-edit-{}.mp4",
            chrono::Local::now().format("%Y%m%d-%H%M%S")
        ));
        pass2_compose(app, data_dir, &video, manifest, &zooms, &texts, &font, &out_path, &work)?;
        // Sanity-check the output is a readable video.
        let out_str = path_str(&out_path)?;
        probe(app, data_dir, &out_str)?;
        Ok(out_str)
    })();

    let _ = std::fs::remove_dir_all(&work);
    result
}

/// Re-validates text regions and maps their t0/t1 to t_out via the segment table.
fn map_texts(manifest: &Value, table: &[MapRow], total_out: f64) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    for t in arr(manifest, "text") {
        let s0 = req_float(t.get("t0"), 0.0, f64::MAX, "text.t0")?;
        let s1 = req_float(t.get("t1"), 0.0, f64::MAX, "text.t1")?;
        let (m0, m1) = (map_t(table, total_out, s0), map_t(table, total_out, s1));
        if m1 > m0 {
            let mut clone = t.clone();
            if let Value::Object(map) = &mut clone {
                map.insert("t0".into(), serde_json::json!(m0));
                map.insert("t1".into(), serde_json::json!(m1));
            }
            out.push(clone);
        }
    }
    Ok(out)
}

/// Renders the raw recording + edit manifest into a polished MP4 in
/// `~/Movies/FunLead/`. Emits `render-progress` (0..100) as it composes. Runs the
/// (CPU-bound) ffmpeg work on a blocking thread so the UI never freezes.
#[tauri::command]
pub async fn render_video(
    app: AppHandle,
    raw_path: String,
    manifest: Value,
) -> Result<String, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map(|d| d.join("ffmpeg"))
        .map_err(|e| format!("No se pudo localizar la carpeta de datos: {e}"))?;
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || render(&app2, &data_dir, &raw_path, &manifest))
        .await
        .map_err(|e| format!("El render se interrumpió: {e}"))?
}

// ---------------------------------------------------------------------------
// Tests — pure t_src/t_out logic, no ffmpeg.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-6
    }

    #[test]
    fn simple_trim_drops_the_cut_region() {
        // Cut [2,4] out of a 10s clip → keep [0,2] and [4,10].
        let segs = compute_segments(&[(2.0, 4.0)], &[], 10.0);
        assert_eq!(segs.len(), 2);
        assert!(approx(segs[0].a, 0.0) && approx(segs[0].b, 2.0) && approx(segs[0].factor, 1.0));
        assert!(approx(segs[1].a, 4.0) && approx(segs[1].b, 10.0) && approx(segs[1].factor, 1.0));

        let (table, total) = build_src_to_out(&segs);
        // Output duration = 2 + 6 = 8s.
        assert!(approx(total, 8.0));
        // t_src=1 stays at t_out=1 (first kept tramo, factor 1).
        assert!(approx(map_t(&table, total, 1.0), 1.0));
        // t_src=5 → 2 (first tramo) + (5-4)/1 = 3.
        assert!(approx(map_t(&table, total, 5.0), 3.0));
        // A point inside the cut region (after the first kept tramo) falls through
        // to total_out — matching render.py:map_t (it clamps to 0 only when the
        // point precedes the first kept tramo).
        let inside = map_t(&table, total, 3.0);
        assert!(approx(inside, total), "trim interior clamps to total_out, got {inside}");
        // A point before the first kept tramo clamps to 0.
        let before = map_t(&[MapRow { a: 5.0, b: 8.0, factor: 1.0, out_a: 0.0 }], 3.0, 1.0);
        assert!(approx(before, 0.0));
    }

    #[test]
    fn trim_plus_speed_combined_subdivides_and_compresses() {
        // 10s clip, cut [8,10], and 2x speed over [2,6].
        let segs = compute_segments(&[(8.0, 10.0)], &[(2.0, 6.0, 2.0)], 10.0);
        // Keep is [0,8], subdivided at the speed bounds 2 and 6 → [0,2],[2,6],[6,8].
        assert_eq!(segs.len(), 3);
        assert!(approx(segs[0].a, 0.0) && approx(segs[0].b, 2.0) && approx(segs[0].factor, 1.0));
        assert!(approx(segs[1].a, 2.0) && approx(segs[1].b, 6.0) && approx(segs[1].factor, 2.0));
        assert!(approx(segs[2].a, 6.0) && approx(segs[2].b, 8.0) && approx(segs[2].factor, 1.0));

        let (table, total) = build_src_to_out(&segs);
        // Out = 2 + (4/2) + 2 = 6s.
        assert!(approx(total, 6.0), "total out {total}");
        // t_src=4 sits mid sped tramo: out_a(=2) + (4-2)/2 = 3.
        assert!(approx(map_t(&table, total, 4.0), 3.0));
        // t_src=7 in the last tramo: out_a(=4) + (7-6)/1 = 5.
        assert!(approx(map_t(&table, total, 7.0), 5.0));
    }

    #[test]
    fn merge_intervals_collapses_overlaps() {
        let merged = merge_intervals(vec![(1.0, 3.0), (2.0, 4.0), (6.0, 7.0)]);
        assert_eq!(merged, vec![(1.0, 4.0), (6.0, 7.0)]);
    }

    #[test]
    fn atempo_chain_handles_out_of_range_factors() {
        assert!(atempo_chain(1.0).is_empty());
        assert_eq!(atempo_chain(2.0), vec!["atempo=2.0000".to_string()]);
        // 4x → 2.0 * 2.0
        assert_eq!(atempo_chain(4.0), vec!["atempo=2.0".to_string(), "atempo=2.0000".to_string()]);
        // 0.25x → 0.5 * 0.5
        assert_eq!(atempo_chain(0.25), vec!["atempo=0.5".to_string(), "atempo=0.5000".to_string()]);
    }

    #[test]
    fn parse_time_reads_hms() {
        assert!(approx(parse_time("00:00:05.00").unwrap(), 5.0));
        assert!(approx(parse_time("00:03:29.04").unwrap(), 209.04));
        assert!(parse_time("nope").is_none());
    }

    #[test]
    fn hex_validation_is_strict() {
        assert!(is_hex("0x1a2B3c"));
        assert!(!is_hex("0x1a2B3"));
        assert!(!is_hex("#1a2b3c"));
        assert!(!is_hex("0x1a2b3g"));
    }
}
