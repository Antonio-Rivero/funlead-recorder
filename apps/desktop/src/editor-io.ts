// Tauri implementation of the editor's I/O contract. The editor stays pure UI:
// it never knows about commands, events or paths — everything goes through here.
//
// Render status is held in memory and fed by the `render-progress` event
// (0..100) plus the resolution/rejection of the `render_video` command. The
// editor calls getStatus() on its own cadence; we never poll the network (there
// is none — everything is local ffmpeg).
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { EditManifest, EditorIO, RenderStatus } from "@funlead-recorder/editor";
import { renderVideo, saveProject } from "./tauri-api";

export type RenderState = RenderStatus & {
  progress: number;
  /** Absolute on-disk path of the exported MP4 (for reveal-in-Finder), else null. */
  renderedPath: string | null;
};

const IDLE: RenderState = {
  renderStatus: null,
  renderedSrc: null,
  renderError: null,
  progress: 0,
  renderedPath: null,
};

/**
 * Builds an EditorIO bound to one recording. `projectName` is the project the
 * editor autosaves into; `onProgress` lets the host show a live progress bar
 * from the same `render-progress` stream the status is built from.
 */
export function createEditorIO(args: {
  rawPath: string;
  projectName: string;
  onProgress?: (state: RenderState) => void;
}): { io: EditorIO; dispose: () => void } {
  let state: RenderState = { ...IDLE };
  let unlisten: UnlistenFn | null = null;

  const emit = () => args.onProgress?.({ ...state });
  const set = (patch: Partial<RenderState>) => {
    state = { ...state, ...patch };
    emit();
  };

  // Live progress while a render runs. The terminal states (ready/failed) are
  // set by the render() promise so a stray 100% event can't pre-empt them.
  void listen<number>("render-progress", (e) => {
    if (state.renderStatus !== "processing") return;
    const pct = typeof e.payload === "number" ? e.payload : 0;
    set({ progress: Math.max(0, Math.min(100, pct)) });
  }).then((fn) => {
    unlisten = fn;
  });

  const io: EditorIO = {
    async saveManifest(manifest: EditManifest) {
      await saveProject(args.projectName, args.rawPath, manifest);
    },

    async render(manifest: EditManifest) {
      // Persist the exact manifest we render, then enqueue the render. The editor
      // flips its own UI to "processing"; we mirror it so getStatus() agrees.
      await saveProject(args.projectName, args.rawPath, manifest);
      set({ renderStatus: "processing", renderedSrc: null, renderedPath: null, renderError: null, progress: 0 });
      renderVideo(args.rawPath, manifest)
        .then((outPath) => {
          set({
            renderStatus: "ready",
            renderedSrc: convertFileSrc(outPath),
            renderedPath: outPath,
            renderError: null,
            progress: 100,
          });
        })
        .catch((err: unknown) => {
          set({
            renderStatus: "failed",
            renderedSrc: null,
            renderedPath: null,
            renderError: typeof err === "string" ? err : "El render falló.",
            progress: 0,
          });
        });
    },

    async getStatus(): Promise<RenderStatus> {
      return {
        renderStatus: state.renderStatus,
        renderedSrc: state.renderedSrc,
        renderError: state.renderError,
      };
    },

    resolveMediaSrc(localPath: string) {
      return convertFileSrc(localPath);
    },
  };

  return {
    io,
    dispose: () => {
      if (unlisten) unlisten();
      unlisten = null;
    },
  };
}
