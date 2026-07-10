#!/usr/bin/env bash
# deploy/ci/smoke.sh — Tier 1 deploy smoke: boot the shipped `pnpm deploy --prod`
# tree against a REAL Postgres and walk the security-critical deploy paths that
# the pglite-backed unit/e2e suite structurally cannot exercise:
#   - the node-postgres migrator vs a real server (dev/tests use pglite);
#   - the setup token's single-use guarantee under TRUE concurrency (pglite
#     serializes queries; a prod pg.Pool does not);
#   - the DNS-rebinding Host guard, bearer-driven, end-to-end;
#   - SIGTERM drain + idempotent re-migration on restart.
#
# Caller (ci.yml) provides: APP_DIR (the deploy tree), DATABASE_URL (a real pg),
# ONEC_MCP_PUBLIC_URL. Every wait is a bounded poll — never a fixed sleep.
set -euo pipefail

BASE=$ONEC_MCP_PUBLIC_URL
# Generated ONCE and reused across BOTH boots: the jwks signing key is stored
# encrypted with BETTER_AUTH_SECRET, so a rotated secret would fail to decrypt it
# on restart (a 500 at the token endpoint). Prod keeps these stable in .env too.
export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-$(openssl rand -base64 32)}"
export ONEC_MCP_ENC_KEY="${ONEC_MCP_ENC_KEY:-$(openssl rand -base64 32)}" # 32 bytes → enables tenancy (/setup, /admin)

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
serve() { node "$APP_DIR/dist/cli.js" serve --host 127.0.0.1 --port 3000 >"$1" 2>&1 & echo $!; }
wait_health() { curl -fsS --retry 40 --retry-delay 1 --retry-connrefused --max-time 2 "$BASE/healthz" | grep -q '"ok"'; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

# ── Boot #1: node-postgres migrator vs REAL pg, + the first-run wizard ──────────
MCP=$(serve /tmp/mcp1.log)
trap 'kill -TERM "$MCP" 2>/dev/null || true' EXIT
wait_health

# The token is minted inside createHttpServer BEFORE listen(), so it is in the log
# by the time /healthz answers. Bounded regex-poll; never `logs -f` (blocks).
TOKEN=""
for _ in $(seq 1 15); do
  TOKEN=$(grep -oE 'setup\?token=[A-Za-z0-9_-]+' /tmp/mcp1.log | head -1 | cut -d= -f2 || true)
  [ -n "$TOKEN" ] && break
  sleep 1
done
[ -n "$TOKEN" ] || { echo "::error::setup token never appeared in the boot log"; exit 1; }

[ "$(code "$BASE/setup?token=$TOKEN")" = 200 ]                          # wizard OPEN with the valid token
[ "$(code "$BASE/setup?token=nope")" = 404 ]                           # wrong token → uniform 404 (no oracle)
[ "$(code "$BASE/.well-known/oauth-protected-resource/mcp")" = 200 ]   # PRM discovery wired in the dist
[ "$(code "$BASE/.well-known/oauth-authorization-server")" = 200 ]     # AS metadata wired

# NEGATIVE CSRF: a cross-origin POST must be EXACTLY 403 (assert the code, not
# `!= 302` — a weak check would also pass on a stray 404/500).
[ "$(code -X POST "$BASE/setup" -H 'Origin: https://evil.test' \
     --data-urlencode "token=$TOKEN" --data-urlencode email=x@y.co \
     --data-urlencode 'password=Password123!' --data-urlencode 'confirm=Password123!')" = 403 ]

# ── SECURITY: the single-use token under TRUE concurrency ───────────────────────
# 20 parallel POSTs, one token, DISTINCT emails (so the email-unique constraint is
# not the gate) → EXACTLY one 302. The winner is NONDETERMINISTIC, so read its
# email back from the winning line instead of hardcoding it.
race_one() {
  echo "$(code -X POST "$BASE/setup" -H "Origin: $BASE" \
    --data-urlencode "token=$TOKEN" --data-urlencode "email=admin$1@ci.local" \
    --data-urlencode 'password=Password123!' --data-urlencode 'confirm=Password123!') admin$1@ci.local"
}
export -f race_one code
export BASE TOKEN
seq 20 | xargs -P20 -I@ bash -c 'race_one @' >/tmp/race.txt
N302=$(awk '$1==302' /tmp/race.txt | wc -l | tr -d ' ')
[ "$N302" = 1 ] || { echo "::error::token race seeded $N302 admins (want exactly 1)"; sort /tmp/race.txt; exit 1; }
ADMIN=$(awk '$1==302{print $2}' /tmp/race.txt)
[ -n "$ADMIN" ]
[ "$(code "$BASE/setup?token=$TOKEN")" = 404 ]                         # single-use: token burned, wizard self-closed

# ── Host guard ENFORCEMENT (bearer-driven; the gate precedes the guard on /mcp) ─
# Materialize then match (not `curl | grep -q`): grep -q closes the pipe on match,
# and under pipefail a late writer hitting SIGPIPE would trip set -e.
headers=$(curl -s -D - -o /dev/null -X POST "$BASE/mcp" \
  -H 'accept: application/json, text/event-stream' -H 'content-type: application/json' --data '{}')
grep -qi 'www-authenticate' <<<"$headers"                              # unauth → 401 + RFC 9728 pointer
# `timeout` bounds a stalled server (a hung /authorize or /mcp) to fail fast rather
# than block the job to GitHub's outer timeout — the bounded-poll contract.
timeout 60 node "$here/mcp-flow.mjs" "$BASE" "$ADMIN" 'Password123!' \
  --host-ok 127.0.0.1:3000 --host-evil evil.test                      # 200 canonical Host, 403 spoofed

# ── Break-glass on the real store ──────────────────────────────────────────────
setpw=$(node "$APP_DIR/dist/cli.js" set-password --email "$ADMIN" --password 'Rotated456!' 2>&1)
grep -q 'password updated' <<<"$setpw"

# ── SIGTERM drain within compose's 10s window, then IDEMPOTENT re-boot ──────────
kill -TERM "$MCP"
timeout 12 bash -c "while kill -0 $MCP 2>/dev/null; do sleep 0.3; done" \
  || { echo "::error::mcp did not exit within 12s of SIGTERM"; kill -9 "$MCP"; exit 1; }

MCP=$(serve /tmp/mcp2.log)
wait_health                                                            # migrations idempotent on the 2nd boot
grep -q 'FIRST-RUN SETUP' /tmp/mcp2.log && { echo "::error::setup token re-minted after an admin exists"; exit 1; } || true
[ "$(code "$BASE/setup?token=$TOKEN")" = 404 ]                         # admin persisted across the restart
kill -TERM "$MCP" 2>/dev/null || true

echo "deploy-pg-smoke: OK"
