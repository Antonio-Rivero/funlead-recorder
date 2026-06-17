"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import { DeviceSelector } from "./DeviceSelector";
import { RecordingPreview } from "./RecordingPreview";

// In-browser recorder (FR-203): screen / camera / screen+camera via MediaRecorder
// (webm). On stop it uploads through the W1 handshake — the browser uploads
// straight to Vercel Blob (/api/recordings/upload), then registers the row
// (POST /api/recordings). No CRM coupling: no org/brand, no app deep-link, no
// API tokens.

type RecordingMode = "screen" | "camera" | "screen+camera";
type RecorderState = "idle" | "recording" | "uploading" | "done";

export function Recorder() {
  const router = useRouter();
  const [mode, setMode] = useState<RecordingMode>("screen");
  const [micId, setMicId] = useState("");
  const [cameraId, setCameraId] = useState("");
  const [title, setTitle] = useState("");
  const [state, setState] = useState<RecorderState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [shareUrl, setShareUrl] = useState("");
  const [error, setError] = useState("");
  const [uploadProgress, setUploadProgress] = useState(0);
  // 3-2-1 countdown before recording (toggle persisted in localStorage).
  const [countdown, setCountdown] = useState<number | null>(null);
  const [countdownEnabled, setCountdownEnabled] = useState(true);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("fl_recorder_countdown");
      if (saved !== null) setCountdownEnabled(saved === "1");
    } catch {
      // localStorage blocked → default true.
    }
  }, []);

  function toggleCountdown(next: boolean) {
    setCountdownEnabled(next);
    try {
      window.localStorage.setItem("fl_recorder_countdown", next ? "1" : "0");
    } catch {
      // No persistence — not fatal.
    }
  }

  // Shows 3 → 2 → 1 (1s each) and resolves when done.
  function runCountdown(): Promise<void> {
    return new Promise((resolve) => {
      let n = 3;
      setCountdown(n);
      const iv = setInterval(() => {
        n -= 1;
        if (n <= 0) {
          clearInterval(iv);
          setCountdown(null);
          resolve();
        } else {
          setCountdown(n);
        }
      }, 1000);
    });
  }

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedRef = useRef(0);

  // Floating camera (Loom-style): the camera lives as a real always-on-top window
  // over the whole screen and gets captured because the user records the full
  // screen — it is NOT composited into anything.
  const [floatingCamActive, setFloatingCamActive] = useState(false);
  const [floatingCamMsg, setFloatingCamMsg] = useState("");
  const floatingCamStreamRef = useRef<MediaStream | null>(null);
  const previewVideoElRef = useRef<HTMLVideoElement | null>(null);
  const floatingCamVideoElRef = useRef<HTMLVideoElement | null>(null);
  const pipWindowRef = useRef<Window | null>(null);
  const usedVideoPipRef = useRef(false);
  const [camPreviewReady, setCamPreviewReady] = useState(false);

  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);

  // Tears down the floating window/video only. The camera stream stays alive so
  // the inline preview can resume; it is stopped by stopCameraPreview (mode
  // change / unmount) or stopAllStreams (recording finished).
  const closeFloatingCamera = useCallback(() => {
    const video = floatingCamVideoElRef.current;
    if (video) {
      const isPreview = video === previewVideoElRef.current;
      try {
        if (usedVideoPipRef.current && document.pictureInPictureElement === video) {
          void document.exitPictureInPicture().catch(() => {});
        }
      } catch {
        // Already left PiP — ignore.
      }
      if (!isPreview) {
        video.srcObject = null;
        video.remove();
      }
      floatingCamVideoElRef.current = null;
    }
    if (pipWindowRef.current) {
      try {
        pipWindowRef.current.close();
      } catch {
        // Window already closed — ignore.
      }
      pipWindowRef.current = null;
    }
    usedVideoPipRef.current = false;
    setFloatingCamActive(false);
  }, []);

  const stopCameraPreview = useCallback(() => {
    closeFloatingCamera();
    floatingCamStreamRef.current?.getTracks().forEach((t) => t.stop());
    floatingCamStreamRef.current = null;
    if (previewVideoElRef.current) previewVideoElRef.current.srcObject = null;
    setCamPreviewReady(false);
    setFloatingCamMsg("");
  }, [closeFloatingCamera]);

  const stopAllStreams = useCallback(() => {
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    setScreenStream(null);
    setCameraStream(null);
    if (timerRef.current) clearInterval(timerRef.current);
    stopCameraPreview();
  }, [stopCameraPreview]);

  function buildFloatingCamVideo(cam: MediaStream): HTMLVideoElement {
    const video = document.createElement("video");
    video.srcObject = cam;
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.style.width = "100%";
    video.style.height = "100%";
    video.style.objectFit = "cover";
    video.style.transform = "scaleX(-1)"; // selfie mirror
    return video;
  }

  function camErrorMsg(err: unknown): string {
    if (err instanceof Error) {
      if (err.name === "NotAllowedError")
        return "Camera permission denied. Allow it in the browser and in System Settings → Privacy → Camera.";
      if (err.name === "NotReadableError" || err.name === "AbortError")
        return "The camera is in use by another app. Close it and try again.";
      if (err.name === "NotFoundError" || err.name === "OverconstrainedError")
        return "No camera found.";
    }
    return "Could not access the camera.";
  }

  const acquireCameraPreview = useCallback(async () => {
    const existing = floatingCamStreamRef.current;
    if (existing && existing.getVideoTracks().some((t) => t.readyState === "live")) {
      const video = previewVideoElRef.current;
      if (video && video.srcObject !== existing) {
        video.srcObject = existing;
        void video.play();
      }
      setCamPreviewReady(true);
      return;
    }
    setFloatingCamMsg("");
    const cameraConstraints: MediaTrackConstraints = {
      frameRate: { ideal: 30, min: 24 },
      width: { ideal: 640 },
      height: { ideal: 640 },
    };
    if (cameraId) cameraConstraints.deviceId = { exact: cameraId };
    let cam: MediaStream;
    try {
      cam = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints, audio: false });
    } catch (err) {
      setFloatingCamMsg(camErrorMsg(err));
      setCamPreviewReady(false);
      return;
    }
    floatingCamStreamRef.current = cam;
    const video = previewVideoElRef.current;
    if (video) {
      video.srcObject = cam;
      void video.play();
    }
    setCamPreviewReady(true);
  }, [cameraId]);

  async function showFloatingCamera() {
    setFloatingCamMsg("");
    const preview = previewVideoElRef.current;
    const cam = floatingCamStreamRef.current;
    if (!preview || !cam) {
      setFloatingCamMsg("The camera isn't ready yet. Wait a moment and try again.");
      return;
    }

    const docPip = window.documentPictureInPicture;

    if (docPip) {
      let pipWindow: Window;
      try {
        pipWindow = await docPip.requestWindow({ width: 220, height: 220 });
      } catch {
        setFloatingCamMsg("Could not open the floating window. Click the button again.");
        return;
      }
      pipWindowRef.current = pipWindow;
      usedVideoPipRef.current = false;
      pipWindow.addEventListener("pagehide", () => closeFloatingCamera(), { once: true });

      const video = buildFloatingCamVideo(cam);
      floatingCamVideoElRef.current = video;
      const body = pipWindow.document.body;
      body.style.margin = "0";
      body.style.background = "#000";
      body.style.overflow = "hidden";
      const wrapper = pipWindow.document.createElement("div");
      wrapper.style.width = "100%";
      wrapper.style.height = "100%";
      wrapper.style.borderRadius = "16px";
      wrapper.style.overflow = "hidden";
      wrapper.appendChild(video);
      body.appendChild(wrapper);
      void video.play();
      setFloatingCamActive(true);
      return;
    }

    if (!("requestPictureInPicture" in preview)) {
      setFloatingCamMsg("Your browser doesn't support the floating camera. Use Chrome, Edge or Safari.");
      return;
    }
    try {
      await preview.requestPictureInPicture();
      floatingCamVideoElRef.current = preview;
      usedVideoPipRef.current = true;
      preview.addEventListener("leavepictureinpicture", () => closeFloatingCamera(), { once: true });
      setFloatingCamActive(true);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "NotAllowedError") {
        setFloatingCamMsg("Could not open the floating window. Click the button again (it must be a direct click).");
      } else {
        setFloatingCamMsg("Could not open the floating camera window.");
      }
    }
  }

  // Acquire the camera while idle in screen+camera mode. It must stay live through
  // idle→recording because the floating camera (Safari Video PiP / Chrome Document
  // PiP) feeds off this same stream while recording — so this MUST NOT stop it on
  // cleanup.
  useEffect(() => {
    if (mode === "screen+camera" && state === "idle") {
      void acquireCameraPreview();
    }
  }, [mode, state, acquireCameraPreview]);

  // Stop the camera only when leaving screen+camera mode or on unmount — never on
  // idle→recording (recording end stops it via stopAllStreams). Keyed on `mode`
  // alone so a state change never triggers it.
  useEffect(() => {
    if (mode !== "screen+camera") return undefined;
    return () => stopCameraPreview();
  }, [mode, stopCameraPreview]);

  async function startRecording() {
    setError("");
    chunksRef.current = [];

    try {
      let recordStream: MediaStream;

      if (mode === "screen" || mode === "screen+camera") {
        const screen = await navigator.mediaDevices.getDisplayMedia({
          video: {
            frameRate: { ideal: 60 },
            width: { ideal: 3840 },
            height: { ideal: 2160 },
          },
          audio: true,
        });
        screenStreamRef.current = screen;
        setScreenStream(screen);

        screen.getVideoTracks()[0]?.addEventListener("ended", () => {
          stopRecording();
        });

        const videoTrack = screen.getVideoTracks()[0];
        const tracks: MediaStreamTrack[] = videoTrack ? [videoTrack] : [];

        if (micId) {
          const micStream = await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: { exact: micId } },
          });
          micStreamRef.current = micStream;
          micStream.getAudioTracks().forEach((t) => tracks.push(t));
        } else {
          screen.getAudioTracks().forEach((t) => tracks.push(t));
        }

        recordStream = new MediaStream(tracks);
      } else {
        const cameraConstraints: MediaTrackConstraints = {
          frameRate: { ideal: 60, min: 30 },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        };
        if (cameraId) cameraConstraints.deviceId = { exact: cameraId };
        const camera = await navigator.mediaDevices.getUserMedia({
          video: cameraConstraints,
          audio: micId ? { deviceId: { exact: micId } } : true,
        });
        setCameraStream(camera);

        recordStream = camera;
        if (micId) {
          const micStream = await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: { exact: micId } },
          });
          camera.getAudioTracks().forEach((t) => t.stop());
          recordStream = new MediaStream([
            ...camera.getVideoTracks(),
            ...micStream.getAudioTracks(),
          ]);
        }
      }

      const codecs = [
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp9",
        "video/webm;codecs=vp8,opus",
        "video/webm;codecs=vp8",
        "video/webm",
        "",
      ];
      const mimeType = codecs.find((c) => c === "" || MediaRecorder.isTypeSupported(c)) || "";
      const videoBitsPerSecond = mode === "camera" ? 5_000_000 : 10_000_000;

      const recorderOptions: MediaRecorderOptions = {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond,
      };
      const mediaRecorder = new MediaRecorder(recordStream, recorderOptions);

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mediaRecorder.onstop = () => {
        void handleRecordingComplete();
      };

      // Countdown AFTER permissions/streams (so it doesn't consume the user
      // gesture getDisplayMedia/getUserMedia require) and BEFORE recording.
      if (countdownEnabled) await runCountdown();

      mediaRecorder.start(250);
      mediaRecorderRef.current = mediaRecorder;
      setState("recording");

      elapsedRef.current = 0;
      setElapsed(0);
      timerRef.current = setInterval(() => {
        elapsedRef.current += 1;
        setElapsed(elapsedRef.current);
      }, 1000);
    } catch (err: unknown) {
      stopAllStreams();
      if (err instanceof Error && err.name === "NotAllowedError") {
        setError("Permission denied. Allow access to your screen/camera.");
      } else {
        setError("Could not start recording. Check your device permissions.");
      }
    }
  }

  function stopRecording() {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    if (timerRef.current) clearInterval(timerRef.current);
  }

  async function handleRecordingComplete() {
    setState("uploading");
    const durationSec = elapsedRef.current;
    stopAllStreams();

    const blob = new Blob(chunksRef.current, { type: "video/webm" });
    if (blob.size === 0) {
      setError("The recording captured no data. Try again.");
      setState("idle");
      return;
    }

    try {
      const stamp = Date.now();
      const rand = Math.random().toString(36).slice(2, 8);
      const pathname = `recordings/uploads/${stamp}-${rand}.webm`;
      const result = await upload(pathname, blob, {
        access: "public",
        handleUploadUrl: "/api/recordings/upload",
        contentType: "video/webm",
        onUploadProgress: (p) => setUploadProgress(Math.round(p.percentage)),
      });

      const reg = await fetch("/api/recordings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          blobUrl: result.url,
          blobPathname: result.pathname,
          title: title.trim() || "Untitled recording",
          mode,
          durationSec,
          sizeBytes: blob.size,
          mimeType: "video/webm",
        }),
      });
      if (!reg.ok) throw new Error("registration failed");
      const { shareToken } = (await reg.json()) as { shareToken: string };
      setShareUrl(`${window.location.origin}/v/${shareToken}`);
      setState("done");
      router.refresh();
    } catch {
      setError("Upload failed. Try again.");
      setState("idle");
    }
  }

  function reset() {
    setState("idle");
    setShareUrl("");
    setElapsed(0);
    elapsedRef.current = 0;
    setUploadProgress(0);
    setError("");
    setTitle("");
    chunksRef.current = [];
  }

  function formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60).toString().padStart(2, "0");
    const s = (seconds % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }

  const [copied, setCopied] = useState(false);
  async function copyToClipboard() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked in insecure contexts — ignore.
    }
  }

  // ----- RENDER -----

  if (state === "done") {
    return (
      <div className="flex items-center justify-center p-4">
        <div className="w-full max-w-md space-y-6 text-center">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full border border-emerald-500/20 bg-emerald-500/10 text-emerald-600">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M3 8.5L6.5 12L13 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="space-y-1">
            <h2 className="text-lg font-semibold text-[var(--foreground)]">Recording uploaded</h2>
            <p className="text-sm text-[var(--muted)]">Share the link below</p>
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--card)] p-2.5">
            <input
              readOnly
              value={shareUrl}
              className="flex-1 truncate bg-transparent text-sm text-[var(--muted)] outline-none"
            />
            <button
              onClick={copyToClipboard}
              className="shrink-0 rounded-md bg-[var(--primary)] px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <button
            onClick={reset}
            className="text-sm text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
          >
            Record another
          </button>
        </div>
      </div>
    );
  }

  if (state === "uploading") {
    return (
      <div className="flex items-center justify-center p-4">
        <div className="w-full max-w-md space-y-5 text-center">
          <p className="text-xs font-medium uppercase tracking-wider text-[var(--muted)]">Uploading</p>
          <div className="h-1.5 w-full overflow-hidden rounded-full border border-[var(--border)] bg-[var(--card)]">
            <div
              className="h-1.5 rounded-full bg-[var(--primary)] transition-all duration-500 ease-out"
              style={{ width: `${uploadProgress}%` }}
            />
          </div>
          <p className="font-mono text-sm tabular-nums text-[var(--muted)]">{uploadProgress}%</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center gap-8 p-4">
      {countdown !== null && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-[var(--background)]/90 backdrop-blur-md">
          <span className="text-[140px] font-bold leading-none tabular-nums text-[var(--foreground)]">
            {countdown}
          </span>
          <span className="text-xs font-medium uppercase tracking-[0.2em] text-[var(--muted)]">
            Starting
          </span>
        </div>
      )}

      {state === "recording" && (mode === "screen" || mode === "screen+camera") && (
        <RecordingPreview mode="screen" screenStream={screenStream} cameraStream={null} />
      )}
      {state === "recording" && mode === "camera" && (
        <RecordingPreview mode={mode} screenStream={screenStream} cameraStream={cameraStream} />
      )}

      {/* Floating-camera block (screen+camera). Mounted in BOTH idle and recording
          so the preview <video> node never unmounts (Safari Video PiP reuses this
          exact node). During recording it's pushed off-screen, not unmounted. */}
      {mode === "screen+camera" && (
        <div
          className={
            state === "idle"
              ? "w-full max-w-md"
              : "pointer-events-none fixed left-[-10000px] top-0 h-px w-px overflow-hidden opacity-0"
          }
          aria-hidden={state !== "idle"}
        >
          <div className="space-y-2 rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
            <div className="flex items-center gap-3">
              <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-full border border-[var(--border)] bg-[var(--card-hover)]">
                <video
                  ref={(el) => {
                    previewVideoElRef.current = el;
                    if (el && floatingCamStreamRef.current && el.srcObject !== floatingCamStreamRef.current) {
                      el.srcObject = floatingCamStreamRef.current;
                      void el.play();
                    }
                  }}
                  autoPlay
                  muted
                  playsInline
                  className={`h-full w-full object-cover ${camPreviewReady && !floatingCamActive ? "" : "opacity-0"}`}
                  style={{ transform: "scaleX(-1)" }}
                />
                {!camPreviewReady && (
                  <span className="absolute inset-0 flex items-center justify-center text-[10px] text-[var(--muted)]">
                    Camera
                  </span>
                )}
                {floatingCamActive && (
                  <span className="absolute inset-0 flex items-center justify-center text-[10px] text-[var(--muted)]">
                    Floating
                  </span>
                )}
              </div>
              <p className="text-xs text-[var(--muted)]">
                The floating camera is an always-visible window you drag and resize over the whole
                screen. It appears in the video because you record the screen.
              </p>
            </div>
            {floatingCamActive ? (
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-sm font-medium text-[var(--foreground)]">
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />
                  Floating camera active
                </span>
                <button
                  onClick={closeFloatingCamera}
                  className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
                >
                  Close camera
                </button>
              </div>
            ) : (
              <button
                onClick={showFloatingCamera}
                className="w-full rounded-lg border border-[var(--primary)]/40 bg-[var(--primary)]/10 px-4 py-2 text-sm font-semibold text-[var(--primary)] transition-all hover:bg-[var(--primary)]/15"
              >
                Show floating camera
              </button>
            )}
            {floatingCamMsg && <p className="text-xs text-[var(--muted)]">{floatingCamMsg}</p>}
          </div>
        </div>
      )}

      <div className="w-full max-w-md space-y-6">
        {state === "idle" && (
          <>
            <div className="space-y-1.5">
              <label className="text-xs font-medium uppercase tracking-wider text-[var(--muted)]">
                Title
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Untitled recording"
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--foreground)] outline-none transition placeholder:text-[var(--muted)] focus:border-[var(--primary)]/50"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium uppercase tracking-wider text-[var(--muted)]">
                Mode
              </label>
              <div className="grid grid-cols-3 gap-1 rounded-lg border border-[var(--border)] bg-[var(--card)] p-1">
                {(
                  [
                    { value: "screen", label: "Screen" },
                    { value: "camera", label: "Camera" },
                    { value: "screen+camera", label: "Screen + Cam" },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setMode(opt.value)}
                    className={`rounded-md px-3 py-1.5 text-sm font-medium transition-all ${
                      mode === opt.value
                        ? "bg-[var(--primary)] text-white shadow-sm"
                        : "text-[var(--muted)] hover:bg-[var(--card-hover)] hover:text-[var(--foreground)]"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <DeviceSelector kind="audioinput" label="Microphone" value={micId} onChange={setMicId} />
            {(mode === "camera" || mode === "screen+camera") && (
              <DeviceSelector kind="videoinput" label="Camera" value={cameraId} onChange={setCameraId} />
            )}

            {mode === "screen+camera" && (
              <p className="text-xs text-[var(--muted)]">
                When recording, share your{" "}
                <span className="font-semibold text-[var(--foreground)]">entire screen</span> (not a
                single window or tab) so the floating camera shows in the video.
              </p>
            )}
          </>
        )}

        {error && <p className="text-center text-sm text-[var(--danger)]">{error}</p>}

        <div className="flex items-center justify-center gap-4">
          {state === "idle" && (
            <div className="flex flex-col items-center gap-3">
              <button
                onClick={startRecording}
                className="rounded-lg bg-[var(--primary)] px-8 py-2.5 text-sm font-semibold text-white shadow-lg shadow-[var(--primary)]/20 transition-all hover:opacity-90"
              >
                Start recording
              </button>
              <label className="flex cursor-pointer select-none items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-[var(--muted)] transition-colors hover:text-[var(--foreground)]">
                <input
                  type="checkbox"
                  checked={countdownEnabled}
                  onChange={(e) => toggleCountdown(e.target.checked)}
                  className="h-4 w-4 accent-[var(--primary)]"
                />
                3-2-1 countdown before recording
              </label>
            </div>
          )}

          {state === "recording" && (
            <>
              <span className="flex items-center gap-2 font-mono text-sm tabular-nums text-[var(--muted)]">
                <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
                {formatTime(elapsed)}
              </span>
              <button
                onClick={stopRecording}
                className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-6 py-2.5 text-sm font-medium text-[var(--foreground)] transition-all hover:bg-[var(--card-hover)]"
              >
                Stop
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
