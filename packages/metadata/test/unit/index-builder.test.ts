import { parseMetadataIndex } from '@1c-odata/client'
import { describe, expect, it } from 'vitest'
import { buildMetadataIndex } from '../../src/index-builder.js'
import { parseEdmx } from '../../src/parser/edmx-parser.js'

// Not from 1С — an EDMX whose names include `__proto__`, the one key plain assignment cannot add to `{}` (#275).
const PROTO_EDMX = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
  <edmx:DataServices m:DataServiceVersion="3.0" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
    <Schema Namespace="StandardODATA" xmlns="http://schemas.microsoft.com/ado/2009/11/edm">
      <EntityType Name="__proto__">
        <Key><PropertyRef Name="Ref_Key"/></Key>
        <Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/>
        <Property Name="__proto__" Type="Edm.Int64" Nullable="true"/>
      </EntityType>
      <EntityType Name="Catalog_X">
        <Key><PropertyRef Name="Ref_Key"/></Key>
        <Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/>
      </EntityType>
      <EntityContainer Name="StandardODATA" m:IsDefaultEntityContainer="true">
        <EntitySet Name="__proto__" EntityType="StandardODATA.__proto__"/>
        <EntitySet Name="Catalog_X" EntityType="StandardODATA.Catalog_X"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`

describe('buildMetadataIndex — a name `__proto__` is an own key, never a prototype (#275)', () => {
  const index = buildMetadataIndex(parseEdmx(PROTO_EDMX))

  it('holds a type, a property and a set named `__proto__` as own entries; the dictionaries stay plain objects', () => {
    expect(Object.keys(index.schemas)).toEqual(['__proto__', 'Catalog_X'])
    expect(Object.getPrototypeOf(index.schemas)).toBe(Object.prototype)
    const proto = Object.getOwnPropertyDescriptor(index.schemas, '__proto__')?.value
    expect(Object.keys(proto.properties)).toEqual(['Ref_Key', '__proto__'])
    expect(Object.getPrototypeOf(proto.properties)).toBe(Object.prototype)
    expect(Object.getOwnPropertyDescriptor(proto.properties, '__proto__')?.value).toEqual({
      type: 'Edm.Int64',
      nullable: true,
    })
    expect(Object.keys(index.entitySetToType)).toEqual(['__proto__', 'Catalog_X'])
    expect(Object.getOwnPropertyDescriptor(index.entitySetToType, '__proto__')?.value).toBe('__proto__')
    expect(Object.getPrototypeOf(index.entitySetToType)).toBe(Object.prototype)
  })

  it('passes parseMetadataIndex, built and through a JSON round trip', () => {
    expect(parseMetadataIndex(index)).toBe(index)
    const revived = parseMetadataIndex(JSON.parse(JSON.stringify(index)))
    expect(Object.keys(revived.schemas)).toEqual(['__proto__', 'Catalog_X'])
    expect(revived.entitySetToType).toEqual(index.entitySetToType)
  })
})
