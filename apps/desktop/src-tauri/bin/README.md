# ffmpeg static binaries

The platform-specific static ffmpeg binary (`ffmpeg-<triple>`) is fetched here at
build time by `scripts/fetch-ffmpeg.sh` and bundled as a Tauri resource so the app
runs ffmpeg from inside the .app (no system ffmpeg, no `@loader_path` issues).

The binaries are **not committed** (see `.gitignore`). This file keeps the
directory present so the `bin/*` resource glob in `tauri.conf.json` always
resolves, even before `fetch-ffmpeg.sh` has run.
