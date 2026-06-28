// Persistencia local (localStorage del webview) de la conexión a la instancia
// self-host del usuario: baseUrl + token de escritorio. Single-user, en su propia
// máquina; no se añade el plugin-store nativo solo para dos strings.

export interface RecorderSettings {
  /** Base URL de la instancia web self-host del usuario (sin barra final). */
  baseUrl: string;
  /** RECORDING_DESKTOP_TOKEN que el usuario configuró en su instancia. */
  desktopToken: string;
}

const KEY = "funlead-recorder-connection";
const DEFAULTS: RecorderSettings = { baseUrl: "", desktopToken: "" };

export function loadSettings(): RecorderSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<RecorderSettings>;
    return {
      baseUrl: (parsed.baseUrl ?? "").trim(),
      desktopToken: (parsed.desktopToken ?? "").trim(),
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
    };
    localStorage.setItem(KEY, JSON.stringify(clean));
  } catch {
    // localStorage bloqueado: no persiste; no es crítico.
  }
}

export function hasConnection(s: RecorderSettings): boolean {
  return Boolean(s.baseUrl && s.desktopToken);
}
