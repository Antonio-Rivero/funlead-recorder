# whisper.cpp models

The GGML model file (`ggml-base.bin` by default) is fetched here at build time by
`scripts/fetch-whisper.sh` and bundled as a Tauri resource so the app transcribes
offline (no API, no network at runtime).

Models are **not committed** (see `.gitignore`). This file keeps the directory
present so the `bin/models/*` resource glob in `tauri.conf.json` always resolves,
even before `fetch-whisper.sh` has run.
