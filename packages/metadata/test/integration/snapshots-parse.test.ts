import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildMetadataIndex, type EdmxModel, parseEdmx } from '../../src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const snapshotsDir = resolve(here, '../../../../snapshots')

interface SnapshotExpected {
  /** File name inside `snapshots/`. */
  file: string
  /** From spec §2.2 / §6.2 (snapshot 2026-05-05 — exact match required). */
  entityTypeCount: number
  complexTypeCount: number
  enumTypeCount: number
  functionImportCount: number
  /** EntityType with a ValueStorage attribute — `buildMetadataIndex` must list its bases. */
  valueStorage: { typeName: string; base: string }
  /** Seed for the `filter` option — must survive closure narrowing. */
  filterSeed: string
}

const FIXTURES: SnapshotExpected[] = [
  {
    file: 'trade_v11.5.xml',
    entityTypeCount: 3841,
    complexTypeCount: 1530,
    enumTypeCount: 953,
    functionImportCount: 2329,
    valueStorage: { typeName: 'Catalog_Файлы', base: 'ФайлХранилище' },
    filterSeed: 'Catalog_Валюты',
  },
  {
    file: 'bp_v3.0.xml',
    entityTypeCount: 3697,
    complexTypeCount: 1549,
    enumTypeCount: 873,
    functionImportCount: 2457,
    valueStorage: { typeName: 'Catalog_Файлы', base: 'ФайлХранилище' },
    filterSeed: 'Catalog_Валюты',
  },
]

describe('integration: real EDMX snapshots from snapshots/', () => {
  for (const fx of FIXTURES) {
    describe(fx.file, () => {
      // Read + parse once per fixture — XML is up to 16 MB, don't redo for every `it()`.
      // A parse failure fails the whole suite from beforeAll, which is the intent.
      let model: EdmxModel
      beforeAll(() => {
        const xml = readFileSync(resolve(snapshotsDir, fx.file), 'utf8')
        model = parseEdmx(xml)
      }, 30_000)

      it('parseEdmx() extracts the expected counts', () => {
        expect(model.schemaNamespace).toBe('StandardODATA')
        expect(model.entityTypes.length).toBe(fx.entityTypeCount)
        expect(model.complexTypes.length).toBe(fx.complexTypeCount)
        expect(model.enumTypes.length).toBe(fx.enumTypeCount)
        expect(model.entityContainer.functionImports.length).toBe(fx.functionImportCount)
      })

      it('buildMetadataIndex() covers the full model with resolved shape defaults', () => {
        const idx = buildMetadataIndex(model)

        expect(idx.schemaNamespace).toBe('StandardODATA')
        // One schema per EntityType + ComplexType (local names don't collide in 1С EDMX).
        expect(Object.keys(idx.schemas).length).toBe(fx.entityTypeCount + fx.complexTypeCount)
        // One mapping per EntitySet — parity with the parsed container.
        expect(Object.keys(idx.entitySetToType).length).toBe(model.entityContainer.entitySets.length)
        // Shape is ALWAYS persisted with resolved defaults (runtime parser contract).
        expect(idx.shape).toEqual({ int64Mode: 'number', dateMode: 'date' })
        // Enum catalog is deduped first-occurrence-wins, so it may be smaller.
        const enumCount = Object.keys(idx.enums ?? {}).length
        expect(enumCount).toBeGreaterThan(0)
        expect(enumCount).toBeLessThanOrEqual(fx.enumTypeCount)

        // ValueStorage triples are detected and listed for the runtime parser.
        expect(idx.schemas[fx.valueStorage.typeName]?.valueStorages).toContain(fx.valueStorage.base)
      }, 60_000)

      it('buildMetadataIndex({ filter }) narrows to the dependency closure', () => {
        const full = buildMetadataIndex(model)
        const narrowed = buildMetadataIndex(model, { filter: (name) => name === fx.filterSeed })

        // The seed survives, with its entity set mapping intact.
        expect(narrowed.schemas[fx.filterSeed]).toBeDefined()
        expect(narrowed.entitySetToType[fx.filterSeed]).toBe(fx.filterSeed)
        // Closure may pull in nav-prop targets, but stays far below the full model.
        const narrowedCount = Object.keys(narrowed.schemas).length
        expect(narrowedCount).toBeGreaterThan(0)
        expect(narrowedCount).toBeLessThan(Object.keys(full.schemas).length / 2)
        for (const [set, typeName] of Object.entries(narrowed.entitySetToType)) {
          expect(narrowed.schemas[typeName], `entity set ${set} maps to a type missing from schemas`).toBeDefined()
        }
      }, 60_000)
    })
  }
})
