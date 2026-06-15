// packages/client/test/unit/public-surface.test.ts
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// ESM-safe __dirname equivalent (Vitest + native ESM modules).
const __dirname = dirname(fileURLToPath(import.meta.url))

const PKG_ROOT = join(__dirname, '../..')
const DIST_DTS = join(PKG_ROOT, 'dist/index.d.ts')

// This test guards ONE invariant: internal transport symbols must never leak
// into the public `.d.ts`. It intentionally does NOT snapshot the full API
// shape — that is covered structurally by `package.json#exports`, `tsc`,
// `publint` + `arethetypeswrong` (package:lint), and the changesets release
// process. A verbatim `.d.ts` snapshot only re-encoded bundler output (chunk
// hashes, aliases) and churned on every intentional API change in v0.x.

// Inputs that influence the emitted dist. Any change to these can invalidate
// dist/*.d.ts. Mirrors tsdown entries + tsconfig + base config + tsdown config.
const BUILD_INPUTS = [
  join(PKG_ROOT, 'src'), // recurses below
  join(PKG_ROOT, 'tsdown.config.ts'),
  join(PKG_ROOT, 'tsconfig.json'),
  join(PKG_ROOT, '../../tsconfig.base.json'),
]

function newestMtime(path: string): number {
  const st = statSync(path)
  if (!st.isDirectory()) return st.mtimeMs
  let max = st.mtimeMs
  for (const name of readdirSync(path)) {
    max = Math.max(max, newestMtime(join(path, name)))
  }
  return max
}

// Refuse to scan a stale/missing build: any source / config newer than
// dist/index.d.ts ⇒ throw. Covers all entrypoints (index.ts, filter.ts,
// internal.ts), all nested src/**, and the configs that drive the build, so the
// banned-symbol scan can never pass against an out-of-date dist.
function assertDistFresh(): void {
  if (!existsSync(DIST_DTS)) {
    throw new Error(`Public surface test requires dist/index.d.ts. Run 'pnpm -F @1c-odata/client build' first.`)
  }
  const dtsM = statSync(DIST_DTS).mtimeMs
  for (const input of BUILD_INPUTS) {
    if (!existsSync(input)) continue
    if (newestMtime(input) > dtsM) {
      throw new Error(`dist/index.d.ts is stale (${input} modified later). Run 'pnpm -F @1c-odata/client build' first.`)
    }
  }
}

function loadAllDts(): string {
  // Aggregate ALL .d.ts files in dist for banned-symbol scanning. Catches leaks
  // in subpaths and chunked declaration files (e.g. dist/filter-*.d.ts) that are
  // referenced from public entry points via TS chunk imports.
  assertDistFresh()
  const distDir = dirname(DIST_DTS)
  const files = readdirSync(distDir)
  const contents: string[] = []
  for (const name of files) {
    // Exclude the intentional internal subpath export (`@1c-odata/client/internal`)
    // which legitimately exposes transport symbols not meant for public consumers.
    if (name.endsWith('.d.ts') && name !== 'internal.d.ts') {
      contents.push(readFileSync(join(distDir, name), 'utf8'))
    }
  }
  return contents.join('\n--- FILE BOUNDARY ---\n')
}

// Symbols that MUST NOT appear in the public .d.ts. Each is a regression
// signal for a specific C-1 fix.
const BANNED_SYMBOLS = [
  'transportGet',
  'transportPost',
  'transportPatch',
  'transportPut',
  'transportDelete',
  'transportFetch',
  'transportStream',
  'validateBeforeWrite',
  '_expr',
  'export { request', // main exports must not re-export request/requestStream
  'requestStream',
  'RawResponse',
  'RequestConfig',
  'StreamResponse',
  'TransportOptions',
  'CollectionResult',
]

describe('public surface — banned symbols', () => {
  // Load lazily inside each `it()` so a missing/stale `dist/` surfaces as a
  // normal test failure, not a "failed to load test file" — Vitest evaluates
  // the `describe` body before any test is registered, so throwing here would
  // hide individual assertions in the error report.
  for (const sym of BANNED_SYMBOLS) {
    it(`does not contain "${sym}"`, () => {
      const dts = loadAllDts()
      expect(dts).not.toContain(sym)
    })
  }
})
