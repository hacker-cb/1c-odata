import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MetadataIndex } from '@1c-odata/client'
import { buildMetadataIndex, type EdmxModel, parseEdmx } from '@1c-odata/metadata'
import { beforeAll, describe, expect, it } from 'vitest'
import { describeEntity, selectEntities } from '../../src/tools/schema-logic.js'

// Offline coverage of the schema-tool logic against a committed EDMX snapshot —
// the same fixtures the codegen integration tests pin. No network.
const here = dirname(fileURLToPath(import.meta.url))
const snapshot = resolve(here, '../../../../snapshots/trade_v11.5.xml')

describe('schema tools against trade_v11.5 snapshot', () => {
  let index: MetadataIndex
  let edmx: EdmxModel

  beforeAll(() => {
    const xml = readFileSync(snapshot, 'utf8')
    edmx = parseEdmx(xml)
    index = buildMetadataIndex(edmx)
  }, 60_000)

  it('selectEntities returns only catalogs when filtered by kind', () => {
    const catalogs = selectEntities(index, { kind: 'catalog' })
    expect(catalogs.length).toBeGreaterThan(0)
    expect(catalogs.every((c) => c.kind === 'catalog')).toBe(true)
  })

  it('selectEntities filters by a name substring', () => {
    const matched = selectEntities(index, { kind: 'catalog', name: 'Валюты' })
    expect(matched.some((c) => c.entitySet === 'Catalog_Валюты')).toBe(true)
    expect(
      matched.every((c) => c.entitySet.toLowerCase().includes('валюты') || c.name.toLowerCase().includes('валюты')),
    ).toBe(true)
  })

  it('selectEntities is sorted by entity-set name', () => {
    const all = selectEntities(index)
    const sorted = [...all].sort((a, b) => a.entitySet.localeCompare(b.entitySet))
    expect(all.map((e) => e.entitySet)).toEqual(sorted.map((e) => e.entitySet))
  })

  it('describeEntity resolves an entity-set name to keys, properties, navigation', () => {
    const d = describeEntity(index, edmx, 'Catalog_Валюты')
    expect(d.entityType).toBe('Catalog_Валюты')
    expect(d.kind).toBe('catalog')
    expect(d.keys).toContain('Ref_Key')
    expect(d.properties.some((p) => p.name === 'Description')).toBe(true)
    expect(d.properties.every((p) => typeof p.type === 'string' && typeof p.nullable === 'boolean')).toBe(true)
  })

  it('describeEntity throws on an unknown name', () => {
    expect(() => describeEntity(index, edmx, 'Nope_NotReal')).toThrow(/Unknown entity/)
  })
})
