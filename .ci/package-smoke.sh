#!/usr/bin/env bash
# .ci/package-smoke.sh — published-package smoke for the four workspace packages.
#
# `package:lint` (publint/attw) checks the type/export surface but never installs
# a tarball, resolves the real node_modules layout, or boots a bin. This script
# owns exactly that consumer path: pack the four @1c-odata/* tarballs — the same
# `pnpm pack` artifact release.yml publishes to npm — then install and exercise
# EACH package in its own isolated scratch project. Catches a dropped `files`
# entry, a broken `bin`, a broken `exports` map, or a `workspace:*` left
# unrewritten — each of which stays green in the workspace, where symlinked
# siblings and the full source tree paper over it.
#
# One scratch project PER package, not one shared install: a consumer installs
# one package, and a combined flat install would let siblings hoist modules into
# scope and mask per-package manifest problems. Isolation keeps each install and
# each import resolving against that package's own graph alone.
#
# Caller provides REPO (repo root) and a writable TMP.
set -euo pipefail

REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
TMP="${TMP:-$(mktemp -d)}"
TARS="$TMP/tars"
SCRATCH="$TMP/scratch"
# Start clean even on a reused TMP (a local re-run after a version bump would
# otherwise leave two tarballs per package, and the `head -1` picks below would
# silently smoke the OLD one).
rm -rf "$TARS" "$SCRATCH"
mkdir -p "$TARS" "$SCRATCH"

# pnpm rewrites each `workspace:*` to the exact local version in the tarball —
# publishing the directory instead would ship an uninstallable manifest.
( cd "$REPO" && pnpm --filter '@1c-odata/client' --filter '@1c-odata/metadata' \
    --filter '@1c-odata/cli' --filter '@1c-odata/mcp' pack --pack-destination "$TARS" )

# Resolve exact tarball paths. The `mcp` glob must match a digit right after
# `mcp-` (versions start with a digit) so it can never pick up an `mcp-<name>`
# sibling package. `head -1` guards against a stray second tarball (TARS is a
# fresh dir, but be defensive so a multi-line value can't slip into the specs
# below). `1c-odata-cli-*` cannot match the client tarball: `client` continues
# with a letter where this glob requires the hyphen.
C=$(ls "$TARS"/1c-odata-client-*.tgz | head -1)
D=$(ls "$TARS"/1c-odata-metadata-*.tgz | head -1)
L=$(ls "$TARS"/1c-odata-cli-*.tgz | head -1)
M=$(ls "$TARS"/1c-odata-mcp-[0-9]*.tgz | head -1)

# One isolated scratch install for one package: dependencies carries ONLY the
# package under test, while `overrides` pins every @1c-odata/* sibling to its
# local tarball so npm resolves the unpublished workspace deps from disk, never
# the registry (which would 404 or, worse, serve a stale published version).
# An override only applies where the graph actually pulls that name, so listing
# all four is safe in every scratch. (file: TARBALLS always unpack into real
# trees — no --install-links needed; that flag only affects file: DIRECTORY
# deps.) --ignore-scripts because this is the one install in CI with no lockfile
# pinning the third-party graph: npm resolves the tarballs' caret ranges to the
# newest versions in range, and running their lifecycle scripts would execute
# unpinned third-party code — while everything this smoke asserts (files,
# exports resolution, bin shims) needs no scripts.
install_isolated() { # $1 = npm package name, $2 = its tarball path
  local dir="$SCRATCH/${1##*/}"
  mkdir -p "$dir"
  ( cd "$dir" && PKG_NAME="$1" PKG_TAR="$2" TAR_C="$C" TAR_D="$D" TAR_L="$L" TAR_M="$M" node -e "
const fs=require('fs');
const e=process.env;
fs.writeFileSync('package.json', JSON.stringify({
  name:'scratch', private:true, version:'0.0.0', type:'module',
  dependencies:{ [e.PKG_NAME]: 'file:'+e.PKG_TAR },
  overrides:{
    '@1c-odata/client':'file:'+e.TAR_C,'@1c-odata/metadata':'file:'+e.TAR_D,
    '@1c-odata/cli':'file:'+e.TAR_L,'@1c-odata/mcp':'file:'+e.TAR_M
  }
}, null, 2));
" && npm install --ignore-scripts --no-audit --no-fund )
}

install_isolated '@1c-odata/client'   "$C"
install_isolated '@1c-odata/metadata' "$D"
install_isolated '@1c-odata/cli'      "$L"
install_isolated '@1c-odata/mcp'      "$M"

# Import every `exports` entrypoint from each installed tree and touch one known
# symbol per entrypoint — a dropped dist file or a phantom dependency fails HERE,
# at consumer-side module resolution, instead of passing green in the workspace.
cat > "$SCRATCH/client/smoke.mjs" <<'EOF'
const { ODataV3Client } = await import('@1c-odata/client')
const { and } = await import('@1c-odata/client/filter')
const internal = await import('@1c-odata/client/internal')
for (const [name, value] of Object.entries({ ODataV3Client, and }))
  if (typeof value !== 'function') { console.error(`${name}: not a function`); process.exit(1) }
if (Object.keys(internal).length === 0) { console.error('client/internal: empty module'); process.exit(1) }
console.log('client imports: OK')
EOF
cat > "$SCRATCH/metadata/smoke.mjs" <<'EOF'
const { createDynamicClient, parseEdmx } = await import('@1c-odata/metadata')
for (const [name, value] of Object.entries({ createDynamicClient, parseEdmx }))
  if (typeof value !== 'function') { console.error(`${name}: not a function`); process.exit(1) }
console.log('metadata imports: OK')
EOF
cat > "$SCRATCH/cli/smoke.mjs" <<'EOF'
const { defineCodegenConfig } = await import('@1c-odata/cli')
const { generate } = await import('@1c-odata/cli/codegen')
for (const [name, value] of Object.entries({ defineCodegenConfig, generate }))
  if (typeof value !== 'function') { console.error(`${name}: not a function`); process.exit(1) }
console.log('cli imports: OK')
EOF
cat > "$SCRATCH/mcp/smoke.mjs" <<'EOF'
const { createMcpServer } = await import('@1c-odata/mcp')
const { ConnectionPool } = await import('@1c-odata/mcp/internal')
for (const [name, value] of Object.entries({ createMcpServer, ConnectionPool }))
  if (typeof value !== 'function') { console.error(`${name}: not a function`); process.exit(1) }
console.log('mcp imports: OK')
EOF
# Scope note: a runtime dep DROPPED from a manifest is deliberately not chased
# here — `pnpm pack` rebuilds dist via `prepack`, and tsdown externalizes exactly
# what `dependencies` lists, so an undeclared import gets BUNDLED at build time
# and the shipped tarball keeps working (verified empirically: deleting `c12`
# from the cli manifest produces a green, self-contained tarball). What actually
# breaks consumers — and what this smoke owns — is the manifest/layout layer:
# `files`, `bin`, `exports`, the `workspace:*` rewrite, and the install itself.
for p in client metadata cli mcp; do
  ( cd "$SCRATCH/$p" && node smoke.mjs )
done

# Both bins through their `bin` mapping — invoked as the exact shim npm created
# in node_modules/.bin (the shebang path a registry install gives the consumer),
# each from its own isolated scratch. Deliberately NOT `npx`: with the local shim
# missing — exactly the broken-`bin` failure this smoke exists to catch — npx
# falls back to fetching a same-named package from the registry and executing
# that, masking the breakage and adding a network/code-exec path.
# The grep anchors on the indented Commands-section line — a bare `grep -q serve`
# would match the word "server" in the program DESCRIPTION and stay green with
# the command itself deleted.
# Materialize-then-match (not `… | grep -q`): under pipefail a late writer hitting
# the pipe grep -q already closed would SIGPIPE and trip set -e.
help=$(cd "$SCRATCH/cli" && ./node_modules/.bin/1c-odata --help); grep -qE '^[[:space:]]+generate\b' <<<"$help"
help=$(cd "$SCRATCH/mcp" && ./node_modules/.bin/1c-odata-mcp --help); grep -qE '^[[:space:]]+serve\b' <<<"$help"

echo "package-smoke: OK"
