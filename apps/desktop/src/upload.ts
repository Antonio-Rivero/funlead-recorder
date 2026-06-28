// Subida de la grabación a la instancia web self-host del usuario (Fase 2b).
// El navegador (WebView) sube el .mp4 directo a Vercel Blob vía el handshake del
// SDK (esquivando el límite de 4.5 MB del serverless), autenticándose con el
// RECORDING_DESKTOP_TOKEN como Bearer; luego registra la fila Recording.

import { upload } from "@vercel/blob/client";
import { readFile } from "@tauri-apps/plugin-fs";

export interface UploadParams {
  baseUrl: string;
  token: string;
  /** Ruta absoluta del vídeo grabado (rawPath). */
  path: string;
  title: string;
  durationSec?: number;
  onProgress?: (percent: number) => void;
}

export interface UploadResult {
  shareUrl: string;
  shareToken: string;
}

/** Se lanza para que la UI diga "revisa la URL/token en Conexión". */
export class AuthError extends Error {}

const basename = (p: string): string => p.split(/[\\/]/).pop() || "grabacion.mp4";
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const isNetworkError = (msg: string): boolean =>
  /failed to fetch|load failed|network|err_internet|timed? *out|econn|enotfound|offline/i.test(
    msg,
  );

/** POST con reintento ante red/5xx; 4xx se devuelve tal cual (lo maneja el caller). */
async function postJsonWithRetry(
  url: string,
  init: RequestInit,
  attempts = 3,
): Promise<Response> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init);
      if (res.status >= 500 && i < attempts - 1) {
        await delay(500 * (i + 1));
        continue;
      }
      return res;
    } catch {
      if (i < attempts - 1) {
        await delay(500 * (i + 1));
        continue;
      }
    }
  }
  throw new Error(
    "No se pudo contactar con tu instancia para registrar la grabación (¿sin conexión?). El vídeo sigue guardado; reintenta.",
  );
}

export async function uploadRecording({
  baseUrl,
  token,
  path,
  title,
  durationSec,
  onProgress,
}: UploadParams): Promise<UploadResult> {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) throw new Error("Configura la URL de tu instancia en Conexión.");
  if (!token) throw new AuthError("Configura el token en Conexión.");

  const bytes = await readFile(path);
  if (bytes.byteLength === 0) throw new Error("La grabación está vacía; no se sube.");

  const name = basename(path);
  const mimeType = name.toLowerCase().endsWith(".webm") ? "video/webm" : "video/mp4";
  const file = new File([new Blob([bytes], { type: mimeType })], name, { type: mimeType });
  const authHeader = `Bearer ${token}`;
  // El web solo acepta pathnames bajo "recordings/" (isAllowedRecordingBlobReference).
  const blobPathname = `recordings/uploads/${name}`;

  let blob;
  try {
    blob = await upload(blobPathname, file, {
      access: "public",
      handleUploadUrl: `${base}/api/recordings/upload`,
      contentType: mimeType,
      headers: { Authorization: authHeader },
      onUploadProgress: ({ percentage }) => onProgress?.(Math.round(percentage)),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isNetworkError(msg)) {
      throw new Error(
        "No se pudo subir (¿sin conexión?). El vídeo sigue guardado; reintenta.",
      );
    }
    throw new AuthError(
      "No se pudo autorizar la subida. Revisa la URL y el token en Conexión.",
    );
  }

  const res = await postJsonWithRetry(`${base}/api/recordings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify({
      blobUrl: blob.url,
      blobPathname: blob.pathname,
      title,
      mode: "screen",
      durationSec: durationSec ?? 0,
      sizeBytes: file.size,
      mimeType,
    }),
  });

  if (res.status === 401) {
    throw new AuthError("Token inválido. Revisa el token en Conexión.");
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`No se pudo registrar la grabación (${res.status}). ${detail}`.trim());
  }

  const { shareToken } = (await res.json()) as { shareToken?: string };
  if (!shareToken) throw new Error("Tu instancia no devolvió un enlace para compartir.");

  return { shareToken, shareUrl: `${base}/v/${shareToken}` };
}
