#!/usr/bin/env bash
# FunLead Recorder — privacy gate.
# Blocks secrets, customer/identity data, internal infra, internal CRM-auth symbols,
# and forbidden network calls. NEVER blocks the FunLead brand (funlead.app etc).
# Complements gitleaks (which covers generic token shapes); see CONTRIBUTING.md.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
FAIL=0
EXCLUDES=(--exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist
  --exclude-dir=target --exclude-dir=gen --exclude-dir=.next --exclude-dir=.claude
  --exclude=secret-scan.sh --exclude=.gitleaks.toml)

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
  # (3) customer / identity / personal
  "i@@@client:yoluzon@@@yoluzon"
  "i@@@client:familia-formacion@@@familia y formaci"
  "s@@@identity:icloud@@@@icloud\.com"
  "s@@@identity:gmail@@@@gmail\.com"
  "s@@@identity:appleteam@@@FQ9CY9VPBW"
  "s@@@identity:userpath@@@/Users/antonioriverotoledo"
  "s@@@origin:crm-repo@@@antoriv123/crm-visiona"
  "s@@@origin:yoom-repo@@@antoriv123/yoom-desktop"
  "i@@@brand-leak:yoom@@@\byoom\b"
  "i@@@origin:crm-visiona@@@crm-visiona"
  # (4) internal infrastructure
  "i@@@infra:tailscale@@@tail[0-9a-z]+\.ts\.net"
  "i@@@infra:imac@@@oficina-imac"
  # (5) internal CRM auth architecture
  "s@@@crm-auth:getSessionOrgOrToken@@@getSessionOrgOrToken"
  "s@@@crm-auth:getApiTokenOrg@@@getApiTokenOrg"
  "s@@@crm-auth:api-token-auth@@@api-token-auth"
  "s@@@crm-auth:ApiTokensSection@@@ApiTokensSection"
  "s@@@crm-auth:tokenHash@@@tokenHash"
  # (6) forbidden network (must not exist in Phase 1, local-only)
  "s@@@net:crm-api@@@/api/grabaciones"
  "s@@@net:vercel-blob-pkg@@@@vercel/blob"
  "s@@@net:old-deeplink@@@funlead-recording://"
)

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
  echo "secret-scan: OK (brand FunLead allowed; no secrets/customer/infra/CRM-auth/forbidden-net found)"
  exit 0
else
  echo "secret-scan: FAILED — fix the lines above before committing/pushing."
  exit 1
fi
