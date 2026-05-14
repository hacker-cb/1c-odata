import { describe, expect, it } from 'vitest'
import { generate } from '../../../src/codegen/index.js'

const EDMX = `<?xml version="1.0"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
  <edmx:DataServices m:DataServiceVersion="3.0" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
    <Schema Namespace="StandardODATA" xmlns="http://schemas.microsoft.com/ado/2009/11/edm">
      <EntityType Name="Catalog_X">
        <Key><PropertyRef Name="Ref_Key"/></Key>
        <Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/>
        <Property Name="Code" Type="Edm.String" Nullable="false" MaxLength="3"/>
        <Property Name="Description" Type="Edm.String" Nullable="true" MaxLength="25"/>
        <Property Name="Note" Type="Edm.String"/>
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`

describe('__metadata.json schemas section', () => {
  it('emits maxLength and nullable for every property', () => {
    const r = generate({ metadata: EDMX })
    const meta = JSON.parse(r.files.get('__metadata.json') ?? '{}')

    expect(meta.schemas).toBeDefined()
    expect(meta.schemas.Catalog_X).toBeDefined()
    expect(meta.schemas.Catalog_X.properties.Ref_Key).toEqual({
      type: 'Edm.Guid',
      nullable: false,
    })
    expect(meta.schemas.Catalog_X.properties.Code).toEqual({
      type: 'Edm.String',
      nullable: false,
      maxLength: 3,
    })
    expect(meta.schemas.Catalog_X.properties.Description).toEqual({
      type: 'Edm.String',
      nullable: true,
      maxLength: 25,
    })
    expect(meta.schemas.Catalog_X.properties.Note).toEqual({
      type: 'Edm.String',
      nullable: true,
    })
  })

  it('emits enums section with members and values', () => {
    const xml = `<?xml version="1.0"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
  <edmx:DataServices m:DataServiceVersion="3.0" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
    <Schema Namespace="StandardODATA" xmlns="http://schemas.microsoft.com/ado/2009/11/edm">
      <EnumType Name="ВидыНоменклатуры" UnderlyingType="Edm.Int32">
        <Member Name="Товар" Value="0"/>
        <Member Name="Услуга" Value="1"/>
      </EnumType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`
    const r = generate({ metadata: xml })
    const meta = JSON.parse(r.files.get('__metadata.json') ?? '{}')
    expect(meta.enums).toBeDefined()
    expect(meta.enums.ВидыНоменклатуры).toEqual({
      underlyingType: 'Edm.Int32',
      members: [
        { name: 'Товар', value: 0 },
        { name: 'Услуга', value: 1 },
      ],
    })
  })

  it('emits valueStorages for entity with <X> Edm.Stream + <X>_Base64Data + <X>_Type triple', () => {
    const xml = `<?xml version="1.0"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
  <edmx:DataServices m:DataServiceVersion="3.0" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
    <Schema Namespace="StandardODATA" xmlns="http://schemas.microsoft.com/ado/2009/11/edm">
      <EntityType Name="Catalog_X">
        <Key><PropertyRef Name="Ref_Key"/></Key>
        <Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/>
        <Property Name="File" Type="Edm.Stream" Nullable="true"/>
        <Property Name="File_Base64Data" Type="Edm.Binary" Nullable="true"/>
        <Property Name="File_Type" Type="Edm.String" Nullable="true"/>
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`
    const r = generate({ metadata: xml })
    const meta = JSON.parse(r.files.get('__metadata.json') ?? '{}')
    expect(meta.schemas.Catalog_X.valueStorages).toEqual(['File'])
  })

  it('persists resolved DataShape defaults when no options are set', () => {
    // Codegen-time defaults (int64Mode='number', dateMode='date') must propagate
    // into metadataIndex.shape so the runtime parser sees them. Otherwise generated
    // TS expects `number` while parser returns wire string — type contract broken.
    const r = generate({ metadata: EDMX })
    const meta = JSON.parse(r.files.get('__metadata.json') ?? '{}')
    expect(meta.shape).toEqual({ int64Mode: 'number', dateMode: 'date' })
  })

  it('persists schemaNamespace at top level for runtime MetadataIndex resolution', () => {
    // Task 15 — runtime needs schema namespace to resolve sub-type references
    // (e.g. Collection(StandardODATA.Foo_RowType)) by stripping the prefix.
    const r = generate({ metadata: EDMX })
    const meta = JSON.parse(r.files.get('__metadata.json') ?? '{}')
    expect(meta.schemaNamespace).toBe('StandardODATA')
  })

  it('emits entitySetToType map (entitySetName → entityTypeLocalName)', () => {
    const EDMX_WITH_SETS = `<?xml version="1.0"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
  <edmx:DataServices m:DataServiceVersion="3.0" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
    <Schema Namespace="StandardODATA" xmlns="http://schemas.microsoft.com/ado/2009/11/edm">
      <EntityType Name="Catalog_X">
        <Key><PropertyRef Name="Ref_Key"/></Key>
        <Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/>
      </EntityType>
      <EntityContainer Name="StandardODATA" m:IsDefaultEntityContainer="true">
        <EntitySet Name="Catalog_X" EntityType="StandardODATA.Catalog_X"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`
    const r = generate({ metadata: EDMX_WITH_SETS })
    const meta = JSON.parse(r.files.get('__metadata.json') ?? '{}')
    expect(meta.entitySetToType).toEqual({ Catalog_X: 'Catalog_X' })
  })
})
