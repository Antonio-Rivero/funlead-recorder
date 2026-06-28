import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import "./camera.css";

// Cross-window event bus (main window drives the blur, the bubble obeys and
// reports its status back so the main chip stays in sync).
const EV_SET_BLUR = "camera:set-blur";
const EV_BLUR_STATUS = "camera:blur-status";
const EV_READY = "camera:ready";
// Bubble -> main: getUserMedia failed, so the main window can un-stick the toggle.
const EV_CAM_ERROR = "camera:error";
// Resize the bubble to a preset (logical px), sent by the floating control bar.
const EV_SET_SIZE = "camera:set-size";

const MIN_SIZE = 120;
const MAX_SIZE = 480;
const STEP = 40;

// Background-blur segmentation runs off MediaPipe Tasks Vision, loaded from the
// CDN on first use (Tauri CSP is open). The wasm + model are cached by WKWebView
// after the first download, so the blur keeps working offline afterwards.
const MP_VERSION = "0.10.35";
const TASKS_VISION_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`;
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";

// Cap the segmentation/draw loop well below the display rate. The bubble is tiny
// and the per-frame segmentation is the CPU cost, so ~15fps keeps fans quiet
// without a visible difference inside a small circle.
const BLUR_FPS = 15;
const BLUR_FRAME_MS = 1000 / BLUR_FPS;
const BLUR_RADIUS_PX = 12;
// Confidence above this counts as "person" (sharp); below it gets blurred.
const PERSON_THRESHOLD = 0.5;

type BlurStatus = "off" | "loading" | "on" | "error";

// Minimal shape of the bits of @mediapipe/tasks-vision we use. The library is
// imported dynamically from the CDN, so there is no bundled type to import.
interface MPMask {
  width: number;
  height: number;
  getAsFloat32Array(): Float32Array;
}
interface ImageSegmenterResult {
  confidenceMasks?: MPMask[];
}
interface MPImageSegmenter {
  segmentForVideo(
    video: HTMLVideoElement,
    timestampMs: number,
    callback: (result: ImageSegmenterResult) => void,
  ): void;
  close(): void;
}
interface TasksVisionModule {
  FilesetResolver: {
    forVisionTasks(wasmPath: string): Promise<unknown>;
  };
  ImageSegmenter: {
    createFromOptions(
      fileset: unknown,
      options: Record<string, unknown>,
    ): Promise<MPImageSegmenter>;
  };
}

async function createSegmenter(): Promise<MPImageSegmenter> {
  const mp = (await import(/* @vite-ignore */ TASKS_VISION_URL)) as unknown as TasksVisionModule;
  const fileset = await mp.FilesetResolver.forVisionTasks(WASM_URL);
  const common: Record<string, unknown> = {
    runningMode: "VIDEO",
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  };
  try {
    return await mp.ImageSegmenter.createFromOptions(fileset, {
      ...common,
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
    });
  } catch {
    // Some WebViews lack a usable WebGL delegate; fall back to CPU.
    return await mp.ImageSegmenter.createFromOptions(fileset, {
      ...common,
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
    });
  }
}

function CameraBubble() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blurOn, setBlurOn] = useState(false);
  const [blurStatus, setBlurStatus] = useState<BlurStatus>("off");
  // Selfie mirror (default on); synced from Ajustes via settings + live event.
  // Selfie mirror on by default (the OSS has no settings store yet; Fase 3).
  const mirror = true;

  const segmenterRef = useRef<MPImageSegmenter | null>(null);
  const rafRef = useRef<number | null>(null);
  // Offscreen scratch canvases, created once and reused every frame.
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const personCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastFrameRef = useRef(0);
  // segmentForVideo needs strictly increasing timestamps.
  const tsRef = useRef(0);

  // Keeps the window square (so it stays circular) while clamping to the same
  // bounds enforced by the native min/max inner size.
  const resize = (delta: number) => {
    const win = getCurrentWindow();
    void win.innerSize().then((current) => {
      const factor = window.devicePixelRatio || 1;
      const logical = current.width / factor;
      const next = Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(logical) + delta));
      void win.setSize(new LogicalSize(next, next));
    });
  };

  // Stop the drag region from swallowing the click on the overlay buttons.
  const stopDrag = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  // Composites one frame: blurred background fills the circle, the segmented
  // person is drawn sharp on top. Runs inside segmentForVideo's callback, where
  // the mask is valid.
  const compositeBlur = useCallback(
    (canvas: HTMLCanvasElement, video: HTMLVideoElement, result: ImageSegmenterResult) => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const w = canvas.width;
      const h = canvas.height;

      // Blurred background fills the whole canvas first.
      ctx.save();
      ctx.filter = `blur(${BLUR_RADIUS_PX}px)`;
      ctx.drawImage(video, 0, 0, w, h);
      ctx.restore();

      const mask = result.confidenceMasks?.[0];
      if (!mask) return; // no mask this frame → leave the blurred background

      const mw = mask.width;
      const mh = mask.height;
      const data = mask.getAsFloat32Array();

      // Build (or resize) the offscreen canvases lazily.
      let maskCanvas = maskCanvasRef.current;
      if (!maskCanvas) {
        maskCanvas = document.createElement("canvas");
        maskCanvasRef.current = maskCanvas;
      }
      if (maskCanvas.width !== mw || maskCanvas.height !== mh) {
        maskCanvas.width = mw;
        maskCanvas.height = mh;
      }
      let personCanvas = personCanvasRef.current;
      if (!personCanvas) {
        personCanvas = document.createElement("canvas");
        personCanvasRef.current = personCanvas;
      }
      if (personCanvas.width !== w || personCanvas.height !== h) {
        personCanvas.width = w;
        personCanvas.height = h;
      }

      const maskCtx = maskCanvas.getContext("2d");
      const personCtx = personCanvas.getContext("2d");
      if (!maskCtx || !personCtx) return;

      // Turn the confidence mask into a white silhouette with a soft alpha edge:
      // person → opaque, background → transparent.
      const stencil = maskCtx.createImageData(mw, mh);
      const px = stencil.data;
      for (let i = 0; i < data.length; i++) {
        const conf = data[i];
        const o = i * 4;
        px[o] = 255;
        px[o + 1] = 255;
        px[o + 2] = 255;
        // Soft matte near the threshold, hard cut elsewhere, for a clean edge.
        px[o + 3] = conf >= PERSON_THRESHOLD ? 255 : Math.round(Math.max(0, conf) * 255);
      }
      maskCtx.putImageData(stencil, 0, 0);

      // Sharp video clipped to the person silhouette.
      personCtx.clearRect(0, 0, w, h);
      personCtx.drawImage(video, 0, 0, w, h);
      personCtx.globalCompositeOperation = "destination-in";
      personCtx.drawImage(maskCanvas, 0, 0, w, h);
      personCtx.globalCompositeOperation = "source-over";

      ctx.drawImage(personCanvas, 0, 0);
    },
    [],
  );

  const drawBlurFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const segmenter = segmenterRef.current;
    if (!video || !canvas || !segmenter) {
      rafRef.current = requestAnimationFrame(drawBlurFrame);
      return;
    }

    const now = performance.now();
    if (now - lastFrameRef.current < BLUR_FRAME_MS || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(drawBlurFrame);
      return;
    }
    lastFrameRef.current = now;

    const w = video.videoWidth;
    const h = video.videoHeight;
    if (w === 0 || h === 0) {
      rafRef.current = requestAnimationFrame(drawBlurFrame);
      return;
    }
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    let ts = Math.round(now);
    if (ts <= tsRef.current) ts = tsRef.current + 1;
    tsRef.current = ts;

    try {
      segmenter.segmentForVideo(video, ts, (result) => {
        compositeBlur(canvas, video, result);
      });
    } catch {
      // A transient segmentation failure shouldn't kill the loop; skip the frame.
    }
    rafRef.current = requestAnimationFrame(drawBlurFrame);
  }, [compositeBlur]);

  // Acquire the camera stream once, resiliently. Switching cameras closes+reopens
  // this bubble, and external webcams (a) get a fresh deviceId when (un)plugged, so
  // a stale `exact` id throws OverconstrainedError, and (b) are slower to release,
  // so a reopen can briefly hit NotReadableError ("busy"). Handle both instead of
  // failing: fall back to the default camera on a stale id, and retry on busy.
  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;

    const deviceId = new URLSearchParams(window.location.search).get("deviceId");

    const open = async (): Promise<MediaStream> => {
      const wanted: MediaTrackConstraints = deviceId
        ? { deviceId: { exact: deviceId } }
        : { facingMode: "user" };
      try {
        return await navigator.mediaDevices.getUserMedia({ video: wanted, audio: false });
      } catch (e) {
        const name = e instanceof DOMException ? e.name : "";
        if (deviceId && (name === "OverconstrainedError" || name === "NotFoundError")) {
          // The selected id is gone/stale -> use whatever camera is available.
          return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        }
        throw e;
      }
    };

    const acquire = async () => {
      const MAX_ATTEMPTS = 4;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (cancelled) return;
        try {
          const media = await open();
          if (cancelled) {
            media.getTracks().forEach((t) => t.stop());
            return;
          }
          stream = media;
          if (videoRef.current) videoRef.current.srcObject = media;
          setError(null);
          return;
        } catch (e) {
          const name = e instanceof DOMException ? e.name : "";
          const busy = name === "NotReadableError" || name === "AbortError";
          if (busy && attempt < MAX_ATTEMPTS - 1) {
            await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
            continue;
          }
          if (cancelled) return;
          const msg =
            name === "NotAllowedError"
              ? "Permiso de cámara denegado. Actívalo en Ajustes del Sistema → Privacidad → Cámara."
              : busy
                ? "La cámara está ocupada por otra app o tardó en responder. Ciérrala y reintenta."
                : name === "OverconstrainedError" || name === "NotFoundError"
                  ? "No se encontró la cámara seleccionada."
                  : "No se pudo abrir la cámara.";
          setError(msg);
          // Tell the main window so it un-sticks the camera toggle and shows the error.
          void emit(EV_CAM_ERROR, msg);
          return;
        }
      }
    };

    void acquire();

    return () => {
      cancelled = true;
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  // Start/stop the blur pipeline when the toggle flips. The segmenter is created
  // lazily on first enable and kept for later toggles; the rAF loop is what
  // actually starts and stops.
  useEffect(() => {
    if (!blurOn) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      setBlurStatus("off");
      return;
    }

    let cancelled = false;
    setBlurStatus("loading");
    void (async () => {
      try {
        if (!segmenterRef.current) {
          segmenterRef.current = await createSegmenter();
        }
        if (cancelled) return;
        setBlurStatus("on");
        lastFrameRef.current = 0;
        rafRef.current = requestAnimationFrame(drawBlurFrame);
      } catch {
        if (cancelled) return;
        setBlurStatus("error");
        setBlurOn(false);
      }
    })();

    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [blurOn, drawBlurFrame]);

  // Release the segmenter on unmount.
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      segmenterRef.current?.close();
      segmenterRef.current = null;
    };
  }, []);

  // The main window owns the blur toggle. Obey its set-blur events and announce
  // we're ready on mount so it can re-sync a freshly (re)opened bubble.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<{ on: boolean }>(EV_SET_BLUR, (e) => {
      setBlurOn(Boolean(e.payload?.on));
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    void emit(EV_READY);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Report the blur status back to the main window so its chip reflects
  // loading / on / off / error.
  useEffect(() => {
    void emit(EV_BLUR_STATUS, blurStatus);
  }, [blurStatus]);

  // Resize to a preset size from the floating control bar (kept square so the
  // bubble stays circular; clamped to the same bounds as the +/- buttons).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<number>(EV_SET_SIZE, (e) => {
      const px = Math.max(MIN_SIZE, Math.min(MAX_SIZE, Number(e.payload)));
      if (!Number.isFinite(px)) return;
      void getCurrentWindow().setSize(new LogicalSize(px, px));
    }).then((fn) => (cancelled ? fn() : (unlisten = fn)));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // data-tauri-drag-region makes the whole bubble draggable on a decoration-less
  // window. The OS handles resize via the resizable window edges.
  return (
    <div
      className={`bubble${mirror ? " mirror" : ""}`}
      data-tauri-drag-region
    >
      {error ? (
        <div className="bubble-error">{error}</div>
      ) : (
        <>
          <video ref={videoRef} autoPlay playsInline muted />
          {blurOn && <canvas ref={canvasRef} className="bubble-canvas" />}
        </>
      )}

      {!error && (
        <div className="bubble-resize">
          <button
            type="button"
            aria-label="Reducir cámara"
            onMouseDown={stopDrag}
            onClick={() => resize(-STEP)}
          >
            −
          </button>
          <button
            type="button"
            aria-label="Agrandar cámara"
            onMouseDown={stopDrag}
            onClick={() => resize(STEP)}
          >
            +
          </button>
        </div>
      )}
    </div>
  );
}

ReactDOM.createRoot(
  document.getElementById("camera-root") as HTMLElement,
).render(
  <React.StrictMode>
    <CameraBubble />
  </React.StrictMode>,
);
