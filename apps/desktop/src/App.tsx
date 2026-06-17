import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { Editor, type EditManifest } from "@funlead-recorder/editor";
import "./app.css";
import { BRAND } from "./branding";
import { createEditorIO, type RenderState } from "./editor-io";
import {
  checkPermission,
  ensureFfmpeg,
  ffmpegAvailable,
  hideControls,
  isCameraOpen,
  listDisplays,
  listInputDevices,
  listProjects,
  openProject,
  requestPermission,
  saveTranscript,
  showControls,
  startRecording,
  stopRecording,
  toggleCamera,
  transcribeRecording,
  type DisplayInfo,
  type InputDeviceInfo,
  type PermissionStatus,
  type ProjectInfo,
  type Quality,
} from "./tauri-api";

type Screen =
  | { kind: "loading" }
  | { kind: "needs-permission" }
  | { kind: "setup" }
  | { kind: "recording" }
  | { kind: "preview"; rawPath: string; projectName: string }
  | { kind: "editing"; rawPath: string; projectName: string; manifest: EditManifest | null };

const QUALITIES: { value: Quality; label: string }[] = [
  { value: "auto", label: "Original (nativa)" },
  { value: "1080", label: "1080p" },
  { value: "720", label: "720p" },
];

// Project name derived from the recording's file name (FunLead-YYYYmmdd-HHMMSS).
function projectNameFor(rawPath: string): string {
  const file = rawPath.split("/").pop() ?? "proyecto";
  return file.replace(/\.[^.]+$/, "");
}

export default function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  const [aboutOpen, setAboutOpen] = useState(false);

  return (
    <div className="app">
      <header className="app__header">
        <span className="recording-dot" style={{ visibility: screen.kind === "recording" ? "visible" : "hidden" }} />
        <span className="app__brand">{BRAND.productName}</span>
        <div className="app__spacer" />
        <button className="btn btn--ghost btn--sm" onClick={() => setAboutOpen(true)}>
          Acerca de
        </button>
      </header>

      <main className={"app__main" + (screen.kind === "editing" ? " app__main--wide" : "")}>
        <Body screen={screen} setScreen={setScreen} />
      </main>

      {aboutOpen && <About onClose={() => setAboutOpen(false)} />}
    </div>
  );
}

function Body({ screen, setScreen }: { screen: Screen; setScreen: (s: Screen) => void }) {
  switch (screen.kind) {
    case "loading":
      return <Boot setScreen={setScreen} />;
    case "needs-permission":
      return <PermissionGate setScreen={setScreen} />;
    case "setup":
      return <Setup setScreen={setScreen} />;
    case "recording":
      return <Recording setScreen={setScreen} />;
    case "preview":
      return <Preview rawPath={screen.rawPath} projectName={screen.projectName} setScreen={setScreen} />;
    case "editing":
      return (
        <EditScreen
          rawPath={screen.rawPath}
          projectName={screen.projectName}
          initialManifest={screen.manifest}
          setScreen={setScreen}
        />
      );
  }
}

// --- Boot: resolve permission once, then route. -----------------------------

function Boot({ setScreen }: { setScreen: (s: Screen) => void }) {
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const status = await checkPermission();
        if (!alive) return;
        setScreen(status === "granted" ? { kind: "setup" } : { kind: "needs-permission" });
      } catch {
        if (alive) setScreen({ kind: "needs-permission" });
      }
    })();
    return () => {
      alive = false;
    };
  }, [setScreen]);

  return <p className="muted">Comprobando permisos…</p>;
}

// --- Permission gate (macOS Screen Recording). ------------------------------

function PermissionGate({ setScreen }: { setScreen: (s: Screen) => void }) {
  const [status, setStatus] = useState<PermissionStatus | null>(null);

  const recheck = useCallback(async () => {
    const s = await checkPermission();
    setStatus(s);
    if (s === "granted") setScreen({ kind: "setup" });
  }, [setScreen]);

  return (
    <div className="stack">
      <div className="card stack">
        <h2 style={{ margin: 0, fontSize: 16 }}>Permiso de grabación</h2>
        <p className="muted">
          FunLead Recorder necesita el permiso de Grabación de pantalla de macOS. Concédelo en
          Ajustes del Sistema → Privacidad y seguridad → Grabación de pantalla y vuelve aquí.
        </p>
        <div className="row">
          <button className="btn btn--primary" onClick={() => requestPermission().then(recheck)}>
            Conceder permiso
          </button>
          <button className="btn" onClick={recheck}>
            Ya lo concedí
          </button>
        </div>
        {status === "denied" && <p className="error">Aún no está concedido.</p>}
        {status === "unsupported" && <p className="error">Este sistema no soporta la captura de pantalla.</p>}
      </div>
    </div>
  );
}

// --- Setup: choose source + start recording. --------------------------------

function Setup({ setScreen }: { setScreen: (s: Screen) => void }) {
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [mics, setMics] = useState<InputDeviceInfo[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [displayId, setDisplayId] = useState<number | null>(null);
  const [micId, setMicId] = useState<string>("");
  const [quality, setQuality] = useState<Quality>("auto");
  const [cameraOn, setCameraOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [d, m, p, camOpen] = await Promise.all([
          listDisplays(),
          listInputDevices(),
          listProjects(),
          isCameraOpen(),
        ]);
        setDisplays(d);
        setMics(m);
        setProjects(p);
        setCameraOn(camOpen);
        setDisplayId(d[0]?.id ?? null);
      } catch (e) {
        setError(typeof e === "string" ? e : "No se pudieron cargar las fuentes.");
      }
    })();
  }, []);

  const onToggleCamera = useCallback(async () => {
    try {
      const open = await toggleCamera(null);
      setCameraOn(open);
    } catch (e) {
      setError(typeof e === "string" ? e : "No se pudo abrir la cámara.");
    }
  }, []);

  const onStart = useCallback(async () => {
    if (displayId === null) return;
    setError(null);
    setBusy(true);
    try {
      if (!(await ffmpegAvailable())) {
        setDownloading(true);
        await ensureFfmpeg();
        setDownloading(false);
      }
      await startRecording({ displayId, fps: 30, micDeviceId: micId === "" ? null : micId, quality });
      await showControls().catch(() => {});
      setScreen({ kind: "recording" });
    } catch (e) {
      setDownloading(false);
      setError(typeof e === "string" ? e : "No se pudo iniciar la grabación.");
    } finally {
      setBusy(false);
    }
  }, [displayId, micId, quality, setScreen]);

  const onOpenProject = useCallback(
    async (name: string) => {
      try {
        const doc = await openProject(name);
        setScreen({ kind: "editing", rawPath: doc.raw_path, projectName: name, manifest: doc.manifest });
      } catch (e) {
        setError(typeof e === "string" ? e : "No se pudo abrir el proyecto.");
      }
    },
    [setScreen],
  );

  return (
    <div className="stack">
      <div className="card stack">
        <div className="field">
          <span className="field__label">Pantalla</span>
          {displays.length === 0 ? (
            <p className="error">No se detectaron pantallas. Revisa el permiso de grabación.</p>
          ) : (
            <select value={displayId ?? ""} onChange={(e) => setDisplayId(Number(e.target.value))}>
              {displays.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title || `Pantalla ${d.id}`}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="field">
          <span className="field__label">Micrófono</span>
          <select value={micId} onChange={(e) => setMicId(e.target.value)}>
            <option value="">Sin micrófono</option>
            {mics.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <span className="field__label">Calidad</span>
          <select value={quality} onChange={(e) => setQuality(e.target.value as Quality)}>
            {QUALITIES.map((q) => (
              <option key={q.value} value={q.value}>
                {q.label}
              </option>
            ))}
          </select>
        </div>

        <div className="row">
          <button className="btn" onClick={onToggleCamera}>
            {cameraOn ? "Quitar cámara" : "Añadir cámara"}
          </button>
          <div className="app__spacer" />
        </div>

        <button
          className="btn btn--record btn--block"
          onClick={onStart}
          disabled={busy || displayId === null}
        >
          {downloading ? "Preparando ffmpeg…" : busy ? "Iniciando…" : "● Grabar"}
        </button>
        {error && <p className="error">{error}</p>}
      </div>

      {projects.length > 0 && (
        <div className="card stack">
          <span className="field__label">Proyectos guardados</span>
          <div className="projects">
            {projects.map((p) => (
              <div key={p.name} className="project-row">
                <span className="project-row__name">{p.name}</span>
                <div className="app__spacer" />
                <button className="btn btn--sm" onClick={() => onOpenProject(p.name)}>
                  Abrir
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// --- Recording: stop from the main window (controls also float on screen). ---

function Recording({ setScreen }: { setScreen: (s: Screen) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const onStop = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await stopRecording();
      await hideControls().catch(() => {});
      if (result.mic_warning) setWarning(result.mic_warning);
      setScreen({
        kind: "preview",
        rawPath: result.path,
        projectName: projectNameFor(result.path),
      });
    } catch (e) {
      setError(typeof e === "string" ? e : "No se pudo detener la grabación.");
      setBusy(false);
    }
  }, [setScreen]);

  return (
    <div className="stack">
      <div className="card stack">
        <div className="row">
          <span className="recording-dot" />
          <strong>Grabando…</strong>
        </div>
        <p className="muted">
          La barra de control flota sobre la pantalla y no aparece en el vídeo. Cuando termines,
          detén la grabación.
        </p>
        <button className="btn btn--danger btn--block" onClick={onStop} disabled={busy}>
          {busy ? "Deteniendo…" : "■ Detener"}
        </button>
        {warning && <p className="muted">{warning}</p>}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

// --- Preview: raw clip + go to editor. --------------------------------------

function Preview({
  rawPath,
  projectName,
  setScreen,
}: {
  rawPath: string;
  projectName: string;
  setScreen: (s: Screen) => void;
}) {
  const io = useMemo(() => createEditorIO({ rawPath, projectName }), [rawPath, projectName]);
  useEffect(() => io.dispose, [io]);
  const src = useMemo(() => io.io.resolveMediaSrc(rawPath), [io, rawPath]);

  return (
    <div className="stack">
      <div className="card stack">
        <span className="field__label">Grabación lista</span>
        <video src={src} controls playsInline style={{ maxHeight: 280 }} />
        <div className="row">
          <button
            className="btn btn--primary"
            onClick={() => setScreen({ kind: "editing", rawPath, projectName, manifest: null })}
          >
            Editar
          </button>
          <button className="btn" onClick={() => revealItemInDir(rawPath).catch(() => {})}>
            Revelar en Finder
          </button>
          <div className="app__spacer" />
          <button className="btn btn--ghost btn--sm" onClick={() => setScreen({ kind: "setup" })}>
            Nueva grabación
          </button>
        </div>
      </div>

      <Transcribe rawPath={rawPath} projectName={projectName} />
    </div>
  );
}

// --- Transcribe: local whisper.cpp transcription (FR-107). -------------------

const LANGUAGES: { value: string; label: string }[] = [
  { value: "", label: "Detectar idioma" },
  { value: "es", label: "Español" },
  { value: "en", label: "Inglés" },
];

function Transcribe({ rawPath, projectName }: { rawPath: string; projectName: string }) {
  const [lang, setLang] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runningRef = useRef(false);

  // Live progress (0..100) while a transcription runs.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void listen<number>("transcribe-progress", (e) => {
      if (!runningRef.current) return;
      const pct = typeof e.payload === "number" ? e.payload : 0;
      setProgress(Math.max(0, Math.min(100, pct)));
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const onTranscribe = useCallback(async () => {
    setError(null);
    setText(null);
    setProgress(0);
    setBusy(true);
    runningRef.current = true;
    try {
      const result = await transcribeRecording(rawPath, lang === "" ? null : lang);
      setText(result);
      await saveTranscript(projectName, rawPath, result).catch(() => {});
    } catch (e) {
      setError(typeof e === "string" ? e : "No se pudo transcribir.");
    } finally {
      runningRef.current = false;
      setBusy(false);
    }
  }, [rawPath, projectName, lang]);

  return (
    <div className="card stack">
      <span className="field__label">Transcripción (local, sin nube)</span>
      <div className="row">
        <select value={lang} onChange={(e) => setLang(e.target.value)} disabled={busy}>
          {LANGUAGES.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
        <div className="app__spacer" />
        <button className="btn btn--primary" onClick={onTranscribe} disabled={busy}>
          {busy ? "Transcribiendo…" : "Transcribir"}
        </button>
      </div>

      {busy && (
        <div className="progress">
          <div className="progress__bar" style={{ width: `${progress}%` }} />
        </div>
      )}

      {text !== null && (
        <textarea
          className="transcript"
          value={text}
          readOnly
          rows={6}
          aria-label="Transcripción"
        />
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}

// --- Edit: mount the editor with the Tauri IO + export/reveal wiring. --------

function EditScreen({
  rawPath,
  projectName,
  initialManifest,
  setScreen,
}: {
  rawPath: string;
  projectName: string;
  initialManifest: EditManifest | null;
  setScreen: (s: Screen) => void;
}) {
  const [render, setRender] = useState<RenderState>({
    renderStatus: null,
    renderedSrc: null,
    renderError: null,
    progress: 0,
    renderedPath: null,
  });

  const { io } = useMemo(
    () => createEditorIO({ rawPath, projectName, onProgress: setRender }),
    [rawPath, projectName],
  );

  return (
    <div className="stack">
      <div className="row">
        <button className="btn btn--ghost btn--sm" onClick={() => setScreen({ kind: "preview", rawPath, projectName })}>
          ← Volver
        </button>
        <div className="app__spacer" />
        <span className="muted">Proyecto: {projectName}</span>
      </div>

      <div className="editor-host">
        <Editor
          io={io}
          rawPath={rawPath}
          initialManifest={initialManifest}
          initialRenderStatus={null}
          initialRenderedSrc={null}
        />
      </div>

      {render.renderStatus === "processing" && (
        <div className="card stack">
          <span className="field__label">Exportando MP4… {Math.round(render.progress)}%</span>
          <div className="progress">
            <div className="progress__bar" style={{ width: `${render.progress}%` }} />
          </div>
        </div>
      )}

      {render.renderStatus === "failed" && render.renderError && (
        <p className="error">{render.renderError}</p>
      )}

      {render.renderStatus === "ready" && render.renderedSrc && (
        <div className="card stack">
          <span className="ok">MP4 exportado</span>
          <video src={render.renderedSrc} controls playsInline style={{ maxHeight: 260 }} />
          <button
            className="btn"
            onClick={() => revealItemInDir(render.renderedPath ?? rawPath).catch(() => {})}
          >
            Revelar en Finder
          </button>
        </div>
      )}
    </div>
  );
}

// --- About / branding (FR-108). ---------------------------------------------

function About({ onClose }: { onClose: () => void }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
      onClick={onClose}
    >
      <div className="card stack" style={{ maxWidth: 340 }} onClick={(e) => e.stopPropagation()}>
        <span className="app__brand" style={{ fontSize: 18 }}>
          {BRAND.productName}
        </span>
        <div className="about">
          <span>Grabador de pantalla local-first. Graba, edita y exporta — sin nube, sin marca de agua.</span>
          <a href={BRAND.website} onClick={(e) => { e.preventDefault(); openUrl(BRAND.website).catch(() => {}); }}>
            {BRAND.website.replace(/^https:\/\//, "")}
          </a>
          <span style={{ marginTop: 8 }}>Open source · MIT</span>
        </div>
        <button className="btn btn--block" onClick={onClose}>
          Cerrar
        </button>
      </div>
    </div>
  );
}
