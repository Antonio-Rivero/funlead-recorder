#!/usr/bin/env bash
# FunLead Recorder — download a PINNED whisper.cpp binary + a PINNED, CHECKSUM-VERIFIED
# model for LOCAL, offline transcription (no API, no network at runtime).
#
# Supply-chain hardening:
#   - the whisper.cpp source is pinned to a TAG and its checked-out commit is verified
#     (git is content-addressed: tag + commit pin = exact, tamper-evident source);
#   - the GGML model is fetched from a PINNED HuggingFace revision and its SHA256 is
#     verified against a pinned value BEFORE use (fail-closed).
#
# Neither the binary nor the model is committed (see .gitignore). They are fetched here
# into apps/desktop/src-tauri/bin/ and bundled as Tauri resources.
#
#   - binary → apps/desktop/src-tauri/bin/whisper-cli-<triple>  (whisper.cpp CLI)
#   - model  → apps/desktop/src-tauri/bin/models/ggml-<model>.bin
#
# Alternative (macOS, no build): `brew install whisper-cpp` installs `whisper-cli` on
# the PATH and the app picks it up. You still need a model; pass --model-only to fetch
# one (verified) without building the binary.
#
# To re-pin: bump WHISPER_CPP_TAG/COMMIT, WHISPER_MODEL_REV, and the per-model SHA256s.
# A model's SHA256 is the LFS oid: curl -fsSL \
#   https://huggingface.co/ggerganov/whisper.cpp/raw/<rev>/ggml-<model>.bin | grep sha256
#
# Usage:
#   bash scripts/fetch-whisper.sh             # build CLI + fetch base model
#   bash scripts/fetch-whisper.sh --model-only
#   WHISPER_MODEL=small bash scripts/fetch-whisper.sh   # base|small|tiny|medium
set -euo pipefail

# --- pinned sources -----------------------------------------------------------
WHISPER_CPP_TAG="v1.9.0"
WHISPER_CPP_COMMIT="86c40c3bd6fc86f1187fb751d111b49e0fc18e84"
WHISPER_MODEL_REV="5359861c739e955e79d9a303bcbc70fb988958b1"   # HF ggerganov/whisper.cpp revision

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$ROOT/apps/desktop/src-tauri/bin"
MODEL_DIR="$BIN_DIR/models"
mkdir -p "$BIN_DIR" "$MODEL_DIR"

MODEL="${WHISPER_MODEL:-base}"
MODEL_ONLY=0
[ "${1:-}" = "--model-only" ] && MODEL_ONLY=1

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing required tool: $1" >&2; exit 1; }; }
need curl

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

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

# Pinned per-model SHA256 (HF LFS oid at WHISPER_MODEL_REV).
case "$MODEL" in
  tiny)   model_sha="be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21" ;;
  base)   model_sha="60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe" ;;
  small)  model_sha="1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b" ;;
  medium) model_sha="6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208" ;;
  *)      model_sha="" ;;
esac

# --- model -----------------------------------------------------------------
model_file="$MODEL_DIR/ggml-$MODEL.bin"

verify_model() {
  local got; got="$(sha256_of "$1")"
  if [ "$got" != "$model_sha" ]; then
    echo "SHA256 verification FAILED for $1" >&2
    echo "  expected: $model_sha" >&2
    echo "  got:      $got" >&2
    echo "Delete the file and re-run, or re-pin the hash if you bumped the version." >&2
    exit 1
  fi
}

# Fail-closed BEFORE any download: refuse an unpinned model unless explicitly bypassed.
ALLOW_UNVERIFIED="${WHISPER_ALLOW_UNVERIFIED:-0}"
if [ -z "$model_sha" ]; then
  if [ "$ALLOW_UNVERIFIED" = "1" ]; then
    echo "WARNING: no pinned SHA256 for model '$MODEL' — verification disabled (WHISPER_ALLOW_UNVERIFIED=1)." >&2
  else
    echo "No pinned SHA256 for model '$MODEL'. Add one to scripts/fetch-whisper.sh," >&2
    echo "or re-run with WHISPER_ALLOW_UNVERIFIED=1 to bypass (not recommended)." >&2
    exit 1
  fi
fi

if [ ! -f "$model_file" ]; then
  echo "Downloading whisper model: ggml-$MODEL.bin (rev ${WHISPER_MODEL_REV:0:12})"
  curl -fL --retry 3 -o "$model_file" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/$WHISPER_MODEL_REV/ggml-$MODEL.bin"
fi
[ -n "$model_sha" ] && verify_model "$model_file"
echo "whisper model ready${model_sha:+ + verified}: $model_file"

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

echo "Cloning whisper.cpp @ $WHISPER_CPP_TAG + verifying commit…"
git clone --branch "$WHISPER_CPP_TAG" --depth 1 https://github.com/ggerganov/whisper.cpp "$tmp/whisper.cpp"
got_commit="$(git -C "$tmp/whisper.cpp" rev-parse HEAD)"
if [ "$got_commit" != "$WHISPER_CPP_COMMIT" ]; then
  echo "whisper.cpp commit mismatch for tag $WHISPER_CPP_TAG" >&2
  echo "  expected: $WHISPER_CPP_COMMIT" >&2
  echo "  got:      $got_commit" >&2
  echo "Refusing to build unverified source. Re-pin WHISPER_CPP_COMMIT if you bumped the tag." >&2
  exit 1
fi
echo "whisper.cpp source verified (commit $got_commit)"

echo "Building whisper.cpp (CMake; this takes a minute)…"
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
