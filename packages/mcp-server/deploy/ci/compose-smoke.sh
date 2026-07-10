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
C="curl -sS --cacert ci-root.crt --resolve mcp.test:443:127.0.0.1 --resolve mcp.test:80:127.0.0.1"
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

# Host preserved end-to-end → a bearer-driven initialize succeeds THROUGH Caddy.
# mcp-flow uses undici (global fetch), which honors NODE_EXTRA_CA_CERTS but NOT
# curl's --cacert/--resolve — so the caller adds the /etc/hosts entry and we pass
# the CA here. A future `header_up Host` in the Caddyfile would break this → red.
# No --host-evil: through a proxy the negative case tests the proxy's routing, not
# this server's guard (that assertion lives in Tier 1, direct to the app). `timeout`
# bounds a stalled server so a hang fails fast instead of blocking to the job timeout.
NODE_EXTRA_CA_CERTS="$PWD/ci-root.crt" timeout 60 node ci/mcp-flow.mjs https://mcp.test a@b.co 'Password123!' --host-ok mcp.test

# Break-glass at the container boundary (README §3; ENTRYPOINT is the bin).
setpw=$($DC run --rm mcp set-password --email a@b.co --password 'Rotated456!' 2>&1)
grep -q 'password updated' <<<"$setpw"

echo "deploy-compose-smoke: OK"
