import { describe, expect, it } from 'vitest'
import { parseEdmx } from '../../../src/codegen/parser/edmx-parser.js'

const EMPTY_EDMX = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
  <edmx:DataServices m:DataServiceVersion="3.0" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
    <Schema Namespace="StandardODATA" xmlns="http://schemas.microsoft.com/ado/2009/11/edm"/>
  </edmx:DataServices>
</edmx:Edmx>`

describe('parseEdmx — schema namespace + empty document', () => {
  it('extracts Schema Namespace="StandardODATA"', () => {
    const model = parseEdmx(EMPTY_EDMX)
    expect(model.schemaNamespace).toBe('StandardODATA')
  })

  it('returns empty arrays for entityTypes/complexTypes/enumTypes/associations', () => {
    const model = parseEdmx(EMPTY_EDMX)
    expect(model.entityTypes).toEqual([])
    expect(model.complexTypes).toEqual([])
    expect(model.enumTypes).toEqual([])
    expect(model.associations).toEqual([])
  })

  it('returns an empty EntityContainer when none declared', () => {
    const model = parseEdmx(EMPTY_EDMX)
    expect(model.entityContainer.entitySets).toEqual([])
    expect(model.entityContainer.functionImports).toEqual([])
  })

  it('throws on malformed XML', () => {
    expect(() => parseEdmx('<not><xml')).toThrow()
  })

  it('throws when Schema element is missing', () => {
    const noSchema =
      '<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0"><edmx:DataServices/></edmx:Edmx>'
    expect(() => parseEdmx(noSchema)).toThrow(/schema/i)
  })
})

const ENTITY_EDMX = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
  <edmx:DataServices m:DataServiceVersion="3.0" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
    <Schema Namespace="StandardODATA" xmlns="http://schemas.microsoft.com/ado/2009/11/edm">
      <EntityType Name="Catalog_Валюты">
        <Key><PropertyRef Name="Ref_Key"/></Key>
        <Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/>
        <Property Name="DataVersion" Type="Edm.String" Nullable="false" MaxLength="8"/>
        <Property Name="DeletionMark" Type="Edm.Boolean" Nullable="false"/>
        <Property Name="Code" Type="Edm.String" Nullable="false" MaxLength="3"/>
        <Property Name="Description" Type="Edm.String" Nullable="false" MaxLength="100"/>
        <NavigationProperty Name="Владелец" Relationship="StandardODATA.Cat_Owner" FromRole="Source" ToRole="Target"/>
      </EntityType>
      <EntityType Name="Document_РТУ_Товары">
        <Key>
          <PropertyRef Name="Ref_Key"/>
          <PropertyRef Name="LineNumber"/>
        </Key>
        <Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/>
        <Property Name="LineNumber" Type="Edm.Int64" Nullable="false"/>
        <Property Name="Количество" Type="Edm.Double" Nullable="false"/>
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`

describe('parseEdmx — EntityType', () => {
  it('extracts both header and tabular EntityType with their keys', () => {
    const model = parseEdmx(ENTITY_EDMX)
    expect(model.entityTypes).toHaveLength(2)
    const cat = model.entityTypes.find((e) => e.name === 'Catalog_Валюты')
    expect(cat?.key).toEqual(['Ref_Key'])
    expect(cat?.properties).toHaveLength(5)
    expect(cat?.properties[0]).toMatchObject({ name: 'Ref_Key', type: 'Edm.Guid', nullable: false })
    expect(cat?.properties[3]).toMatchObject({ name: 'Code', maxLength: 3 })
    const tab = model.entityTypes.find((e) => e.name === 'Document_РТУ_Товары')
    expect(tab?.key).toEqual(['Ref_Key', 'LineNumber'])
  })

  it('extracts NavigationProperty with relationship + roles', () => {
    const model = parseEdmx(ENTITY_EDMX)
    const cat = model.entityTypes.find((e) => e.name === 'Catalog_Валюты')
    expect(cat).toBeDefined()
    expect(cat?.navigationProperties).toHaveLength(1)
    expect(cat?.navigationProperties[0]).toMatchObject({
      name: 'Владелец',
      relationship: 'StandardODATA.Cat_Owner',
      fromRole: 'Source',
      toRole: 'Target',
    })
  })
})

const COMPLEX_AND_ENUM_EDMX = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
  <edmx:DataServices m:DataServiceVersion="3.0" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
    <Schema Namespace="StandardODATA" xmlns="http://schemas.microsoft.com/ado/2009/11/edm">
      <ComplexType Name="Document_РТУ_Товары_RowType">
        <Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/>
        <Property Name="LineNumber" Type="Edm.Int64" Nullable="false"/>
        <Property Name="Количество" Type="Edm.Double" Nullable="false"/>
      </ComplexType>
      <ComplexType Name="TypeDescription">
        <Property Name="Types" Type="Collection(Edm.String)" Nullable="false"/>
      </ComplexType>
      <EnumType Name="ВидНоменклатуры" UnderlyingType="Edm.Int32">
        <Member Name="Товар" Value="0"/>
        <Member Name="Услуга" Value="1"/>
      </EnumType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`

describe('parseEdmx — ComplexType + EnumType', () => {
  it('extracts ComplexType definitions', () => {
    const model = parseEdmx(COMPLEX_AND_ENUM_EDMX)
    expect(model.complexTypes).toHaveLength(2)
    const row = model.complexTypes.find((c) => c.name === 'Document_РТУ_Товары_RowType')
    expect(row?.properties).toHaveLength(3)
    expect(row?.properties[1]).toMatchObject({ name: 'LineNumber', type: 'Edm.Int64' })
  })

  it('extracts EnumType with members + underlyingType', () => {
    const model = parseEdmx(COMPLEX_AND_ENUM_EDMX)
    expect(model.enumTypes).toHaveLength(1)
    const en = model.enumTypes[0]
    expect(en).toBeDefined()
    expect(en?.name).toBe('ВидНоменклатуры')
    expect(en?.underlyingType).toBe('Edm.Int32')
    expect(en?.members).toEqual([
      { name: 'Товар', value: 0 },
      { name: 'Услуга', value: 1 },
    ])
  })
})

const CONTAINER_EDMX = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
  <edmx:DataServices m:DataServiceVersion="3.0" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
    <Schema Namespace="StandardODATA" xmlns="http://schemas.microsoft.com/ado/2009/11/edm">
      <EntityType Name="Catalog_Контрагенты">
        <Key><PropertyRef Name="Ref_Key"/></Key>
        <Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/>
      </EntityType>
      <EntityType Name="Document_РТУ">
        <Key><PropertyRef Name="Ref_Key"/></Key>
        <Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/>
        <NavigationProperty Name="Контрагент" Relationship="StandardODATA.Doc_Контрагент" FromRole="Source" ToRole="Target"/>
      </EntityType>
      <Association Name="Doc_Контрагент">
        <End Role="Source" Type="StandardODATA.Document_РТУ" Multiplicity="*"/>
        <End Role="Target" Type="StandardODATA.Catalog_Контрагенты" Multiplicity="0..1"/>
      </Association>
      <EntityContainer Name="StandardODATA" m:IsDefaultEntityContainer="true">
        <EntitySet Name="Catalog_Контрагенты" EntityType="StandardODATA.Catalog_Контрагенты"/>
        <EntitySet Name="Document_РТУ" EntityType="StandardODATA.Document_РТУ"/>
        <FunctionImport Name="Post" m:HttpMethod="POST" IsBindable="true" EntitySetPath="Document_РТУ">
          <Parameter Name="ref" Type="Edm.String" Nullable="false" Mode="In"/>
        </FunctionImport>
        <FunctionImport Name="Balance" ReturnType="Collection(StandardODATA.AR_Balance)" m:HttpMethod="GET" IsBindable="true" EntitySetPath="AR">
          <Parameter Name="Period" Type="Edm.DateTime" Nullable="true" Mode="In"/>
          <Parameter Name="Condition" Type="Edm.String" Nullable="true" Mode="In"/>
        </FunctionImport>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`

describe('parseEdmx — EntityContainer + Association', () => {
  it('extracts EntitySets + FunctionImports', () => {
    const model = parseEdmx(CONTAINER_EDMX)
    expect(model.entityContainer.entitySets).toHaveLength(2)
    expect(model.entityContainer.entitySets[0]).toMatchObject({
      name: 'Catalog_Контрагенты',
      entityType: 'StandardODATA.Catalog_Контрагенты',
    })
    expect(model.entityContainer.functionImports).toHaveLength(2)
    const post = model.entityContainer.functionImports.find((f) => f.name === 'Post')
    expect(post).toMatchObject({ httpMethod: 'POST', isBindable: true, entitySetPath: 'Document_РТУ' })
    expect(post?.parameters).toEqual([{ name: 'ref', type: 'Edm.String', nullable: false, mode: 'In' }])
    const bal = model.entityContainer.functionImports.find((f) => f.name === 'Balance')
    expect(bal?.returnType).toBe('Collection(StandardODATA.AR_Balance)')
    expect(bal?.parameters).toHaveLength(2)
  })

  it('extracts Association ends', () => {
    const model = parseEdmx(CONTAINER_EDMX)
    expect(model.associations).toHaveLength(1)
    expect(model.associations[0]?.ends).toHaveLength(2)
    expect(model.associations[0]?.ends[0]).toMatchObject({
      role: 'Source',
      type: 'StandardODATA.Document_РТУ',
      multiplicity: '*',
    })
  })

  it('resolves NavigationProperty.resolvedTargetType via Association', () => {
    const model = parseEdmx(CONTAINER_EDMX)
    const doc = model.entityTypes.find((e) => e.name === 'Document_РТУ')
    expect(doc).toBeDefined()
    expect(doc?.navigationProperties[0]?.resolvedTargetType).toBe('StandardODATA.Catalog_Контрагенты')
  })
})

// 1C real-world EDMX V3: FunctionImports use a `bindingParameter` Parameter
// with `Type="<Schema>.<EntitySet>"` instead of an `EntitySetPath` attribute.
// Write FIs (Post/Unpost/…) often omit `m:HttpMethod` entirely and signal
// POST via `IsSideEffecting="true"`.
const BINDING_PARAM_EDMX = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
  <edmx:DataServices m:DataServiceVersion="3.0" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
    <Schema Namespace="StandardODATA" xmlns="http://schemas.microsoft.com/ado/2009/11/edm">
      <EntityType Name="AccountingRegister_Хозрасчетный">
        <Key><PropertyRef Name="Ref_Key"/></Key>
        <Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/>
      </EntityType>
      <EntityType Name="Document_РТУ">
        <Key><PropertyRef Name="Ref_Key"/></Key>
        <Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/>
      </EntityType>
      <EntityContainer Name="StandardODATA" m:IsDefaultEntityContainer="true">
        <EntitySet Name="AccountingRegister_Хозрасчетный" EntityType="StandardODATA.AccountingRegister_Хозрасчетный"/>
        <EntitySet Name="Document_РТУ" EntityType="StandardODATA.Document_РТУ"/>
        <FunctionImport Name="DrCrTurnovers" IsBindable="true" IsSideEffecting="false" ReturnType="Collection(StandardODATA.AR_Turnover)">
          <Parameter Name="bindingParameter" Type="StandardODATA.AccountingRegister_Хозрасчетный"/>
          <Parameter Name="StartDate" Type="Edm.DateTime"/>
        </FunctionImport>
        <FunctionImport Name="Post" IsBindable="true" IsSideEffecting="true">
          <Parameter Name="bindingParameter" Type="StandardODATA.Document_РТУ"/>
        </FunctionImport>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`

describe('parseEdmx — attribute validation', () => {
  const wrap = (body: string) => `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
  <edmx:DataServices m:DataServiceVersion="3.0" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
    <Schema Namespace="StandardODATA" xmlns="http://schemas.microsoft.com/ado/2009/11/edm">
      ${body}
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`

  it('throws when <Property> has no Type attribute', () => {
    const xml = wrap(`<EntityType Name="X">
        <Key><PropertyRef Name="Ref_Key"/></Key>
        <Property Name="Ref_Key"/>
      </EntityType>`)
    expect(() => parseEdmx(xml)).toThrow(/<Property Name="Ref_Key">.*Type/)
  })

  it('throws when <Property> Type attribute is empty', () => {
    const xml = wrap(`<EntityType Name="X">
        <Key><PropertyRef Name="Ref_Key"/></Key>
        <Property Name="Ref_Key" Type=""/>
      </EntityType>`)
    expect(() => parseEdmx(xml)).toThrow(/<Property Name="Ref_Key">.*Type/)
  })

  it('throws when <Parameter> has no Type attribute', () => {
    const xml = wrap(`<EntityContainer Name="C" m:IsDefaultEntityContainer="true">
        <FunctionImport Name="F" m:HttpMethod="GET">
          <Parameter Name="P"/>
        </FunctionImport>
      </EntityContainer>`)
    expect(() => parseEdmx(xml)).toThrow(/<Parameter Name="P">.*Type/)
  })

  it('throws when <Property> has no Name attribute', () => {
    const xml = wrap(`<EntityType Name="X">
        <Key><PropertyRef Name="Ref_Key"/></Key>
        <Property Type="Edm.String"/>
      </EntityType>`)
    expect(() => parseEdmx(xml)).toThrow(/<Property>.*Name/)
  })
})

describe('parseEdmx — FunctionImport bindingParameter fallback (1C V3)', () => {
  it('derives entitySetPath from bindingParameter when EntitySetPath attribute is absent', () => {
    const model = parseEdmx(BINDING_PARAM_EDMX)
    const dr = model.entityContainer.functionImports.find((f) => f.name === 'DrCrTurnovers')
    expect(dr?.entitySetPath).toBe('AccountingRegister_Хозрасчетный')
    const post = model.entityContainer.functionImports.find((f) => f.name === 'Post')
    expect(post?.entitySetPath).toBe('Document_РТУ')
  })

  it('infers POST from IsSideEffecting="true" when m:HttpMethod is absent', () => {
    const model = parseEdmx(BINDING_PARAM_EDMX)
    const post = model.entityContainer.functionImports.find((f) => f.name === 'Post')
    expect(post?.httpMethod).toBe('POST')
  })

  it('defaults to GET when neither m:HttpMethod nor IsSideEffecting="true" is present', () => {
    const model = parseEdmx(BINDING_PARAM_EDMX)
    const dr = model.entityContainer.functionImports.find((f) => f.name === 'DrCrTurnovers')
    expect(dr?.httpMethod).toBe('GET')
  })
})
