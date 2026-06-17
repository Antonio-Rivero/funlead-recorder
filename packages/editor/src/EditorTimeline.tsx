/**
 * Editor timeline controls (Phase 2): trims, speed, manual zoom and text.
 * Split from Editor.tsx to keep the component small. Edits the manifest
 * immutably via onChange. Times are marked over the raw video (what the user
 * sees); the renderer maps them to the final timeline.
 */
import type { EditManifest } from "./edit-manifest";

const SPEED_PRESETS = [0.5, 0.75, 1.5, 2];
const ZOOM_LEVELS = [1.25, 1.5, 1.8, 2.2];

function fmt(t: number) {
  const s = Math.max(0, t);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}.${String(Math.floor((s % 1) * 10))}`;
}

export function EditorTimeline({
  manifest,
  currentTime,
  duration,
  onChange,
  pickingFocusFor,
  onPickFocus,
  onSeek,
}: {
  manifest: EditManifest;
  currentTime: number;
  duration: number;
  onChange: (m: EditManifest) => void;
  pickingFocusFor: number | null;
  onPickFocus: (zoomIndex: number | null) => void;
  onSeek: (t: number) => void;
}) {
  const trims = manifest.trims ?? [];
  const speed = manifest.speed ?? [];
  const zoom = manifest.zoom ?? [];
  const text = manifest.text ?? [];
  const at = () => Math.min(currentTime, Math.max(0, duration - 0.5));
  const end = (t0: number) => Math.min(duration, t0 + 2);

  const update = (patch: Partial<EditManifest>) => onChange({ ...manifest, ...patch });
  const setArr = <K extends "trims" | "speed" | "zoom" | "text">(k: K, arr: EditManifest[K]) =>
    update({ [k]: arr } as Partial<EditManifest>);

  const rowBtn = "rounded-md border border-[var(--border)] px-2 py-1 text-[11px] transition hover:border-[var(--primary)]";
  const delBtn = "ml-auto text-[11px] text-red-600 hover:underline";
  const numIn = "w-14 rounded border border-[var(--border)] bg-transparent px-1 py-0.5 text-[11px] tabular-nums";

  return (
    <div className="space-y-5">
      {/* RECORTES */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[var(--foreground)]">Recortes</h3>
          <button
            className={rowBtn}
            onClick={() => setArr("trims", [...trims, { t0: at(), t1: end(at()) }])}
          >
            + Cortar desde {fmt(at())}
          </button>
        </div>
        {trims.length === 0 && <p className="text-[11px] text-[var(--muted-foreground)]">Marca tramos a eliminar.</p>}
        {trims.map((t, i) => (
          <div key={i} className="mb-1 flex items-center gap-1.5 text-[11px]">
            <button className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]" onClick={() => onSeek(t.t0)}>▶</button>
            <input type="number" step="0.1" className={numIn} value={t.t0.toFixed(1)} onChange={(e) => setArr("trims", trims.map((x, j) => j === i ? { ...x, t0: Number(e.target.value) } : x))} />
            <span>→</span>
            <input type="number" step="0.1" className={numIn} value={t.t1.toFixed(1)} onChange={(e) => setArr("trims", trims.map((x, j) => j === i ? { ...x, t1: Number(e.target.value) } : x))} />
            <span className="text-[var(--muted-foreground)]">s</span>
            <button className={delBtn} onClick={() => setArr("trims", trims.filter((_, j) => j !== i))}>Borrar</button>
          </div>
        ))}
      </section>

      {/* VELOCIDAD */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[var(--foreground)]">Velocidad</h3>
          <button className={rowBtn} onClick={() => setArr("speed", [...speed, { t0: at(), t1: end(at()), factor: 2 }])}>
            + Tramo desde {fmt(at())}
          </button>
        </div>
        {speed.map((s, i) => (
          <div key={i} className="mb-1 flex items-center gap-1.5 text-[11px]">
            <button className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]" onClick={() => onSeek(s.t0)}>▶</button>
            <input type="number" step="0.1" className={numIn} value={s.t0.toFixed(1)} onChange={(e) => setArr("speed", speed.map((x, j) => j === i ? { ...x, t0: Number(e.target.value) } : x))} />
            <span>→</span>
            <input type="number" step="0.1" className={numIn} value={s.t1.toFixed(1)} onChange={(e) => setArr("speed", speed.map((x, j) => j === i ? { ...x, t1: Number(e.target.value) } : x))} />
            <select className={numIn + " w-auto"} value={s.factor} onChange={(e) => setArr("speed", speed.map((x, j) => j === i ? { ...x, factor: Number(e.target.value) } : x))}>
              {SPEED_PRESETS.map((f) => <option key={f} value={f}>{f}x</option>)}
            </select>
            <button className={delBtn} onClick={() => setArr("speed", speed.filter((_, j) => j !== i))}>Borrar</button>
          </div>
        ))}
      </section>

      {/* ZOOM */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[var(--foreground)]">Zoom</h3>
          <button className={rowBtn} onClick={() => setArr("zoom", [...zoom, { t0: at(), t1: end(at()), level: 1.8, cx: 0.5, cy: 0.5, ramp: 0.4 }])}>
            + Zoom desde {fmt(at())}
          </button>
        </div>
        {zoom.map((z, i) => (
          <div key={i} className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
            <button className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]" onClick={() => onSeek(z.t0)}>▶</button>
            <input type="number" step="0.1" className={numIn} value={z.t0.toFixed(1)} onChange={(e) => setArr("zoom", zoom.map((x, j) => j === i ? { ...x, t0: Number(e.target.value) } : x))} />
            <span>→</span>
            <input type="number" step="0.1" className={numIn} value={z.t1.toFixed(1)} onChange={(e) => setArr("zoom", zoom.map((x, j) => j === i ? { ...x, t1: Number(e.target.value) } : x))} />
            <select className={numIn + " w-auto"} value={z.level} onChange={(e) => setArr("zoom", zoom.map((x, j) => j === i ? { ...x, level: Number(e.target.value) } : x))}>
              {ZOOM_LEVELS.map((l) => <option key={l} value={l}>{l}x</option>)}
            </select>
            <button
              className={rowBtn + (pickingFocusFor === i ? " border-[var(--primary)] bg-[var(--primary)] text-white" : "")}
              onClick={() => onPickFocus(pickingFocusFor === i ? null : i)}
            >
              {pickingFocusFor === i ? "Clic en el vídeo…" : "Foco"}
            </button>
            <button className={delBtn} onClick={() => setArr("zoom", zoom.filter((_, j) => j !== i))}>Borrar</button>
          </div>
        ))}
        {zoom.length === 0 && <p className="text-[11px] text-[var(--muted-foreground)]">Amplía un punto del vídeo en un tramo. Pulsa «Foco» y haz clic en el vídeo.</p>}
      </section>

      {/* TEXTO */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[var(--foreground)]">Texto</h3>
          <button className={rowBtn} onClick={() => setArr("text", [...text, { t0: at(), t1: end(at()), content: "Texto", x: "center", y: 0.85, size: 56, color: "white", box: "0x1e3a5f@0.85", fade: 0.3 }])}>
            + Texto desde {fmt(at())}
          </button>
        </div>
        {text.map((t, i) => (
          <div key={i} className="mb-1.5 space-y-1 rounded-md border border-[var(--border)] p-2 text-[11px]">
            <input className="w-full rounded border border-[var(--border)] bg-transparent px-1.5 py-1 text-xs" value={t.content} maxLength={200} onChange={(e) => setArr("text", text.map((x, j) => j === i ? { ...x, content: e.target.value } : x))} />
            <div className="flex items-center gap-1.5">
              <button className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]" onClick={() => onSeek(t.t0)}>▶</button>
              <input type="number" step="0.1" className={numIn} value={t.t0.toFixed(1)} onChange={(e) => setArr("text", text.map((x, j) => j === i ? { ...x, t0: Number(e.target.value) } : x))} />
              <span>→</span>
              <input type="number" step="0.1" className={numIn} value={t.t1.toFixed(1)} onChange={(e) => setArr("text", text.map((x, j) => j === i ? { ...x, t1: Number(e.target.value) } : x))} />
              <button className={delBtn} onClick={() => setArr("text", text.filter((_, j) => j !== i))}>Borrar</button>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
