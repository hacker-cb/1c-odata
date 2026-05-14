import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { generate } from '../../../src/codegen/index.js'
import { parseEdmx } from '../../../src/codegen/parser/edmx-parser.js'

const here = dirname(fileURLToPath(import.meta.url))
const snapshotsDir = resolve(here, '../../../../../snapshots')

interface SnapshotExpected {
  /** File name inside `snapshots/`. */
  file: string
  /** From spec §2.2 / §6.2 (snapshot 2026-05-05 — exact match required). */
  entityTypeCount: number
  complexTypeCount: number
  enumTypeCount: number
  functionImportCount: number
  /** Exact header file count — spec §2.2 contract. */
  headerFiles: number
  /** True if the fixture has AccountingRegister_* — bookkeeping FIs must appear. */
  hasAccountingFis: boolean
}

const FIXTURES: SnapshotExpected[] = [
  {
    file: 'trade_v11.5.xml',
    entityTypeCount: 3841,
    complexTypeCount: 1530,
    enumTypeCount: 953,
    functionImportCount: 2329,
    headerFiles: 2551, // spec §2.2 — exact
    hasAccountingFis: false,
  },
  {
    file: 'bp_v3.0.xml',
    entityTypeCount: 3697,
    complexTypeCount: 1549,
    enumTypeCount: 873,
    functionImportCount: 2457,
    headerFiles: 2288, // spec §2.2 — exact
    hasAccountingFis: true,
  },
]

const ACCOUNTING_FIS = ['DrCrTurnovers', 'ExtDimensions', 'RecordsWithExtDimensions'] as const

describe('integration: real EDMX snapshots from snapshots/', () => {
  for (const fx of FIXTURES) {
    describe(fx.file, () => {
      // Read once per describe — XML is up to 16 MB, don't re-read for every `it()`
      const xml = readFileSync(resolve(snapshotsDir, fx.file), 'utf8')

      it('parseEdmx() does not throw + extracts the expected counts', () => {
        const model = parseEdmx(xml)
        expect(model.schemaNamespace).toBe('StandardODATA')
        expect(model.entityTypes.length).toBe(fx.entityTypeCount)
        expect(model.complexTypes.length).toBe(fx.complexTypeCount)
        expect(model.enumTypes.length).toBe(fx.enumTypeCount)
        expect(model.entityContainer.functionImports.length).toBe(fx.functionImportCount)
      }, 30_000)

      it('generate() emits exactly the spec §2.2 header file count', () => {
        const result = generate({ metadata: xml })
        let headerFiles = 0
        for (const path of result.files.keys()) {
          if (!path.endsWith('.ts')) continue
          if (path.endsWith('/index.ts') || path === 'index.ts') continue
          if (path === 'complex-types.ts' || path === 'function-imports.ts') continue
          // Header file = exactly one folder + filename (e.g. `documents/РТУ.ts`)
          if (path.split('/').length === 2) headerFiles += 1
        }
        expect(headerFiles).toBe(fx.headerFiles)
      }, 60_000)

      it('__metadata.json reflects the parsed model', () => {
        const result = generate({ metadata: xml })
        const json = JSON.parse(result.files.get('__metadata.json')!) as {
          schemaNamespace: string
          entityTypeCount: number
          complexTypeCount: number
          functionImportCount: number
        }
        expect(json.schemaNamespace).toBe('StandardODATA')
        expect(json.entityTypeCount).toBe(fx.entityTypeCount)
        expect(json.complexTypeCount).toBe(fx.complexTypeCount)
        expect(json.functionImportCount).toBe(fx.functionImportCount)
      }, 60_000)

      it(`function-imports.ts ${fx.hasAccountingFis ? 'contains' : 'omits'} bookkeeping FIs`, () => {
        const result = generate({ metadata: xml })
        const fi = result.files.get('function-imports.ts') ?? ''
        for (const name of ACCOUNTING_FIS) {
          if (fx.hasAccountingFis) expect(fi).toContain(name)
          else expect(fi).not.toContain(name)
        }
      }, 60_000)
    })
  }
})
