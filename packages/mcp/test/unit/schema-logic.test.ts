import type { MetadataIndex } from '@1c-odata/client'
import type { EdmxModel } from '@1c-odata/metadata'
import { describe, expect, it } from 'vitest'
import { describeEntity } from '../../src/tools/schema-logic.js'

// Minimal index/edmx with intentionally plain-object maps (as built by
// @1c-odata/metadata), so prototype-chain keys are reachable if not guarded.
const index = { schemas: {}, entitySetToType: {} } as unknown as MetadataIndex
const edmx = { entityTypes: [] } as unknown as EdmxModel

describe('describeEntity', () => {
  it('throws "Unknown entity" for a name that is in neither map', () => {
    expect(() => describeEntity(index, edmx, 'Catalog_DoesNotExist')).toThrow(/Unknown entity/)
  })

  it('rejects prototype-chain keys instead of resolving them as entities', () => {
    // Without own-key guards, `index.entitySetToType["__proto__"]` resolves up the
    // prototype chain to a non-string and crashes classifyEntity/tailName. These
    // must be treated like any other unknown name.
    for (const evil of ['__proto__', 'constructor', 'hasOwnProperty', 'toString', 'valueOf']) {
      expect(() => describeEntity(index, edmx, evil)).toThrow(/Unknown entity/)
    }
  })

  it('describes every set list_entities lists — a set whose type has no schema too, without properties', () => {
    const idx = {
      schemaNamespace: 'StandardODATA',
      schemas: { Catalog_X: { properties: { Ref_Key: { type: 'Edm.Guid', nullable: false } } } },
      entitySetToType: { Catalog_X: 'Catalog_X', Catalog_Orphan: 'Catalog_Missing' },
    } as unknown as MetadataIndex
    expect(describeEntity(idx, edmx, 'Catalog_X')).toMatchObject({ entitySet: 'Catalog_X', entityType: 'Catalog_X' })
    expect(describeEntity(idx, edmx, 'Catalog_Orphan')).toMatchObject({
      entitySet: 'Catalog_Orphan',
      entityType: 'Catalog_Missing',
      properties: [],
    })
  })

  it('resolves a set and a type named `__proto__` held as own keys', () => {
    const idx = JSON.parse(
      '{"schemaNamespace":"StandardODATA","schemas":{"__proto__":{"properties":{"Ref_Key":{"type":"Edm.Guid","nullable":false}}}},"entitySetToType":{"__proto__":"__proto__"}}',
    ) as MetadataIndex
    const d = describeEntity(idx, edmx, '__proto__')
    expect(d).toMatchObject({ entitySet: '__proto__', entityType: '__proto__' })
    expect(d.properties).toEqual([{ name: 'Ref_Key', type: 'Edm.Guid', nullable: false }])
  })
})
