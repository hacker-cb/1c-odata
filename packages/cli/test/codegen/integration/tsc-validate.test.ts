import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { generate } from '../../../src/codegen/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixturesDir = resolve(here, '../fixtures')
const snapshotsDir = resolve(here, '../../../../../snapshots')
const repoRoot = resolve(here, '../../../../..')
const tsconfigTemplate = resolve(fixturesDir, 'tsc-tsconfig.template.json')

let tmpRoot: string

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), '1c-odata-codegen-tsc-'))
})

// 30s vs default 10s — recursive rmSync over thousands of generated .ts files
// (real/trade_v11.5 alone = 2551 header files + index dirs) reliably exceeds
// the default on Windows runners. Local + Linux CI fit in ~1-2s.
afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
}, 30_000)

/**
 * Write the codegen output map to `dir`, render a tsconfig that resolves
 * `@1c-odata/client` to the in-monorepo source, and run `tsc --noEmit` from
 * the repo's installed copy. Throws with tsc's stdout/stderr on failure.
 */
function tscValidateGenerated(dir: string, files: Map<string, string>): void {
  mkdirSync(dir, { recursive: true })
  for (const [path, content] of files) {
    const full = join(dir, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  const tsconfig = JSON.parse(readFileSync(tsconfigTemplate, 'utf8'))
  // `paths` accepts absolute paths in TS 5.0+ without requiring `baseUrl`.
  // `baseUrl` is deprecated in TS 6 / removed in TS 7, so we omit it here.
  tsconfig.compilerOptions.paths = {
    '@1c-odata/client': [resolve(repoRoot, 'packages/client/src/index.ts')],
    '@1c-odata/client/*': [resolve(repoRoot, 'packages/client/src/*')],
  }
  // The client source uses Node globals (`Buffer`, `process`) — pull in
  // `@types/node` from the repo's installed copy. `typeRoots` is required
  // because tsc runs in a tmpdir with no `node_modules` of its own.
  tsconfig.compilerOptions.types = ['node']
  tsconfig.compilerOptions.typeRoots = [resolve(repoRoot, 'node_modules/@types')]
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2))
  const tscBin = resolve(repoRoot, 'node_modules/.bin/tsc')
  try {
    execSync(`"${tscBin}" -p .`, { cwd: dir, stdio: 'pipe', encoding: 'utf8' })
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    const detail = err.stdout ?? err.stderr ?? err.message ?? '(unknown tsc failure)'
    throw new Error(`tsc failed in ${dir}:\n${detail}`)
  }
}

describe('integration: tsc --noEmit on emitted output', () => {
  // Pick synthetic fixtures that exercise every emitter path
  const syntheticFixtures = [
    '01-catalog-with-table.xml',
    '02-document-with-fi.xml',
    '06-value-storage.xml',
    '07-composite-ref.xml',
    '08-constant.xml',
  ]
  for (const fixture of syntheticFixtures) {
    it(`emitted output compiles — synthetic/${fixture}`, () => {
      const xml = readFileSync(join(fixturesDir, fixture), 'utf8')
      const result = generate({ metadata: xml })
      tscValidateGenerated(join(tmpRoot, fixture.replace(/\.xml$/, '')), result.files)
    }, 60_000)
  }

  /**
   * Real-world EDMX from УТ 11.5 (Trade Management representative).
   * Catches issues that small synthetic fixtures miss:
   *   - 1С property names that collide with reserved TS identifiers
   *   - circular type references between nav-linked entity files
   *   - cyrillic identifier edge cases at scale (2551 files)
   *   - rare property-attribute combinations
   *
   * bp_v3.0 (Accounting) runs on any CI runner (gate `CI=true || CI_RUN_BIG_FIXTURES=1`);
   * locally opt-in via `CI_RUN_BIG_FIXTURES=1`. Same code path, different schema flavor
   * (accounting registers / Document_БухгалтерскаяОперация).
   */
  it('emitted output compiles — real/trade_v11.5.xml', () => {
    const xml = readFileSync(join(snapshotsDir, 'trade_v11.5.xml'), 'utf8')
    const result = generate({ metadata: xml })
    tscValidateGenerated(join(tmpRoot, 'real-trade_v11.5'), result.files)
    // 90s. Initial 30s under-estimated Windows worst-case: local Mac M-series
    // ~1.3s, Ubuntu CI ~6s, Windows CI observed >30s (writing thousands of
    // .ts files + `tsc --noEmit` on NTFS is much slower than ext4 — exact
    // upper bound unknown, just that 30s wasn't enough). 90s gives 3× headroom
    // over the observed lower bound while still flagging a 5-10× perf
    // regression on Windows quickly enough.
  }, 90_000)

  const RUN_BIG_FIXTURES = process.env.CI_RUN_BIG_FIXTURES === '1' || process.env.CI === 'true'

  it.skipIf(!RUN_BIG_FIXTURES)(
    'emitted output compiles — real/bp_v3.0.xml',
    () => {
      const xml = readFileSync(join(snapshotsDir, 'bp_v3.0.xml'), 'utf8')
      const result = generate({ metadata: xml })
      tscValidateGenerated(join(tmpRoot, 'real-bp_v3.0'), result.files)
    },
    // Bigger fixture by raw schema count; on CI it runs by default (CI=true),
    // locally opt-in via CI_RUN_BIG_FIXTURES=1. Same class of workload as
    // trade_v11.5 above (write thousands of .ts files + tsc --noEmit, same
    // Windows-NTFS slowdown class). Kept at 60s for now — bp_v3.0 has not
    // tripped 30s in observed runs the way trade_v11.5 did, so we don't pre-
    // emptively widen its budget; if a future Windows CI run blows 60s here,
    // bump to match trade_v11.5's 90s.
    60_000,
  )
})
