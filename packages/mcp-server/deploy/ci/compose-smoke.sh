#!/usr/bin/env bash
# deploy/ci/compose-smoke.sh — Tier 3 smoke: drive the FULL shipped compose stack
# (db + mcp + caddy) through Caddy over real TLS (internal CA), verifying the
# certificate chain — never `curl -k`.
#
# Run from deploy/ (the workflow sets working-directory). The stack is already up
# (`docker compose ... up -d --wait`). Every wait is a bounded poll.
set -euo pipefail

DC="docker compose -f compose.yml -f ci/compose.ci.yml"

# Caddy mints its internal-CA root lazily at first provisioning — poll for it, then
# extract it so curl/undici can verify the chain.
for _ in $(seq 1 30); do
  $DC exec -T caddy cat /data/caddy/pki/authorities/local/root.crt >ci-root.crt 2>/dev/null && [ -s ci-root.crt ] && break
  sleep 1
done
[ -s ci-root.crt ] || { echo "::error::Caddy internal-CA root.crt never appeared"; exit 1; }

# Reach the base 0.0.0.0:443/80 publish via loopback; verify with the extracted CA.
# --max-time bounds a stalled server so a hang fails fast, not to the job timeout.
C="curl -sS --connect-timeout 5 --max-time 15 --cacert ci-root.crt --resolve mcp.test:443:127.0.0.1 --resolve mcp.test:80:127.0.0.1"
code() { $C -o /dev/null -w '%{http_code}' "$@"; }

# root.crt existing does NOT mean the per-site LEAF for mcp.test is issued — that
# happens on first handshake. Retry the first HTTPS hit.
ok=""
for _ in $(seq 1 30); do
  [ "$(code https://mcp.test/healthz)" = 200 ] && { ok=1; break; }
  sleep 1
done
[ -n "$ok" ] || { echo "::error::https://mcp.test/healthz never reached 200 (leaf not issued?)"; exit 1; }

[ "$(code http://mcp.test/healthz)" = 308 ] # Caddy auto HTTP→HTTPS redirect

# The wizard, through Caddy (Host preserved). No concurrency race here — a single
# compose stack has no request-level parallelism to exercise (that lives in Tier 1
# on the real pg.Pool) — so a fixed email is deterministic and correct.
# `head -1` is load-bearing: the pino FIRST-RUN line carries the token TWICE (the
# `setupUrl` field AND the message text), so grep -oE matches twice — without
# head -1 the substitution yields "TOKEN\nTOKEN" and the embedded newline makes the
# request URL malformed (curl error 3). `|| true` so an empty grep doesn't abort
# the substitution (pipefail) BEFORE the diagnostic below can run.
TOKEN=$($DC logs --no-color --no-log-prefix mcp | grep 'FIRST-RUN' | grep -oE 'token=[A-Za-z0-9_-]+' | head -1 | cut -d= -f2 || true)
[ -n "$TOKEN" ] || { echo "::error::setup token not found in mcp logs"; exit 1; }

[ "$(code "https://mcp.test/setup?token=$TOKEN")" = 200 ] # wizard OPEN through the proxy (status, not just body)
[ "$(code -X POST https://mcp.test/setup -H 'Origin: https://mcp.test' \
     --data-urlencode "token=$TOKEN" --data-urlencode email=a@b.co \
     --data-urlencode 'password=Password123!' --data-urlencode 'confirm=Password123!')" = 302 ]
[ "$(code "https://mcp.test/setup?token=$TOKEN")" = 404 ] # single-use: burned + self-closed

# The /mcp bearer gate is wired THROUGH Caddy: an unauthenticated call → 401 with
# the RFC 9728 resource_metadata pointer. This proves the gate + discovery survive
# the proxy hop without needing a token.
#
# The full AUTHENTICATED round-trip (bearer → Host guard → initialize 200) is
# covered by Tier 1 direct and is not repeated through Caddy here — driving the
# whole OAuth dance (sign-in → DCR → authorize → consent → token, with PKCE) from
# a shell script buys little over the TS e2e that already covers it.
#
# Note this is now purely a cost call, not a topology limit: verification reads
# the AS's keys IN-PROCESS, so the container never has to resolve or trust its own
# public origin (see #106). It used to fetch https://mcp.test/api/auth/... , which
# in the compose network the container can neither resolve (mcp.test lives only in
# the RUNNER's /etc/hosts) nor trust (Caddy's internal CA).
mcp_headers=$($C -D - -o /dev/null -X POST https://mcp.test/mcp \
  -H 'accept: application/json, text/event-stream' -H 'content-type: application/json' --data '{}')
grep -qi 'www-authenticate' <<<"$mcp_headers"

# Break-glass at the container boundary (README §3; ENTRYPOINT is the bin).
setpw=$($DC run --rm mcp set-password --email a@b.co --password 'Rotated456!' 2>&1)
grep -q 'password updated' <<<"$setpw"

echo "deploy-compose-smoke: OK"
