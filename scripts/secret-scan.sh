#!/usr/bin/env bash
# FunLead Recorder — privacy gate.
# Blocks secret-shaped tokens, generic personal data, and forbidden network calls.
# NEVER blocks the FunLead brand (funlead.app etc). Complements gitleaks (which
# covers generic token shapes); see CONTRIBUTING.md.
#
# Project-specific private patterns (real client names, signing identities, internal
# repos/hosts, private backend symbols) are NOT hardcoded here — publishing them would
# leak exactly what this gate protects. They load at runtime from an UNVERSIONED file
# (default: .private-secret-patterns at the repo root, gitignored), or from the path in
# $PRIVATE_PATTERNS_FILE. See .private-secret-patterns.example for the format.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
FAIL=0
PRIVATE_PATTERNS_FILE="${PRIVATE_PATTERNS_FILE:-.private-secret-patterns}"
EXCLUDES=(--exclude-dir=.git --exclude=.git --exclude-dir=node_modules --exclude-dir=dist
  --exclude-dir=target --exclude-dir=gen --exclude-dir=.next --exclude-dir=.claude
  --exclude=secret-scan.sh --exclude=.gitleaks.toml
  --exclude=.private-secret-patterns --exclude=.private-secret-patterns.example)

# entries: flag@@@label@@@regex   (flag: i=case-insensitive, s=case-sensitive)
PATTERNS=(
  # (1) secret-shaped tokens — no host allowlist: a token inside a funlead.app URL still trips
  "s@@@token:postgres-url@@@postgres(ql)?://"
  "s@@@token:resend@@@re_[A-Za-z0-9]{20,}"
  "s@@@token:openai@@@sk-[A-Za-z0-9_-]{20,}"
  "s@@@token:stripe-live@@@(sk|rk)_live_[A-Za-z0-9]{10,}"
  "s@@@token:stripe-whsec@@@whsec_[A-Za-z0-9]{10,}"
  "s@@@token:vercel-blob@@@vercel_blob_rw_[A-Za-z0-9]{10,}"
  "s@@@token:fl-mcp@@@fl_mcp_[A-Za-z0-9]{6,}"
  "s@@@token:fpat@@@fpat_[A-Za-z0-9]{6,}"
  "s@@@token:aws@@@AKIA[0-9A-Z]{12,}"
  "s@@@token:github-pat@@@ghp_[A-Za-z0-9]{20,}"
  "s@@@token:slack@@@xox[baprs]-[A-Za-z0-9-]{6,}"
  "s@@@token:private-key@@@-----BEGIN [A-Z ]*PRIVATE KEY-----"
  # (3) generic personal data shapes (no specific person hardcoded)
  "s@@@identity:icloud@@@@icloud\.com"
  "s@@@identity:gmail@@@@gmail\.com"
  # (4) generic internal-infra shapes (no specific host hardcoded)
  "i@@@infra:tailscale@@@tail[0-9a-z]+\.ts\.net"
  # (6) forbidden network — the desktop app is local-only (no telemetry / no phone-home)
  "s@@@net:old-deeplink@@@funlead-recording://"
)

# Load project-specific PRIVATE patterns from the unversioned file, if present.
# Same `flag@@@label@@@regex` format, one per line; blank lines and #comments ignored.
if [ -f "$PRIVATE_PATTERNS_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|\#*) continue ;; esac
    PATTERNS+=("$line")
  done < "$PRIVATE_PATTERNS_FILE"
  echo "secret-scan: loaded private patterns from $PRIVATE_PATTERNS_FILE"
else
  echo "secret-scan: no $PRIVATE_PATTERNS_FILE (generic rules only — expected on public clones)"
fi

for entry in "${PATTERNS[@]}"; do
  flag="${entry%%@@@*}"; rest="${entry#*@@@}"; label="${rest%%@@@*}"; re="${rest#*@@@}"
  gi=""; [ "$flag" = "i" ] && gi="-i"
  m="$(grep -rEnI $gi "${EXCLUDES[@]}" -e "$re" . 2>/dev/null)"
  if [ -n "$m" ]; then echo "BLOCKED [$label]"; printf '%s\n' "$m" | sed 's/^/   /'; FAIL=1; fi
done

# (2) secret env var with a literal value in code (ignore process.env / .env.example)
ENV2="(DATABASE_URL|NEXTAUTH_SECRET|AUTH_SECRET|BLOB_READ_WRITE_TOKEN|FUNLEAD_INTERNAL_API_TOKEN|LUPA_[A-Z_]+|ENCRYPTION_KEY|OPENAI_API_KEY|STRIPE_SECRET_KEY|RESEND_API_KEY|APIFY_TOKEN|VERCEL_TOKEN|SENTRY_AUTH_TOKEN|CRON_SECRET|RECORDING_OWNER_PASSWORD|RECORDING_GATE_COOKIE_SECRET)[[:space:]]*[:=][[:space:]]*[^[:space:]]"
m="$(grep -rEnI "${EXCLUDES[@]}" -e "$ENV2" . 2>/dev/null | grep -vE "process\.env|import\.meta\.env|\.env\.example:")"
if [ -n "$m" ]; then echo "BLOCKED [env:literal-secret-value]"; printf '%s\n' "$m" | sed 's/^/   /'; FAIL=1; fi

# (6b) zero-network is a DESKTOP requirement: @vercel/blob must not appear under apps/desktop.
# The web server (apps/web) legitimately uses @vercel/blob for storage, so it is allowed there.
if [ -d apps/desktop ]; then
  db="$(grep -rEnI "${EXCLUDES[@]}" -e "@vercel/blob" apps/desktop 2>/dev/null)"
  if [ -n "$db" ]; then echo "BLOCKED [net:vercel-blob in desktop (must be local-only)]"; printf '%s\n' "$db" | sed 's/^/   /'; FAIL=1; fi
fi

# agent-memory must never be present (recursive). Prune .git and .claude: both are
# gitignored, so anything inside them can never be committed; the authoritative
# protection against a *tracked* agent-memory is the git ls-files check below.
am="$(find . \( -path ./.git -o -name .claude \) -prune -o -iname '*agent-memory*' -print 2>/dev/null | grep -i agent-memory)"
if [ -n "$am" ]; then echo "BLOCKED [agent-memory present]"; printf '%s\n' "$am" | sed 's/^/   /'; FAIL=1; fi
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  tracked="$(git ls-files | grep -i agent-memory)"
  if [ -n "$tracked" ]; then echo "BLOCKED [agent-memory tracked]"; printf '%s\n' "$tracked" | sed 's/^/   /'; FAIL=1; fi
fi

if [ "$FAIL" -eq 0 ]; then
  echo "secret-scan: OK (brand FunLead allowed; no secrets/personal/infra/forbidden-net found)"
  exit 0
else
  echo "secret-scan: FAILED — fix the lines above before committing/pushing."
  exit 1
fi
