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

## What leaves your machine: nothing by default

The desktop app records, edits and exports **entirely on your machine**. It makes **no
network calls** unless you explicitly enable "upload to my server" (the optional Phase 2
web companion, which you host yourself on Vercel). No analytics, no phone-home, no
account required to use it.

## Status

- **Phase 0 — scaffold + privacy gate:** done.
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

## Phase 2 — self-hosted web server (optional)

A tiny Next.js app you host on **your own** Vercel account. It gives you, the single
owner, a dashboard to record in the browser (or upload), share each recording at a
clean `/v/<token>` link, and see **Loom-style view analytics** (views, unique viewers,
retention curve, drop-off). Viewers can react and comment; you moderate.

It's single-user and self-hosted: one password, one database, your storage. No
multi-tenant accounts, no CRM, no third party ever sees your videos.

What you get:

- **Record in the browser** — screen / camera / both, with a floating camera and a
  3-2-1 countdown. Or drag-and-drop a `.webm` / `.mp4`.
- **Share links** — every recording gets a `/v/<token>` page with the player, your
  description, an optional CTA button and an end-card overlay.
- **Owner controls per link** — edit title/description/CTA/end-card, set an expiry,
  password-protect, or revoke (and re-activate) the link.
- **Analytics** — views, unique viewers, completion rate and a retention curve.
- **Reactions & comments** — viewers leave them; you publish or delete from the dashboard.

### Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FAntonio-Rivero%2Ffunlead-recorder&env=DATABASE_URL,DIRECT_DATABASE_URL,BLOB_READ_WRITE_TOKEN,RECORDING_OWNER_PASSWORD,RECORDING_GATE_COOKIE_SECRET&root-directory=apps/web)

The button clones this repo, sets the project **root directory to `apps/web`**, and asks
you for the environment variables below.

### Environment variables

| Variable | Required | What it is |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string (pooled). Use a [Neon](https://neon.tech) database. |
| `DIRECT_DATABASE_URL` | yes | Direct (non-pooled) Postgres URL, used only for Prisma migrations (Neon gives you both). |
| `BLOB_READ_WRITE_TOKEN` | yes | Vercel Blob read/write token — your video storage. |
| `RECORDING_OWNER_PASSWORD` | yes | The single password to log into your dashboard. |
| `RECORDING_GATE_COOKIE_SECRET` | yes | Random secret used to sign session and share-link cookies (generate with `openssl rand -hex 32`). |
| `RECORDING_MAX_UPLOAD_MB` | no | Max upload size in MB (default `1024`). |

### Setup steps

1. **Create a Neon Postgres database** ([neon.tech](https://neon.tech)). Copy both the
   pooled connection string (`DATABASE_URL`) and the direct one (`DIRECT_DATABASE_URL`).
2. **Create a Vercel Blob store** (Vercel dashboard → Storage → Blob) and copy its
   `BLOB_READ_WRITE_TOKEN`.
3. **Click "Deploy to Vercel"** above (or import this repo manually with the root
   directory set to `apps/web`) and fill in the env vars from the table.
4. **Run the database migrations.** From a checkout of this repo with the same env vars:
   ```bash
   cd apps/web
   bun install
   bunx prisma migrate deploy
   ```
5. **Open your site** and log in at `/login` with `RECORDING_OWNER_PASSWORD`. Record or
   upload, and share the `/v/<token>` link.

> Tip: the desktop app stays 100% local. The web server is purely optional — it's there
> only if you want shareable links and analytics on infrastructure **you** own.

## License

MIT © 2026 Antonio Rivero Toledo. See [LICENSE](./LICENSE).
