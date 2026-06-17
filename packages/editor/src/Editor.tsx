/**
 * Editor post-grabación.
 *  FASE 1: fondos estilizados (color/degradado + margen + redondeo + sombra).
 *  FASE 2: timeline (recortes, velocidad, zoom manual, texto).
 *
 * Preview en <canvas> 2D sobre el <video> crudo. Refleja fondo + zoom + texto en
 * vivo (aproximado). Los recortes/velocidad solo se ven en el render final (el
 * preview reproduce el crudo entero). La verdad es el render (mismo manifest).
 * Sin morado (marca FunLead). Mobile-first. Cero red: toda E/S va por `io`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EditManifest } from "./edit-manifest";
import type { EditorIO } from "./io";
import { EditorTimeline } from "./EditorTimeline";
import "./editor-theme.css";

type Shadow = NonNullable<EditManifest["frame"]["shadow"]>;
type UiBackground =
  | { type: "color"; color: string }
  | { type: "gradient"; gradient: { c0: string; c1: string; angle: number } };

const NAVY = "0x1e3a5f";
const CELESTE = "0x60a5fa";

const DEFAULT_MANIFEST: EditManifest = {
  version: 1,
  canvas: { w: 1920, h: 1080, fps: 30 },
  background: { type: "gradient", gradient: { c0: NAVY, c1: CELESTE, angle: 135 } },
  frame: { padding: 80, radius: 32, shadow: { dx: 0, dy: 24, blur: 40, opacity: 0.45, color: "0x000000" } },
  trims: [], speed: [], zoom: [], text: [],
};

const PRESETS: { label: string; bg: UiBackground }[] = [
  { label: "Navy → Celeste", bg: { type: "gradient", gradient: { c0: NAVY, c1: CELESTE, angle: 135 } } },
  { label: "Navy sólido", bg: { type: "color", color: NAVY } },
  { label: "Grafito", bg: { type: "color", color: "0x111827" } },
  { label: "Celeste suave", bg: { type: "gradient", gradient: { c0: "0x60a5fa", c1: "0xdbeafe", angle: 135 } } },
];

const hexToCss = (h: string) => "#" + h.replace(/^0x/, "");
const cssToHex = (c: string) => "0x" + c.replace(/^#/, "").toLowerCase();
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const PREVIEW_SCALE = 0.5;
const smoothstep = (p: number) => { const c = Math.max(0, Math.min(1, p)); return c * c * (3 - 2 * c); };

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// Rect del vídeo dentro del canvas del manifest (coords del manifest).
function videoRect(m: EditManifest, vidW: number, vidH: number) {
  const { w: cw, h: ch } = m.canvas;
  const padding = m.frame.padding;
  const innerW = Math.max(2, cw - 2 * padding);
  const innerH = Math.max(2, ch - 2 * padding);
  const scale = Math.min(innerW / vidW, innerH / vidH);
  const vw = Math.round(vidW * scale);
  const vh = Math.round(vidH * scale);
  return { px: Math.round((cw - vw) / 2), py: Math.round((ch - vh) / 2), vw, vh };
}

// Factor de zoom y foco activos en el tiempo t (t_src, sobre el crudo).
function zoomAt(m: EditManifest, t: number) {
  let z = 1, cx = 0.5, cy = 0.5;
  for (const r of m.zoom ?? []) {
    if (t >= r.t0 && t <= r.t1) {
      const ramp = Math.min(r.ramp, (r.t1 - r.t0) / 2);
      const e = smoothstep((t - r.t0) / ramp) - smoothstep((t - (r.t1 - ramp)) / ramp);
      z = 1 + (r.level - 1) * e;
      cx = r.cx; cy = r.cy;
    }
  }
  return { z, cx, cy };
}

export function Editor({
  io, rawPath, initialManifest, initialRenderStatus, initialRenderedSrc,
}: {
  io: EditorIO;
  rawPath: string;
  initialManifest: EditManifest | null;
  initialRenderStatus: string | null;
  initialRenderedSrc: string | null;
}) {
  const [manifest, setManifest] = useState<EditManifest>(initialManifest ? { ...DEFAULT_MANIFEST, ...initialManifest } : DEFAULT_MANIFEST);
  const [tab, setTab] = useState<"fondo" | "timeline">("fondo");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [renderStatus, setRenderStatus] = useState<string | null>(initialRenderStatus);
  const [renderedSrc, setRenderedSrc] = useState<string | null>(initialRenderedSrc);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [pickingFocusFor, setPickingFocusFor] = useState<number | null>(null);

  const rawSrc = useMemo(() => io.resolveMediaSrc(rawPath), [io, rawPath]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const manifestRef = useRef(manifest);
  useEffect(() => { manifestRef.current = manifest; }, [manifest]);

  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current, video = videoRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const m = manifestRef.current;
    const { w: cw, h: ch } = m.canvas;
    canvas.width = Math.round(cw * PREVIEW_SCALE);
    canvas.height = Math.round(ch * PREVIEW_SCALE);
    ctx.setTransform(PREVIEW_SCALE, 0, 0, PREVIEW_SCALE, 0, 0);

    // fondo
    const bg = m.background;
    if (bg.type === "gradient" && bg.gradient) {
      const { c0, c1, angle } = bg.gradient;
      const rad = (angle * Math.PI) / 180, vx = Math.cos(rad), vy = Math.sin(rad);
      const g = ctx.createLinearGradient(cw / 2 - (vx * cw) / 2, ch / 2 - (vy * ch) / 2, cw / 2 + (vx * cw) / 2, ch / 2 + (vy * ch) / 2);
      g.addColorStop(0, hexToCss(c0)); g.addColorStop(1, hexToCss(c1));
      ctx.fillStyle = g; ctx.fillRect(0, 0, cw, ch);
    } else {
      ctx.fillStyle = bg.type === "color" && bg.color ? hexToCss(bg.color) : hexToCss(NAVY);
      ctx.fillRect(0, 0, cw, ch);
    }

    const vidW = video?.videoWidth || 1280, vidH = video?.videoHeight || 720;
    const { px, py, vw, vh } = videoRect(m, vidW, vidH);

    // sombra
    const sh = m.frame.shadow;
    if (sh && sh.opacity > 0) {
      ctx.save();
      ctx.shadowColor = `rgba(0,0,0,${sh.opacity})`;
      ctx.shadowBlur = sh.blur; ctx.shadowOffsetX = sh.dx; ctx.shadowOffsetY = sh.dy;
      ctx.fillStyle = "#000"; roundRectPath(ctx, px, py, vw, vh, m.frame.radius); ctx.fill();
      ctx.restore();
    }

    // vídeo (con zoom aplicado al recorte de fuente)
    ctx.save();
    roundRectPath(ctx, px, py, vw, vh, m.frame.radius); ctx.clip();
    if (video && video.readyState >= 2) {
      const { z, cx, cy } = zoomAt(m, video.currentTime);
      const sw = vidW / z, shh = vidH / z;
      const sx = (vidW - sw) * cx, sy = (vidH - shh) * cy;
      ctx.drawImage(video, sx, sy, sw, shh, px, py, vw, vh);
    } else {
      ctx.fillStyle = "#0b1220"; ctx.fillRect(px, py, vw, vh);
    }
    ctx.restore();

    // texto activo
    for (const t of m.text ?? []) {
      const ct = video?.currentTime ?? 0;
      if (ct < t.t0 || ct > t.t1) continue;
      const fade = Math.max(0.01, Math.min(t.fade, (t.t1 - t.t0) / 2));
      let a = 1;
      if (ct < t.t0 + fade) a = (ct - t.t0) / fade;
      else if (ct > t.t1 - fade) a = (t.t1 - ct) / fade;
      ctx.save();
      ctx.globalAlpha = clamp01(a);
      ctx.font = `bold ${t.size}px sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const tx = t.x === "center" ? cw / 2 : (t.x as number) * cw;
      const ty = t.y * ch;
      const metrics = ctx.measureText(t.content);
      if (t.box) {
        const pad = 20, bw = metrics.width + pad * 2, bh = t.size + pad;
        const m2 = /^(0x[0-9a-fA-F]{6})@([0-9.]+)$/.exec(t.box);
        ctx.fillStyle = m2 ? `rgba(${parseInt(m2[1].slice(2, 4), 16)},${parseInt(m2[1].slice(4, 6), 16)},${parseInt(m2[1].slice(6, 8), 16)},${m2[2]})` : "rgba(30,58,95,0.85)";
        roundRectPath(ctx, tx - bw / 2, ty - bh / 2, bw, bh, 8); ctx.fill();
      }
      ctx.fillStyle = t.color === "white" ? "#fff" : hexToCss(t.color);
      ctx.fillText(t.content, tx, ty);
      ctx.restore();
    }
  }, []);

  useEffect(() => {
    const loop = () => { drawFrame(); rafRef.current = requestAnimationFrame(loop); };
    rafRef.current = requestAnimationFrame(loop);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [drawFrame]);

  // currentTime para la UI (throttle 200ms; el dibujo usa video.currentTime directo)
  useEffect(() => {
    const iv = setInterval(() => {
      const v = videoRef.current;
      if (v) { setCurrentTime(v.currentTime); if (v.duration && !Number.isNaN(v.duration)) setDuration(v.duration); }
    }, 200);
    return () => clearInterval(iv);
  }, []);

  // autosave
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    const t = setTimeout(async () => {
      setSaveState("saving");
      try {
        await io.saveManifest(manifest);
        setSaveState("saved");
      } catch { setSaveState("error"); }
    }, 700);
    return () => clearTimeout(t);
  }, [manifest, io]);

  // render + polling de estado
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      try {
        const d = await io.getStatus();
        setRenderStatus(d.renderStatus);
        if (d.renderStatus === "ready") { setRenderedSrc(d.renderedSrc); if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } }
        else if (d.renderStatus === "failed") { setRenderError(d.renderError || "El render falló."); if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } }
      } catch { /* reintenta */ }
    }, 4000);
  }, [io]);
  useEffect(() => {
    if (renderStatus === "processing") startPolling();
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [renderStatus, startPolling]);

  const onRender = useCallback(async () => {
    setRenderError(null);
    try {
      await io.render(manifest);
      setRenderStatus("processing"); setRenderedSrc(null);
    } catch { setRenderError("No se pudo encolar el render."); }
  }, [manifest, io]);

  const onCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (pickingFocusFor === null) return;
    const canvas = canvasRef.current, video = videoRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const m = manifestRef.current;
    const mx = ((e.clientX - rect.left) / rect.width) * m.canvas.w;
    const my = ((e.clientY - rect.top) / rect.height) * m.canvas.h;
    const { px, py, vw, vh } = videoRect(m, video?.videoWidth || 1280, video?.videoHeight || 720);
    const cx = clamp01((mx - px) / vw), cy = clamp01((my - py) / vh);
    setManifest((prev) => ({ ...prev, zoom: (prev.zoom ?? []).map((z, i) => i === pickingFocusFor ? { ...z, cx, cy } : z) }));
    setPickingFocusFor(null);
  }, [pickingFocusFor]);

  const patch = (fn: (m: EditManifest) => EditManifest) => setManifest((prev) => fn(prev));
  const setBackground = (bg: UiBackground) => patch((m) => ({ ...m, background: bg }));
  const setFrame = (f: Partial<EditManifest["frame"]>) => patch((m) => ({ ...m, frame: { ...m.frame, ...f } }));
  const setShadow = (s: Partial<Shadow>) => patch((m) => ({ ...m, frame: { ...m.frame, shadow: { ...(m.frame.shadow ?? DEFAULT_MANIFEST.frame.shadow!), ...s } } }));

  const bg = manifest.background;
  const shadow = manifest.frame.shadow ?? DEFAULT_MANIFEST.frame.shadow!;
  const saveLabel = useMemo(() => ({ idle: "", saving: "Guardando…", saved: "Guardado", error: "Error al guardar" }[saveState]), [saveState]);
  const seek = (t: number) => { const v = videoRef.current; if (v) { v.currentTime = t; setCurrentTime(t); } };

  return (
    <div className="funlead-editor grid gap-6 lg:grid-cols-[1fr_340px]">
      <div className="min-w-0">
        <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)]">
          <canvas
            ref={canvasRef}
            onClick={onCanvasClick}
            className={"block w-full" + (pickingFocusFor !== null ? " cursor-crosshair" : "")}
            style={{ aspectRatio: `${manifest.canvas.w} / ${manifest.canvas.h}` }}
          />
        </div>
        <video ref={videoRef} src={rawSrc} controls playsInline className="mt-3 w-full rounded-lg border border-[var(--border)]" style={{ maxHeight: 180 }} />
        <p className="mt-2 text-xs text-[var(--muted-foreground)]">
          La previsualización es orientativa (fondo, zoom y texto). Los recortes y la velocidad solo se aplican en el vídeo final.
        </p>
      </div>

      <div className="space-y-4">
        <div className="flex gap-2 border-b border-[var(--border)]">
          {(["fondo", "timeline"] as const).map((tk) => (
            <button key={tk} onClick={() => setTab(tk)}
              className={"px-3 py-2 text-sm font-medium transition " + (tab === tk ? "border-b-2 border-[var(--primary)] text-[var(--foreground)]" : "text-[var(--muted-foreground)]")}>
              {tk === "fondo" ? "Fondo" : "Timeline"}
            </button>
          ))}
        </div>

        {tab === "fondo" ? (
          <div className="space-y-5">
            <section>
              <h3 className="mb-2 text-sm font-semibold text-[var(--foreground)]">Fondo</h3>
              <div className="grid grid-cols-2 gap-2">
                {PRESETS.map((p) => (
                  <button key={p.label} onClick={() => setBackground(p.bg)} className="rounded-lg border border-[var(--border)] px-3 py-2 text-left text-xs transition hover:border-[var(--primary)]">{p.label}</button>
                ))}
              </div>
              <div className="mt-3 flex gap-2">
                <button onClick={() => setBackground({ type: "color", color: bg.type === "color" && bg.color ? bg.color : NAVY })} className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition ${bg.type === "color" ? "bg-[var(--primary)] text-white" : "border border-[var(--border)]"}`}>Color</button>
                <button onClick={() => setBackground({ type: "gradient", gradient: bg.type === "gradient" && bg.gradient ? bg.gradient : { c0: NAVY, c1: CELESTE, angle: 135 } })} className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition ${bg.type === "gradient" ? "bg-[var(--primary)] text-white" : "border border-[var(--border)]"}`}>Degradado</button>
              </div>
              {bg.type === "color" && bg.color ? (
                <label className="mt-3 flex items-center justify-between text-xs">Color<input type="color" value={hexToCss(bg.color)} onChange={(e) => setBackground({ type: "color", color: cssToHex(e.target.value) })} /></label>
              ) : bg.type === "gradient" && bg.gradient ? (
                <div className="mt-3 space-y-2">
                  <label className="flex items-center justify-between text-xs">Desde<input type="color" value={hexToCss(bg.gradient.c0)} onChange={(e) => setBackground({ type: "gradient", gradient: { ...bg.gradient!, c0: cssToHex(e.target.value) } })} /></label>
                  <label className="flex items-center justify-between text-xs">Hasta<input type="color" value={hexToCss(bg.gradient.c1)} onChange={(e) => setBackground({ type: "gradient", gradient: { ...bg.gradient!, c1: cssToHex(e.target.value) } })} /></label>
                  <label className="block text-xs">Ángulo: {bg.gradient.angle}°<input type="range" min={0} max={360} value={bg.gradient.angle} onChange={(e) => setBackground({ type: "gradient", gradient: { ...bg.gradient!, angle: Number(e.target.value) } })} className="w-full" /></label>
                </div>
              ) : null}
            </section>
            <section>
              <h3 className="mb-2 text-sm font-semibold text-[var(--foreground)]">Marco</h3>
              <label className="block text-xs">Margen: {manifest.frame.padding}px<input type="range" min={0} max={300} value={manifest.frame.padding} onChange={(e) => setFrame({ padding: Number(e.target.value) })} className="w-full" /></label>
              <label className="mt-2 block text-xs">Esquinas: {manifest.frame.radius}px<input type="range" min={0} max={120} value={manifest.frame.radius} onChange={(e) => setFrame({ radius: Number(e.target.value) })} className="w-full" /></label>
            </section>
            <section>
              <h3 className="mb-2 text-sm font-semibold text-[var(--foreground)]">Sombra</h3>
              <label className="block text-xs">Intensidad: {Math.round(shadow.opacity * 100)}%<input type="range" min={0} max={100} value={Math.round(shadow.opacity * 100)} onChange={(e) => setShadow({ opacity: Number(e.target.value) / 100 })} className="w-full" /></label>
              <label className="mt-2 block text-xs">Difuminado: {shadow.blur}<input type="range" min={0} max={100} value={shadow.blur} onChange={(e) => setShadow({ blur: Number(e.target.value) })} className="w-full" /></label>
              <label className="mt-2 block text-xs">Desplazamiento Y: {shadow.dy}<input type="range" min={0} max={80} value={shadow.dy} onChange={(e) => setShadow({ dy: Number(e.target.value) })} className="w-full" /></label>
            </section>
          </div>
        ) : (
          <EditorTimeline manifest={manifest} currentTime={currentTime} duration={duration} onChange={setManifest} pickingFocusFor={pickingFocusFor} onPickFocus={setPickingFocusFor} onSeek={seek} />
        )}

        <div className="border-t border-[var(--border)] pt-4">
          <p className="mb-2 h-4 text-xs text-[var(--muted-foreground)]">{saveLabel}</p>
          <button onClick={onRender} disabled={renderStatus === "processing"} className="w-full rounded-lg bg-[var(--primary)] px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50">
            {renderStatus === "processing" ? "Generando vídeo pulido…" : "Generar vídeo pulido"}
          </button>
          {renderStatus === "processing" && <p className="mt-2 text-xs text-[var(--muted-foreground)]">Esto tarda unos minutos. Te avisamos cuando esté; puedes cerrar esta página.</p>}
          {renderError && <p className="mt-2 text-xs text-red-600">{renderError}</p>}
          {renderStatus === "ready" && renderedSrc && (
            <div className="mt-3 rounded-lg border border-[var(--border)] p-3">
              <p className="text-xs font-medium text-[var(--foreground)]">Vídeo pulido listo</p>
              <video src={renderedSrc} controls playsInline className="mt-2 w-full rounded" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
