"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";

/**
 * Owner upload control (FR-202): drag/picker for .webm/.mp4. Uses the W1 upload
 * handshake — the browser uploads straight to Vercel Blob (bypassing the 4.5 MB
 * serverless body limit) via /api/recordings/upload, then registers the Recording
 * row via POST /api/recordings.
 */
const ACCEPTED = ["video/webm", "video/mp4"];

function pickPathname(file: File): string {
  const ext = file.type === "video/mp4" ? "mp4" : "webm";
  const stamp = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `recordings/uploads/${stamp}-${rand}.${ext}`;
}

function videoDurationSec(file: File): Promise<number> {
  return new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(file);
      const video = document.createElement("video");
      video.preload = "metadata";
      const done = (sec: number) => {
        URL.revokeObjectURL(url);
        resolve(sec);
      };
      video.onloadedmetadata = () =>
        done(Number.isFinite(video.duration) ? Math.floor(video.duration) : 0);
      video.onerror = () => done(0);
      video.src = url;
    } catch {
      resolve(0);
    }
  });
}

export default function UploadRecording() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setError(null);
    if (!ACCEPTED.includes(file.type)) {
      setError("Only .webm or .mp4 files are supported.");
      return;
    }
    setBusy(true);
    try {
      const pathname = pickPathname(file);
      const durationSec = await videoDurationSec(file);

      const blob = await upload(pathname, file, {
        access: "public",
        handleUploadUrl: "/api/recordings/upload",
        contentType: file.type,
      });

      const res = await fetch("/api/recordings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          blobUrl: blob.url,
          blobPathname: blob.pathname,
          title: file.name.replace(/\.[^.]+$/, "") || "Untitled recording",
          mode: "screen",
          durationSec,
          sizeBytes: file.size,
          mimeType: file.type,
        }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(json?.error ?? "Could not register the recording.");
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void handleFile(file);
        }}
        className={`rounded-xl border-2 border-dashed p-6 text-center transition ${
          dragging ? "border-[var(--color-sky)] bg-sky-50" : "border-slate-300 bg-white"
        }`}
      >
        <p className="text-sm text-slate-600">
          {busy ? "Uploading…" : "Drag a video here, or"}{" "}
          {!busy && (
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="font-medium text-[var(--color-navy)] underline-offset-2 hover:underline"
            >
              choose a file
            </button>
          )}
        </p>
        <p className="mt-1 text-xs text-slate-400">.webm or .mp4</p>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED.join(",")}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />
      </div>
      {error && <p className="mt-2 text-sm text-[var(--danger)]">{error}</p>}
    </div>
  );
}
