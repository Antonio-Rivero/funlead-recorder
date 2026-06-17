# FunLead Recorder

Open-source screen recorder. **Record, edit and share — local-first, zero telemetry.**

A lighter, friendlier take on a desktop screen recorder: native capture (Tauri/Rust),
a polished editor (timeline, zoom, backgrounds) and — optionally — a self-hosted web
server to share links with view analytics. Made by [FunLead](https://funlead.app).

## Why it exists

Most "polished" screen recorders are either heavy Electron apps with no sharing, or
cloud-only tools that ship your video to someone else's servers. FunLead Recorder is:

| | Typical desktop recorder | FunLead Recorder |
|---|---|---|
| Runtime | Electron (heavy) | **Tauri/Rust** (light, native) |
| Editor | basic or none | **timeline, zoom, backgrounds** |
| Sharing | export only | **shareable link + view analytics** (optional, self-hosted) |
| Transcription | — | **local** (whisper.cpp) |
| Telemetry | varies | **none** |
| License | varies | **MIT** |

## Qué datos salen de tu máquina: nada por defecto

The desktop app records, edits and exports **entirely on your machine**. It makes **no
network calls** unless you explicitly enable "upload to my server" (the optional Phase 2
web companion, which you host yourself on Vercel). No analytics, no phone-home, no
account required to use it.

## Status

- **Phase 0 — scaffold + privacy gate:** in progress (this commit).
- **Phase 1 — desktop app (Tauri):** native capture + editor + local MP4 export.
- **Phase 2 — optional web server:** self-host on Vercel for shareable links + analytics.

## Build (Phase 1)

Requirements: Node 18+, Bun (or pnpm), Rust 1.85+, Tauri v2 CLI.

```bash
git clone https://github.com/Antonio-Rivero/funlead-recorder.git
cd funlead-recorder
bun install
cd apps/desktop && bun run tauri dev   # (available once Phase 1 lands)
```

## License

MIT © 2026 Antonio Rivero Toledo. See [LICENSE](./LICENSE).
