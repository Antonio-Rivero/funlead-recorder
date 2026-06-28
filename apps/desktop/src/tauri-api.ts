// Typed wrappers over the Rust commands registered in src-tauri/src/lib.rs.
// One thin layer so the UI never sprinkles raw `invoke` string keys around.
import { invoke } from "@tauri-apps/api/core";
import type { EditManifest } from "@funlead-recorder/editor";

export type DisplayInfo = { id: number; title: string };
export type InputDeviceInfo = { id: string; name: string };
export type StopResult = { path: string; mic_warning: string | null };
export type PermissionStatus = "granted" | "denied" | "unsupported";
export type Quality = "auto" | "720" | "1080" | "native";

export type ProjectDoc = { raw_path: string; manifest: EditManifest; transcript?: string | null };
export type ProjectInfo = { name: string; raw_path: string };

export const listDisplays = () => invoke<DisplayInfo[]>("list_displays");
export const listInputDevices = () => invoke<InputDeviceInfo[]>("list_input_devices");
export const checkPermission = () => invoke<PermissionStatus>("check_permission");
export const requestPermission = () => invoke<void>("request_permission");
export const ffmpegAvailable = () => invoke<boolean>("ffmpeg_available");
export const ensureFfmpeg = () => invoke<void>("ensure_ffmpeg");

export const startRecording = (args: {
  displayId: number;
  fps: number;
  micDeviceId: string | null;
  quality: Quality;
}) =>
  invoke<void>("start_recording", {
    displayId: args.displayId,
    fps: args.fps,
    micDeviceId: args.micDeviceId,
    quality: args.quality,
  });

export const stopRecording = () => invoke<StopResult>("stop_recording");

export const renderVideo = (rawPath: string, manifest: EditManifest) =>
  invoke<string>("render_video", { rawPath, manifest });

export const showControls = () => invoke<void>("show_controls_window");
export const hideControls = () => invoke<void>("hide_controls_window");
export const toggleCamera = (deviceId: string | null) =>
  invoke<boolean>("toggle_camera_window", { deviceId });
export const isCameraOpen = () => invoke<boolean>("is_camera_window_open");

export const saveProject = (name: string, rawPath: string, manifest: EditManifest) =>
  invoke<void>("save_project", { name, rawPath, manifest });
export const openProject = (name: string) => invoke<ProjectDoc>("open_project", { name });
export const listProjects = () => invoke<ProjectInfo[]>("list_projects");

/** Transcribes a recording locally with whisper.cpp. `lang` = ISO code (e.g. "es") or null for auto-detect. */
export const transcribeRecording = (rawPath: string, lang: string | null) =>
  invoke<string>("transcribe_recording", { rawPath, lang });
export const saveTranscript = (name: string, rawPath: string, transcript: string) =>
  invoke<void>("save_transcript", { name, rawPath, transcript });
