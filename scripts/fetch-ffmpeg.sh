#!/usr/bin/env bash
# FunLead Recorder — download a STATIC ffmpeg binary for the current platform.
#
# The binary is NOT committed (see .gitignore). It is fetched at build time into
# apps/desktop/src-tauri/bin/ffmpeg-<triple> and bundled as a Tauri resource, so
# the .app runs ffmpeg from inside the bundle (no system ffmpeg, no @loader_path).
#
# Sources:
#   - macOS: evermeet.cx static builds (arm64 + x86_64)
#   - Windows: BtbN static gpl build (x86_64)
#   - Linux: martin-riedl static build (x86_64)
#
# Usage: bash scripts/fetch-ffmpeg.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$ROOT/apps/desktop/src-tauri/bin"
mkdir -p "$BIN_DIR"

uname_s="$(uname -s)"
uname_m="$(uname -m)"

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing required tool: $1" >&2; exit 1; }; }
need curl

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

download() {
  echo "Downloading ffmpeg: $1"
  curl -fL --retry 3 -o "$2" "$1"
}

case "$uname_s" in
  Darwin)
    if [ "$uname_m" = "arm64" ]; then
      triple="aarch64-apple-darwin"
      url="https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip"
    else
      triple="x86_64-apple-darwin"
      url="https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip"
    fi
    need unzip
    download "$url" "$tmp/ffmpeg.zip"
    unzip -o "$tmp/ffmpeg.zip" -d "$tmp" >/dev/null
    out="$BIN_DIR/ffmpeg-$triple"
    mv "$tmp/ffmpeg" "$out"
    chmod +x "$out"
    ;;
  Linux)
    triple="x86_64-unknown-linux-gnu"
    url="https://ffmpeg.martin-riedl.de/redirect/latest/linux/amd64/release/ffmpeg.zip"
    need unzip
    download "$url" "$tmp/ffmpeg.zip"
    unzip -o "$tmp/ffmpeg.zip" -d "$tmp" >/dev/null
    out="$BIN_DIR/ffmpeg-$triple"
    mv "$tmp/ffmpeg" "$out"
    chmod +x "$out"
    ;;
  MINGW* | MSYS* | CYGWIN*)
    triple="x86_64-pc-windows-msvc"
    url="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
    need unzip
    download "$url" "$tmp/ffmpeg.zip"
    unzip -o "$tmp/ffmpeg.zip" -d "$tmp" >/dev/null
    src="$(find "$tmp" -name ffmpeg.exe | head -1)"
    out="$BIN_DIR/ffmpeg-$triple.exe"
    mv "$src" "$out"
    ;;
  *)
    echo "Unsupported platform: $uname_s" >&2
    exit 1
    ;;
esac

echo "ffmpeg static ready: $out"
echo "(not committed — bundled as a Tauri resource at build time)"
