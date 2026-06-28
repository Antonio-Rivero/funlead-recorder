// Persistencia local (localStorage del webview) de la conexión a la instancia
// self-host del usuario + preferencias de grabación. Single-user, su propia máquina;
// no se añade el plugin-store nativo para esto.

export interface RecorderSettings {
  /** Base URL de la instancia web self-host del usuario (sin barra final). */
  baseUrl: string;
  /** RECORDING_DESKTOP_TOKEN que el usuario configuró en su instancia. */
  desktopToken: string;
  /** Cuenta atrás 3-2-1 antes de empezar a grabar. Default true. */
  countdownEnabled: boolean;
  /** Espejar la cámara (vista selfie). Default true. */
  cameraMirror: boolean;
}

const KEY = "funlead-recorder-connection";
const DEFAULTS: RecorderSettings = { baseUrl: "", desktopToken: "", countdownEnabled: true, cameraMirror: true };

export function loadSettings(): RecorderSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<RecorderSettings>;
    return {
      baseUrl: (parsed.baseUrl ?? "").trim(),
      desktopToken: (parsed.desktopToken ?? "").trim(),
      countdownEnabled:
        typeof parsed.countdownEnabled === "boolean" ? parsed.countdownEnabled : true,
      cameraMirror:
        typeof parsed.cameraMirror === "boolean" ? parsed.cameraMirror : true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(next: RecorderSettings): void {
  try {
    const clean: RecorderSettings = {
      baseUrl: next.baseUrl.trim().replace(/\/+$/, ""),
      desktopToken: next.desktopToken.trim(),
      countdownEnabled: next.countdownEnabled,
      cameraMirror: next.cameraMirror,
    };
    localStorage.setItem(KEY, JSON.stringify(clean));
  } catch {
    // localStorage bloqueado: no persiste; no es crítico.
  }
}

export function hasConnection(s: RecorderSettings): boolean {
  return Boolean(s.baseUrl && s.desktopToken);
}
