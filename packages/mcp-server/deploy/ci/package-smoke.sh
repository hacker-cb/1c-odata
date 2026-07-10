#!/usr/bin/env bash
# deploy/ci/package-smoke.sh — Tier 2 published-package smoke.
#
# `package:lint` (publint/attw) checks the type/export surface but never installs
# the tarball, boots the bin, or resolves `drizzle/` from a real node_modules
# layout. This tier owns exactly that: pack the four @1c-odata/* tarballs, install
# them into a scratch project (pinned to the local tarballs so npm never reaches
# the registry for the unpublished workspace siblings), then drive the AUTH path
# so runAuthMigrations actually walks migrationsFolder() from the installed tree.
#
# Caller provides REPO (repo root) and a writable TMP. Bounded polling only.
set -euo pipefail

REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)}"
TMP="${TMP:-$(mktemp -d)}"
TARS="$TMP/tars"
SCRATCH="$TMP/scratch"
mkdir -p "$TARS" "$SCRATCH"

# Pack the mcp-server and its three workspace siblings (client, metadata, mcp).
# pnpm rewrites each `workspace:*` to the exact local version in the tarball.
( cd "$REPO" && pnpm --filter '@1c-odata/mcp-server' --filter '@1c-odata/mcp' \
    --filter '@1c-odata/metadata' --filter '@1c-odata/client' pack --pack-destination "$TARS" )

# Resolve exact tarball paths. The `mcp` glob must exclude `mcp-server`, so match a
# digit right after `mcp-` (versions start with a digit).
S=$(ls "$TARS"/1c-odata-mcp-server-*.tgz)
M=$(ls "$TARS"/1c-odata-mcp-[0-9]*.tgz)
C=$(ls "$TARS"/1c-odata-client-*.tgz)
D=$(ls "$TARS"/1c-odata-metadata-*.tgz)

# Pin EVERY @1c-odata/* to its local tarball via `overrides` so npm resolves the
# unpublished siblings from disk, never the registry (which would 404).
cd "$SCRATCH"
node -e "
const fs=require('fs');
fs.writeFileSync('package.json', JSON.stringify({
  name:'scratch', private:true, version:'0.0.0',
  dependencies:{'@1c-odata/mcp-server':'file:$S'},
  overrides:{
    '@1c-odata/mcp-server':'file:$S','@1c-odata/mcp':'file:$M',
    '@1c-odata/client':'file:$C','@1c-odata/metadata':'file:$D'
  }
}, null, 2));
"
# --install-links materializes the file: deps as real trees (not symlinks), so the
# result mirrors a registry install.
npm install --install-links --no-audit --no-fund

# The migrations SQL must actually ship in the published `files` set — a direct
# guard that cannot silently pass (a dropped `drizzle/` ENOENTs the migrator).
ls node_modules/@1c-odata/mcp-server/drizzle/*.sql >/dev/null
npx 1c-odata-mcp-server --help | grep -q admin-create   # bin mapping + commander resolve

# AUTH path from the installed tree: admin-create runs runAuthMigrations, which
# walks migrationsFolder() dist→package.json→drizzle/ in the node_modules layout.
# A dropped drizzle/ now fails HERE instead of passing green.
export BETTER_AUTH_SECRET
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
npx 1c-odata-mcp-server admin-create \
  --auth-data-dir "$TMP/store" --public-url http://127.0.0.1:3010 \
  --email a@b.co --password 'Password123!' 2>&1 | grep -qi 'admin user created'

# And boot the auth serve against that same persistent pglite store.
ONEC_MCP_PUBLIC_URL=http://127.0.0.1:3010 \
  npx 1c-odata-mcp-server serve --auth-data-dir "$TMP/store" --host 127.0.0.1 --port 3010 >"$TMP/pk.log" 2>&1 &
PK=$!
trap 'kill -TERM "$PK" 2>/dev/null || true' EXIT
curl -fsS --retry 30 --retry-delay 1 --retry-connrefused --max-time 2 http://127.0.0.1:3010/healthz | grep -q '"ok"'

echo "deploy-package-smoke: OK"
