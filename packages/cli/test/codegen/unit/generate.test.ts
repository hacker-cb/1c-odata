import { describe, expect, it } from 'vitest'
import { generate } from '../../../src/codegen/index.js'

const FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
  <edmx:DataServices m:DataServiceVersion="3.0" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
    <Schema Namespace="StandardODATA" xmlns="http://schemas.microsoft.com/ado/2009/11/edm">
      <EntityType Name="Catalog_Валюты">
        <Key><PropertyRef Name="Ref_Key"/></Key>
        <Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/>
        <Property Name="Code" Type="Edm.String" Nullable="false" MaxLength="3"/>
      </EntityType>
      <EntityType Name="Document_РТУ">
        <Key><PropertyRef Name="Ref_Key"/></Key>
        <Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/>
        <Property Name="Date" Type="Edm.DateTime" Nullable="true"/>
      </EntityType>
      <EntityType Name="Document_РТУ_Товары">
        <Key>
          <PropertyRef Name="Ref_Key"/>
          <PropertyRef Name="LineNumber"/>
        </Key>
        <Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/>
        <Property Name="LineNumber" Type="Edm.Int64" Nullable="false"/>
      </EntityType>
      <ComplexType Name="TypeDescription">
        <Property Name="Types" Type="Collection(Edm.String)" Nullable="false"/>
      </ComplexType>
      <EntityContainer Name="StandardODATA" m:IsDefaultEntityContainer="true">
        <EntitySet Name="Catalog_Валюты" EntityType="StandardODATA.Catalog_Валюты"/>
        <EntitySet Name="Document_РТУ" EntityType="StandardODATA.Document_РТУ"/>
        <FunctionImport Name="Post" m:HttpMethod="POST" IsBindable="true" EntitySetPath="Document_РТУ"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`

describe('generate() orchestrates parser + analysis + emitters', () => {
  it('emits one file per header entity in the right kind folder', () => {
    const result = generate({ metadata: FIXTURE })
    expect(result.files.has('catalogs/Валюты.ts')).toBe(true)
    expect(result.files.has('documents/РТУ.ts')).toBe(true)
    // Tabular part is nested in parent file, NOT a standalone file
    expect(result.files.has('documents/РТУ_Товары.ts')).toBe(false)
  })

  it('embeds tabular EntityType as nested interface in parent file', () => {
    const result = generate({ metadata: FIXTURE })
    const docFile = result.files.get('documents/РТУ.ts')
    expect(docFile).toBeDefined()
    expect(docFile).toContain('export interface Document_РТУ extends Entity {')
    expect(docFile).toContain('export interface Document_РТУ_Товары {')
  })

  it('emits per-kind index files (sorted, locale-aware)', () => {
    const result = generate({ metadata: FIXTURE })
    expect(result.files.get('catalogs/index.ts')).toBe(`export * from './Валюты.js'\n`)
    expect(result.files.get('documents/index.ts')).toBe(`export * from './РТУ.js'\n`)
    expect(result.files.get('information-registers/index.ts')).toBe('export {}\n')
  })

  it('emits master index with re-exports for populated kinds + complex-types + Functions', () => {
    const result = generate({ metadata: FIXTURE })
    const master = result.files.get('index.ts')
    expect(master).toBeDefined()
    expect(master).toContain(`export * from './catalogs/index.js'`)
    expect(master).toContain(`export * from './documents/index.js'`)
    expect(master).toContain(`export * from './complex-types.js'`)
    expect(master).toContain(`export type { Functions } from './function-imports.js'`)
  })

  it('emits __metadata.json with normalized index', () => {
    const result = generate({ metadata: FIXTURE })
    const json = result.files.get('__metadata.json')
    expect(json).toBeDefined()
    const parsed = JSON.parse(json as string)
    expect(parsed.schemaNamespace).toBe('StandardODATA')
    expect(parsed.headerCounts.catalog).toBe(1)
    expect(parsed.headerCounts.document).toBe(1)
    expect(parsed.headerCounts['information-register']).toBe(0)
    expect(parsed.functionImportCount).toBe(1)
    expect(parsed.complexTypeCount).toBe(1)
  })

  it('headerCounts reflect register entities (composite-key headers) — was previously 0', () => {
    // Synthetic fixture with one AR header (composite key, no Ref_Key) — the old
    // Ref_Key-only counter would report `accumulation-register: 0` even though
    // a header file is emitted.
    const REGISTER_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
  <edmx:DataServices m:DataServiceVersion="3.0" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
    <Schema Namespace="StandardODATA" xmlns="http://schemas.microsoft.com/ado/2009/11/edm">
      <EntityType Name="AccumulationRegister_X">
        <Key><PropertyRef Name="Recorder"/><PropertyRef Name="Recorder_Type"/></Key>
        <Property Name="Recorder" Type="Edm.String" Nullable="false"/>
        <Property Name="Recorder_Type" Type="Edm.String" Nullable="false"/>
      </EntityType>
      <EntityContainer Name="StandardODATA" m:IsDefaultEntityContainer="true">
        <EntitySet Name="AccumulationRegister_X" EntityType="StandardODATA.AccumulationRegister_X"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`
    const result = generate({ metadata: REGISTER_FIXTURE })
    expect(result.files.has('accumulation-registers/X.ts')).toBe(true)
    const parsed = JSON.parse(result.files.get('__metadata.json') as string)
    expect(parsed.headerCounts['accumulation-register']).toBe(1)
  })

  it('respects include/exclude glob filters', () => {
    const result = generate({ metadata: FIXTURE, include: ['Catalog_*'] })
    expect(result.files.has('catalogs/Валюты.ts')).toBe(true)
    expect(result.files.has('documents/РТУ.ts')).toBe(false)
  })

  it('emits all 14 kind index.ts files for consistency', () => {
    const result = generate({ metadata: FIXTURE })
    const expectedKinds = [
      'catalogs',
      'constants',
      'documents',
      'information-registers',
      'accumulation-registers',
      'exchange-plans',
      'chart-of-characteristic-types',
      'document-journals',
      'business-processes',
      'tasks',
      'chart-of-accounts',
      'chart-of-calculation-types',
      'calculation-registers',
      'accounting-registers',
    ]
    for (const k of expectedKinds) {
      expect(result.files.has(`${k}/index.ts`)).toBe(true)
    }
  })
})
