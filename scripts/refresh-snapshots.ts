#!/usr/bin/env -S node --import tsx
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
// Import from source rather than the package barrel so the script runs on a
// fresh checkout where `packages/client/dist/` has not been built yet (tsx
// transpiles TS on the fly). Other in-tree consumers (CLI bin, tests) go
// through the built package symbol and are unaffected.
import { BasicAuth, normalizeBaseUrl } from '../packages/client/src/index.js'

const FIXTURES: { id: string; envVar: string }[] = [
  { id: 'trade_v11.5', envVar: 'ONEC_TRADE_V11_5_URL' },
  { id: 'bp_v3.0', envVar: 'ONEC_BP_V3_0_URL' },
]

const HELP = `Usage: refresh-snapshots [--connection <fixture_id>]

Refreshes EDMX metadata snapshots in snapshots/*.xml from live 1С databases.

Without --connection: refreshes all of: ${FIXTURES.map((f) => f.id).join(', ')}.

Reads creds from .env.local (auto-sourced via --env-file-if-exists in
package.json wrapper) or current shell. Required env vars per fixture:
ONEC_<PREFIX>_URL containing http://user:password@host/path.
`

function maskUrl(url: string): string {
  return url.replace(/\/\/[^/]*@/, '//***@')
}

async function refreshOne(id: string, envVar: string, root: string): Promise<void> {
  const url = process.env[envVar]
  if (url === undefined || url.length === 0) {
    throw new Error(`${envVar} is not set (needed for fixture "${id}")`)
  }
  process.stdout.write(`[${id}] fetching ${maskUrl(url)}/$metadata\n`)

  const metadataUrl = `${normalizeBaseUrl(url)}/$metadata`
  const u = new URL(metadataUrl)
  const auth = BasicAuth({
    username: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
  }).header
  // strip userinfo from URL before fetching (defence-in-depth; Node fetch ignores it on its own)
  u.username = ''
  u.password = ''

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 180_000)
  let body: string
  try {
    const res = await fetch(u.toString(), {
      headers: { Authorization: auth, Accept: 'application/xml' },
      signal: ctrl.signal,
    })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} fetching ${maskUrl(metadataUrl)}`)
    }
    body = await res.text()
  } finally {
    clearTimeout(timer)
  }

  // Guard against 1С returning 200 OK with an HTML auth/error page instead of EDMX.
  if (!body.startsWith('<?xml')) {
    throw new Error(`response is not XML (first 200 chars): ${body.slice(0, 200)}`)
  }

  // Atomic write inside the snapshots dir — same filesystem guarantees
  // POSIX rename(2) atomicity AND avoids EXDEV (cross-device link) when
  // os.tmpdir() lives on a different volume (common on Windows: tmp on C:,
  // repo on D:).
  const snapshotsDir = join(root, 'snapshots')
  mkdirSync(snapshotsDir, { recursive: true })
  const tmpDir = mkdtempSync(join(snapshotsDir, '.tmp-'))
  const finalPath = join(snapshotsDir, `${id}.xml`)
  try {
    const tmpPath = join(tmpDir, `${id}.xml`)
    writeFileSync(tmpPath, body, 'utf8')
    renameSync(tmpPath, finalPath)
  } finally {
    // Clean up the empty tmp directory after rename, even on failure paths
    // (rename succeeded then a later step threw, or tmpDir contains a stale
    // file from a prior crash).
    rmSync(tmpDir, { recursive: true, force: true })
  }

  // Quick summary — same info the legacy bash printed via grep counts. Helps the
  // human running `pnpm snapshots:refresh` see at a glance whether anything
  // material changed in the metadata.
  const entitySetCount = body.match(/<EntitySet /g)?.length ?? 0
  const entityTypeCount = body.match(/<EntityType /g)?.length ?? 0
  process.stdout.write(
    `[${id}] -> ${finalPath} (${body.length} bytes, ${entitySetCount} entity sets, ${entityTypeCount} entity types)\n`,
  )
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      connection: { type: 'string', short: 'c' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  })
  if (values.help === true || positionals.length > 0) {
    process.stdout.write(HELP)
    if (positionals.length > 0) process.exit(2)
    return
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const selected = values.connection !== undefined ? FIXTURES.filter((f) => f.id === values.connection) : FIXTURES
  if (selected.length === 0) {
    throw new Error(`Unknown connection: "${values.connection}". Known: ${FIXTURES.map((f) => f.id).join(', ')}`)
  }
  for (const { id, envVar } of selected) {
    await refreshOne(id, envVar, root)
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`refresh-snapshots failed: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
