#!/usr/bin/env bash
# FunLead Recorder — download a PINNED, CHECKSUM-VERIFIED static ffmpeg binary for the
# current platform.
#
# Supply-chain hardening: we no longer pull a moving "latest" build. We pin an exact
# release of eugeneware/ffmpeg-static (immutable GitHub release assets, one self-
# contained ffmpeg per platform) and verify its SHA256 BEFORE using it. A mismatch or
# an unpinned platform aborts the build (fail-closed).
#
# The binary is NOT committed (see .gitignore). It is fetched at build time into
# apps/desktop/src-tauri/bin/ffmpeg-<triple> and bundled as a Tauri resource, so the
# .app runs ffmpeg from inside the bundle (no system ffmpeg, no @loader_path).
#
# It is a GPL static build (same as before). It is fetched at build time and bundled,
# never redistributed inside this repo.
#
# To re-pin (new ffmpeg version): bump FFMPEG_STATIC_TAG, then for each asset run
#   curl -fsSL <url>.gz | shasum -a 256
# and paste the new hashes below.
#
# Usage: bash scripts/fetch-ffmpeg.sh
set -euo pipefail

# --- pinned release -----------------------------------------------------------
FFMPEG_STATIC_TAG="b6.1.1"   # eugeneware/ffmpeg-static (bundles ffmpeg 6.x)
FFMPEG_STATIC_BASE="https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_STATIC_TAG}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$ROOT/apps/desktop/src-tauri/bin"
mkdir -p "$BIN_DIR"

uname_s="$(uname -s)"
uname_m="$(uname -m)"

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing required tool: $1" >&2; exit 1; }; }
need curl
need gzip

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# Map this platform -> (output triple, source asset, expected sha256 of the .gz).
case "$uname_s" in
  Darwin)
    if [ "$uname_m" = "arm64" ]; then
      triple="aarch64-apple-darwin"; asset="ffmpeg-darwin-arm64"; ext=""
      sha="8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa"
    else
      triple="x86_64-apple-darwin"; asset="ffmpeg-darwin-x64"; ext=""
      sha="929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106"
    fi
    ;;
  Linux)
    triple="x86_64-unknown-linux-gnu"; asset="ffmpeg-linux-x64"; ext=""
    sha="bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa"
    ;;
  MINGW* | MSYS* | CYGWIN*)
    triple="x86_64-pc-windows-msvc"; asset="ffmpeg-win32-x64"; ext=".exe"
    sha="8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77"
    ;;
  *)
    echo "Unsupported platform: $uname_s" >&2
    exit 1
    ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

url="$FFMPEG_STATIC_BASE/$asset.gz"
echo "Downloading ffmpeg: $url"
curl -fL --retry 3 -o "$tmp/ffmpeg.gz" "$url"

got="$(sha256_of "$tmp/ffmpeg.gz")"
if [ "$got" != "$sha" ]; then
  echo "SHA256 verification FAILED for $asset.gz" >&2
  echo "  expected: $sha" >&2
  echo "  got:      $got" >&2
  echo "Refusing to use an unverified binary. If you intentionally bumped the version," >&2
  echo "re-pin the hash in scripts/fetch-ffmpeg.sh." >&2
  exit 1
fi
echo "SHA256 OK ($asset.gz)"

out="$BIN_DIR/ffmpeg-$triple$ext"
gzip -dc "$tmp/ffmpeg.gz" > "$out"
chmod +x "$out" 2>/dev/null || true

echo "ffmpeg static ready: $out"
echo "(not committed — bundled as a Tauri resource at build time)"
