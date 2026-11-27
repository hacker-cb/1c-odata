import type { MetadataIndex } from '@1c-odata/client'
import { buildMetadataIndex, type EdmxModel, parseEdmx } from '@1c-odata/metadata'
import { describe, expect, it } from 'vitest'
import { describeEntity, selectEntities } from '../../src/tools/schema-logic.js'

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
    expect(d).toMatchObject({ entitySet: '__proto__', entityType: '__proto__', name: '__proto__', kind: null })
    expect(selectEntities(idx, { name: '__proto__' }).map((e) => e.name)).toEqual(['__proto__'])
    expect(d.properties).toEqual([{ name: 'Ref_Key', type: 'Edm.Guid', nullable: false }])
  })
})

describe('list_entities and describe_entity agree on a set whose type has no schema', () => {
  // An EntitySet whose type lies in another namespace — not from 1С. buildMetadataIndex leaves it out of
  // entitySetToType, so neither tool shows it.
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
  <edmx:DataServices m:DataServiceVersion="3.0" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
    <Schema Namespace="StandardODATA" xmlns="http://schemas.microsoft.com/ado/2009/11/edm">
      <EntityType Name="Catalog_X">
        <Key><PropertyRef Name="Ref_Key"/></Key>
        <Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/>
      </EntityType>
      <EntityContainer Name="StandardODATA" m:IsDefaultEntityContainer="true">
        <EntitySet Name="Catalog_X" EntityType="StandardODATA.Catalog_X"/>
        <EntitySet Name="Foreign_Set" EntityType="Other.Catalog_Y"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`
  const model = parseEdmx(xml)
  const idx = buildMetadataIndex(model)

  it('neither lists nor describes it', () => {
    expect(selectEntities(idx).map((e) => e.entitySet)).toEqual(['Catalog_X'])
    expect(() => describeEntity(idx, model, 'Foreign_Set')).toThrow(/Unknown entity/)
    expect(describeEntity(idx, model, 'Catalog_X')).toMatchObject({ entitySet: 'Catalog_X', keys: ['Ref_Key'] })
  })
})
