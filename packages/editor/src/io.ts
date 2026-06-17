/**
 * Editor I/O contract. The editor never calls fetch or knows about absolute
 * URLs — the host injects an implementation (Tauri commands in the desktop app;
 * HTTP in the Phase 2 web). Keeps the editor pure UI over the manifest.
 */
import type { EditManifest } from "./edit-manifest";

export type RenderStatus = {
  /** "processing" | "ready" | "failed" | null (not rendered yet). */
  renderStatus: string | null;
  /** Resolvable media source for the rendered MP4 when ready, else null. */
  renderedSrc: string | null;
  /** Human-readable reason when renderStatus is "failed". */
  renderError: string | null;
};

export type EditorIO = {
  /** Persist the manifest (autosave). Throws on failure. */
  saveManifest(manifest: EditManifest): Promise<void>;
  /** Persist the manifest and enqueue a render. Throws on failure. */
  render(manifest: EditManifest): Promise<void>;
  /** Current render state (the editor polls/refreshes as needed). */
  getStatus(): Promise<RenderStatus>;
  /** Turn a local media path into a source usable by a <video> element. */
  resolveMediaSrc(localPath: string): string;
};
