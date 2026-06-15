import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DataShape, MetadataIndex } from '@1c-odata/client'
import { buildMetadataIndex, parseEdmx } from '@1c-odata/metadata'
import { describe, expect, it } from 'vitest'
import { generate } from '../../../src/codegen/index.js'
import { buildNameFilter } from '../../../src/codegen/name-filter.js'

// Pins the "single source of truth" invariant: the runtime-facing sections of
// the codegen-emitted `__metadata.json` must be EXACTLY what
// `buildMetadataIndex` produces for the same model — codegen only adds
// CLI-only debug sections (counts, closure stats, input hashes) around it.
// If this test fails, runtime consumers (fetched $metadata) and codegen
// consumers (__metadata.json file) would disagree on the schema.

const here = dirname(fileURLToPath(import.meta.url))
const snapshotsDir = resolve(here, '../../../../../snapshots')

const FIXTURES = ['trade_v11.5.xml', 'bp_v3.0.xml'] as const

const SHAPES: DataShape[] = [
  {}, // defaults: int64Mode 'number', dateMode 'date'
  { int64Mode: 'bigint' }, // partial — dateMode must resolve to its default on both paths
  { int64Mode: 'bigint', dateMode: 'string' },
]

describe('integration: __metadata.json ≡ buildMetadataIndex (single source of truth)', () => {
  for (const file of FIXTURES) {
    describe(file, () => {
      // Read + parse once per fixture — XML is up to 16 MB.
      const xml = readFileSync(resolve(snapshotsDir, file), 'utf8')
      const model = parseEdmx(xml)

      for (const shape of SHAPES) {
        it(`runtime sections match for shape ${JSON.stringify(shape)}`, () => {
          const emitted = JSON.parse(generate({ metadata: xml, ...shape }).files.get('__metadata.json')!) as Record<
            string,
            unknown
          >
          const built: MetadataIndex = buildMetadataIndex(model, { shape })

          expect(emitted.schemaNamespace).toEqual(built.schemaNamespace)
          expect(emitted.schemas).toEqual(built.schemas)
          expect(emitted.entitySetToType).toEqual(built.entitySetToType)
          expect(emitted.enums).toEqual(built.enums)
          expect(emitted.shape).toEqual(built.shape)
        }, 120_000)
      }

      // With `include`, the emitted `__metadata.json` must be narrowed to the
      // SAME dependency closure as the generated `.ts` — i.e. exactly what
      // `buildMetadataIndex(model, { filter })` produces for the same filter,
      // matching `fetchMetadataIndex(conn, { filter })`. Pins the include-path
      // half of the single-source-of-truth invariant (the loop above only
      // covers the unfiltered full-base path).
      it('narrows __metadata.json to the include closure (matches buildMetadataIndex filter)', () => {
        const include = ['Catalog_*']
        const filter = buildNameFilter({ include })
        const emitted = JSON.parse(generate({ metadata: xml, include }).files.get('__metadata.json')!) as Record<
          string,
          unknown
        >
        const built: MetadataIndex = buildMetadataIndex(model, { filter })

        expect(emitted.schemas).toEqual(built.schemas)
        expect(emitted.entitySetToType).toEqual(built.entitySetToType)
        // Narrowing actually happened — the closure is far smaller than the base.
        const full = buildMetadataIndex(model)
        expect(Object.keys(built.schemas).length).toBeLessThan(Object.keys(full.schemas).length)
        expect(Object.keys(built.entitySetToType).length).toBeLessThan(Object.keys(full.entitySetToType).length)
      }, 120_000)
    })
  }
})
