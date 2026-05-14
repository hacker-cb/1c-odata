import { describe, expect, it } from 'vitest'
import { generate } from '../../../src/codegen/index.js'

describe('@maxLength JSDoc tag', () => {
  it('emits @maxLength N JSDoc tag on EntityType properties with MaxLength', () => {
    const EDMX = `<?xml version="1.0"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
  <edmx:DataServices m:DataServiceVersion="3.0" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
    <Schema Namespace="StandardODATA" xmlns="http://schemas.microsoft.com/ado/2009/11/edm">
      <EntityType Name="Catalog_Y">
        <Key><PropertyRef Name="Ref_Key"/></Key>
        <Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/>
        <Property Name="Code" Type="Edm.String" MaxLength="11"/>
        <Property Name="Description" Type="Edm.String" Nullable="true" MaxLength="25"/>
        <Property Name="Note" Type="Edm.String"/>
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`
    const r = generate({ metadata: EDMX })
    const file = r.files.get('catalogs/Y.ts') ?? ''
    expect(file).toMatch(/@maxLength 11/)
    expect(file).toMatch(/@maxLength 25/)
    expect(file).toMatch(/Code\??:/)
    expect(file).toMatch(/Description\??:/)
    // Property `Note` has no MaxLength → exactly two `@maxLength` tags total (Code, Description).
    const matches = file.match(/@maxLength/g) ?? []
    expect(matches).toHaveLength(2)
  })

  it('emits @maxLength N JSDoc tag on ComplexType properties with MaxLength', () => {
    const EDMX = `<?xml version="1.0"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
  <edmx:DataServices m:DataServiceVersion="3.0" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
    <Schema Namespace="StandardODATA" xmlns="http://schemas.microsoft.com/ado/2009/11/edm">
      <ComplexType Name="MyDescription">
        <Property Name="Kind" Type="Edm.String" Nullable="true" MaxLength="50"/>
        <Property Name="Value" Type="Edm.String" Nullable="true"/>
      </ComplexType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`
    const r = generate({ metadata: EDMX })
    const file = r.files.get('complex-types.ts') ?? ''
    expect(file).toMatch(/@maxLength 50/)
    expect(file).toMatch(/Kind\?:/)
  })
})
