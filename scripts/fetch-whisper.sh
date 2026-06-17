#!/usr/bin/env bash
# FunLead Recorder — download a whisper.cpp binary + a model for LOCAL, offline
# transcription (no API, no network at runtime).
#
# Neither the binary nor the model is committed (see .gitignore). They are fetched
# here into apps/desktop/src-tauri/bin/ and bundled as Tauri resources, so the
# .app runs whisper.cpp from inside the bundle (no system whisper needed).
#
#   - binary → apps/desktop/src-tauri/bin/whisper-cli-<triple>  (whisper.cpp CLI)
#   - model  → apps/desktop/src-tauri/bin/models/ggml-base.bin  (multilingual)
#
# The binary is built from source via CMake (whisper.cpp has no official
# cross-platform release binaries). The model is a published GGML weight file.
#
# Alternative (macOS, no build): `brew install whisper-cpp` installs `whisper-cli`
# on the PATH and the app will pick it up automatically. You still need a model;
# this script can fetch one without building the binary: pass --model-only.
#
# Usage:
#   bash scripts/fetch-whisper.sh             # build CLI + fetch base model
#   bash scripts/fetch-whisper.sh --model-only
#   WHISPER_MODEL=small bash scripts/fetch-whisper.sh   # base|small|tiny|medium
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$ROOT/apps/desktop/src-tauri/bin"
MODEL_DIR="$BIN_DIR/models"
mkdir -p "$BIN_DIR" "$MODEL_DIR"

MODEL="${WHISPER_MODEL:-base}"
MODEL_ONLY=0
[ "${1:-}" = "--model-only" ] && MODEL_ONLY=1

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing required tool: $1" >&2; exit 1; }; }
need curl

uname_s="$(uname -s)"
uname_m="$(uname -m)"

case "$uname_s" in
  Darwin)
    if [ "$uname_m" = "arm64" ]; then triple="aarch64-apple-darwin"; else triple="x86_64-apple-darwin"; fi
    bin_ext=""
    ;;
  Linux)  triple="x86_64-unknown-linux-gnu"; bin_ext="" ;;
  MINGW* | MSYS* | CYGWIN*) triple="x86_64-pc-windows-msvc"; bin_ext=".exe" ;;
  *) echo "Unsupported platform: $uname_s" >&2; exit 1 ;;
esac

# --- model -----------------------------------------------------------------
model_file="$MODEL_DIR/ggml-$MODEL.bin"
if [ ! -f "$model_file" ]; then
  echo "Downloading whisper model: ggml-$MODEL.bin"
  curl -fL --retry 3 -o "$model_file" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$MODEL.bin"
fi
echo "whisper model ready: $model_file"

if [ "$MODEL_ONLY" -eq 1 ]; then
  echo "(model only; the whisper binary will come from PATH, e.g. brew install whisper-cpp)"
  exit 0
fi

# --- binary (built from source via CMake) ----------------------------------
out="$BIN_DIR/whisper-cli-$triple$bin_ext"
if [ -f "$out" ]; then
  echo "whisper binary already present: $out"
  exit 0
fi

need git
need cmake

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Cloning + building whisper.cpp (CMake; this takes a minute)…"
git clone --depth 1 https://github.com/ggerganov/whisper.cpp "$tmp/whisper.cpp"
cmake -S "$tmp/whisper.cpp" -B "$tmp/build" -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON
cmake --build "$tmp/build" --config Release -j --target whisper-cli

# CMake drops the CLI under build/bin/ (or bin/Release on multi-config generators).
built="$(find "$tmp/build" -name "whisper-cli$bin_ext" -type f | head -1)"
if [ -z "$built" ]; then
  echo "Build finished but whisper-cli was not found." >&2
  exit 1
fi
cp "$built" "$out"
chmod +x "$out" 2>/dev/null || true
echo "whisper binary ready: $out"
echo "(not committed — bundled as a Tauri resource at build time)"
