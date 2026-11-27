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

// An EntitySet whose type lies in another namespace, and one whose type the EDMX lacks — not from 1С.
const DANGLING_EDMX = `<?xml version="1.0" encoding="utf-8"?>
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
        <EntitySet Name="Missing_Set" EntityType="StandardODATA.Catalog_Missing"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`

describe('buildMetadataIndex — a set whose type has no schema is left out', () => {
  it('lists only sets whose type `schemas` holds, and the index loads through a JSON round trip', () => {
    const model = parseEdmx(DANGLING_EDMX)
    expect(model.entityContainer.entitySets.map((s) => s.name)).toEqual(['Catalog_X', 'Foreign_Set', 'Missing_Set'])
    const index = buildMetadataIndex(model)
    expect(index.entitySetToType).toEqual({ Catalog_X: 'Catalog_X' })
    expect(() => parseMetadataIndex(JSON.parse(JSON.stringify(index)))).not.toThrow()
  })

  it('the filtered build drops them too', () => {
    const index = buildMetadataIndex(parseEdmx(DANGLING_EDMX), { filter: () => true })
    expect(index.entitySetToType).toEqual({ Catalog_X: 'Catalog_X' })
  })
})

// Navigation properties (#283): the 1С shape (`0..1` target end), a `*` end 1С never declares, an Association
// the EDMX lacks, and a target in another namespace — the last three not from 1С.
const NAV_EDMX = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
  <edmx:DataServices m:DataServiceVersion="3.0" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
    <Schema Namespace="StandardODATA" xmlns="http://schemas.microsoft.com/ado/2009/11/edm">
      <EntityType Name="Document_X">
        <Key><PropertyRef Name="Ref_Key"/></Key>
        <Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/>
        <Property Name="Файл" Type="Edm.Stream" Nullable="true"/>
        <Property Name="Файл_Base64Data" Type="Edm.Binary" Nullable="true"/>
        <Property Name="Файл_Type" Type="Edm.String" Nullable="true"/>
        <Property Name="Контрагент_Key" Type="Edm.Guid" Nullable="true"/>
        <NavigationProperty Name="Контрагент" Relationship="StandardODATA.Document_X_Контрагент" FromRole="Begin" ToRole="End"/>
        <NavigationProperty Name="Строки" Relationship="StandardODATA.Document_X_Строки" FromRole="Begin" ToRole="End"/>
        <NavigationProperty Name="Потерянная" Relationship="StandardODATA.Нет" FromRole="Begin" ToRole="End"/>
        <NavigationProperty Name="Чужая" Relationship="StandardODATA.Document_X_Чужая" FromRole="Begin" ToRole="End"/>
      </EntityType>
      <EntityType Name="Catalog_Контрагенты">
        <Key><PropertyRef Name="Ref_Key"/></Key>
        <Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/>
        <Property Name="Код" Type="Edm.Int64" Nullable="false"/>
      </EntityType>
      <EntityType Name="Catalog_Строки">
        <Key><PropertyRef Name="Ref_Key"/></Key>
        <Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/>
      </EntityType>
      <EntityType Name="Catalog_Y">
        <Key><PropertyRef Name="Ref_Key"/></Key>
        <Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/>
      </EntityType>
      <Association Name="Document_X_Контрагент">
        <End Role="Begin" Type="StandardODATA.Document_X" Multiplicity="*"/>
        <End Role="End" Type="StandardODATA.Catalog_Контрагенты" Multiplicity="0..1"/>
      </Association>
      <Association Name="Document_X_Строки">
        <End Role="Begin" Type="StandardODATA.Document_X" Multiplicity="0..1"/>
        <End Role="End" Type="StandardODATA.Catalog_Строки" Multiplicity="*"/>
      </Association>
      <Association Name="Document_X_Чужая">
        <End Role="Begin" Type="StandardODATA.Document_X" Multiplicity="*"/>
        <End Role="End" Type="Other.Catalog_Z" Multiplicity="0..1"/>
      </Association>
      <EntityContainer Name="StandardODATA" m:IsDefaultEntityContainer="true">
        <EntitySet Name="Document_X" EntityType="StandardODATA.Document_X"/>
        <EntitySet Name="Catalog_Контрагенты" EntityType="StandardODATA.Catalog_Контрагенты"/>
        <EntitySet Name="Catalog_Строки" EntityType="StandardODATA.Catalog_Строки"/>
        <EntitySet Name="Catalog_Y" EntityType="StandardODATA.Catalog_Y"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`

describe('buildMetadataIndex — navigation properties (#283)', () => {
  const index = buildMetadataIndex(parseEdmx(NAV_EDMX))

  it('records each resolvable navigation by its target local name; `collection: true` only for a `*` end', () => {
    expect(index.schemas.Document_X?.navigation).toEqual({
      Контрагент: { type: 'Catalog_Контрагенты' },
      Строки: { type: 'Catalog_Строки', collection: true },
    })
    // `collection` is written only where it is true — a 1С navigation carries `type` alone.
    expect(Object.keys(index.schemas.Document_X?.navigation?.Контрагент ?? {})).toEqual(['type'])
  })

  it('skips a navigation whose Association is missing or whose target lies in another namespace', () => {
    expect(index.schemas.Document_X?.navigation).not.toHaveProperty('Потерянная')
    expect(index.schemas.Document_X?.navigation).not.toHaveProperty('Чужая')
  })

  it('writes no `navigation` key for a type without navigations, and puts it after `valueStorages`', () => {
    expect(index.schemas.Catalog_Y).not.toHaveProperty('navigation')
    expect(Object.keys(index.schemas.Document_X ?? {})).toEqual(['properties', 'valueStorages', 'navigation'])
  })

  it('keeps only navigations whose target the filtered closure holds — the closure takes every target', () => {
    const narrowed = buildMetadataIndex(parseEdmx(NAV_EDMX), { filter: (name) => name === 'Document_X' })
    expect(Object.keys(narrowed.schemas).sort()).toEqual(['Catalog_Контрагенты', 'Catalog_Строки', 'Document_X'])
    expect(narrowed.schemas.Document_X?.navigation).toEqual(index.schemas.Document_X?.navigation)
  })

  it('takes the target parseEdmx resolved — a model carrying `resolvedTargetType` without its Associations', () => {
    const model = parseEdmx(NAV_EDMX)
    const built = buildMetadataIndex({ ...model, associations: [] })
    // No Association to read a multiplicity off: a single entity.
    expect(built.schemas.Document_X?.navigation).toEqual({
      Контрагент: { type: 'Catalog_Контрагенты' },
      Строки: { type: 'Catalog_Строки' },
    })
  })

  it('gives a type declared twice the navigations of its last declaration, as its schema', () => {
    const model = parseEdmx(NAV_EDMX)
    const doc = model.entityTypes.find((t) => t.name === 'Document_X')
    if (doc === undefined) throw new Error('fixture lacks Document_X')
    const lastWithout = buildMetadataIndex({
      ...model,
      entityTypes: [...model.entityTypes, { ...doc, navigationProperties: [] }],
    })
    expect(lastWithout.schemas.Document_X).not.toHaveProperty('navigation')
    const lastWith = buildMetadataIndex({
      ...model,
      entityTypes: [{ ...doc, navigationProperties: [] }, ...model.entityTypes],
    })
    expect(lastWith.schemas.Document_X?.navigation).toEqual(index.schemas.Document_X?.navigation)
  })

  it('passes parseMetadataIndex, built and through a JSON round trip', () => {
    expect(parseMetadataIndex(index)).toBe(index)
    expect(parseMetadataIndex(JSON.parse(JSON.stringify(index))).schemas.Document_X?.navigation).toEqual(
      index.schemas.Document_X?.navigation,
    )
  })
})

describe('buildMetadataIndex — a ComplexType records its storages too (#290)', () => {
  const edmx = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
  <edmx:DataServices m:DataServiceVersion="3.0" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
    <Schema Namespace="StandardODATA" xmlns="http://schemas.microsoft.com/ado/2009/11/edm">
      <EntityType Name="Document_X">
        <Key><PropertyRef Name="Ref_Key"/></Key>
        <Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/>
        <Property Name="Товары" Type="Collection(StandardODATA.Document_X_Товары_RowType)" Nullable="true"/>
      </EntityType>
      <ComplexType Name="Document_X_Товары_RowType">
        <Property Name="LineNumber" Type="Edm.Int64" Nullable="false"/>
        <Property Name="Параметры" Type="Edm.Stream" Nullable="true"/>
        <Property Name="Параметры_Base64Data" Type="Edm.Binary" Nullable="true"/>
        <Property Name="Параметры_Type" Type="Edm.String" Nullable="true"/>
      </ComplexType>
      <EntityContainer Name="StandardODATA" m:IsDefaultEntityContainer="true">
        <EntitySet Name="Document_X" EntityType="StandardODATA.Document_X"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`

  it("lists a tabular part row type's ValueStorage bases, as an EntityType's", () => {
    const index = buildMetadataIndex(parseEdmx(edmx))
    expect(index.schemas.Document_X_Товары_RowType?.valueStorages).toEqual(['Параметры'])
    expect(index.schemas.Document_X).not.toHaveProperty('valueStorages')
  })
})
