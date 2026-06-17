"use client";

import { useEffect, useRef } from "react";

// Live preview of the stream being recorded (screen or camera-only).
interface RecordingPreviewProps {
  mode: "screen" | "camera";
  screenStream: MediaStream | null;
  cameraStream: MediaStream | null;
}

export function RecordingPreview({ mode, screenStream, cameraStream }: RecordingPreviewProps) {
  const screenVideoRef = useRef<HTMLVideoElement>(null);
  const cameraVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (screenVideoRef.current && screenStream) screenVideoRef.current.srcObject = screenStream;
  }, [screenStream]);

  useEffect(() => {
    if (cameraVideoRef.current && cameraStream) cameraVideoRef.current.srcObject = cameraStream;
  }, [cameraStream]);

  return (
    <div className="relative aspect-video w-full max-w-2xl overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-lg shadow-black/10">
      {mode === "screen" && (
        <video
          ref={screenVideoRef}
          autoPlay
          muted
          playsInline
          className="h-full w-full object-contain"
        />
      )}
      {mode === "camera" && (
        <video
          ref={cameraVideoRef}
          autoPlay
          muted
          playsInline
          className="h-full w-full object-contain"
          style={{ transform: "scaleX(-1)" }}
        />
      )}
    </div>
  );
}
