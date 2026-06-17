// FunLead Recorder — single source of truth for brand identifiers.
// (Applied to tauri.conf.json / UI in Phase 1.)
export const BRAND = {
  productName: "FunLead Recorder",
  bundleIdentifier: "com.funlead.recorder",
  deepLinkScheme: "funlead-recorder", // reserved; not used in Phase 1 (local-only)
  outputDirName: "FunLead", // recordings go to ~/Movies/FunLead/
  website: "https://funlead.app",
} as const
