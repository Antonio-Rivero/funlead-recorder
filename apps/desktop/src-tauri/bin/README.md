# bundled binaries (ffmpeg + whisper.cpp)

The platform-specific static ffmpeg binary (`ffmpeg-<triple>`) is fetched here at
build time by `scripts/fetch-ffmpeg.sh`, and the whisper.cpp CLI
(`whisper-cli-<triple>`) by `scripts/fetch-whisper.sh`. Both are bundled as Tauri
resources so the app runs them from inside the .app (no system ffmpeg/whisper, no
`@loader_path` issues). whisper models live in `models/` (see `models/README.md`).

The binaries are **not committed** (see `.gitignore`). This file keeps the
directory present so the `bin/*` resource glob in `tauri.conf.json` always
resolves, even before the fetch scripts have run.
