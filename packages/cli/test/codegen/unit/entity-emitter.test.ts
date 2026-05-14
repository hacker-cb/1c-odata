import { describe, expect, it } from 'vitest'
import { type EntityEmitInput, emitEntityFile } from '../../../src/codegen/emitter/entity.js'
import type { EdmxEntityType } from '../../../src/codegen/parser/ast.js'

const header: EdmxEntityType = {
  name: 'Document_РТУ',
  key: ['Ref_Key'],
  properties: [
    { name: 'Ref_Key', type: 'Edm.Guid', nullable: false },
    { name: 'DataVersion', type: 'Edm.String', nullable: false },
    { name: 'DeletionMark', type: 'Edm.Boolean', nullable: false },
    { name: 'Predefined', type: 'Edm.Boolean', nullable: false },
    { name: 'PredefinedDataName', type: 'Edm.String', nullable: false },
    { name: 'Number', type: 'Edm.String', nullable: false, maxLength: 11 },
    { name: 'Date', type: 'Edm.DateTime', nullable: true },
    { name: 'Posted', type: 'Edm.Boolean', nullable: false },
    { name: 'Контрагент_Key', type: 'Edm.Guid', nullable: true },
    { name: 'ЗаказКлиента', type: 'Edm.String', nullable: true },
    { name: 'ЗаказКлиента_Type', type: 'Edm.String', nullable: true },
    { name: 'СуммаДокумента', type: 'Edm.Double', nullable: false },
    { name: 'Товары', type: 'Collection(StandardODATA.Document_РТУ_Товары_RowType)', nullable: false },
  ],
  navigationProperties: [
    {
      name: 'Контрагент',
      relationship: 'StandardODATA.Doc_Контрагент',
      fromRole: 'Source',
      toRole: 'Target',
      resolvedTargetType: 'StandardODATA.Catalog_Контрагенты',
    },
  ],
}

const tabular: EdmxEntityType = {
  name: 'Document_РТУ_Товары',
  key: ['Ref_Key', 'LineNumber'],
  properties: [
    { name: 'Ref_Key', type: 'Edm.Guid', nullable: false },
    { name: 'LineNumber', type: 'Edm.Int64', nullable: false },
    { name: 'Номенклатура_Key', type: 'Edm.Guid', nullable: false },
    { name: 'Количество', type: 'Edm.Double', nullable: false },
  ],
  navigationProperties: [],
}

const baseInput: EntityEmitInput = {
  header,
  tabulars: [tabular],
  schemaNamespace: 'StandardODATA',
  int64Mode: 'string',
  dateMode: 'date',
}

describe('emitEntityFile', () => {
  it('emits an `extends Entity` interface for single-Ref_Key headers', () => {
    const out = emitEntityFile(baseInput)
    expect(out).toContain('export interface Document_РТУ extends Entity {')
  })

  it('emits exactly Entity + Guid as the core type imports', () => {
    const out = emitEntityFile(baseInput)
    expect(out).toMatch(/^import type \{ Entity, Guid \} from '@1c-odata\/client'$/m)
  })

  it('emits composite-ref pair as two flat string fields', () => {
    const out = emitEntityFile(baseInput)
    expect(out).toContain('ЗаказКлиента?: string | null')
    expect(out).toContain('ЗаказКлиента_Type?: string | null')
  })

  it('emits monotype refs as <X>_Key + optional <X>?: Target', () => {
    const out = emitEntityFile(baseInput)
    expect(out).toContain('Контрагент_Key?: Guid | null')
    expect(out).toContain('Контрагент?: Catalog_Контрагенты')
  })

  it('emits nested tabular interface in same file (no extends Entity)', () => {
    const out = emitEntityFile(baseInput)
    expect(out).toContain('export interface Document_РТУ_Товары {')
    expect(out).not.toContain('export interface Document_РТУ_Товары extends Entity')
    expect(out).toContain('LineNumber: string')
  })

  it('refers to tabular type via tail name in parent Collection field', () => {
    const out = emitEntityFile(baseInput)
    expect(out).toContain('Товары: Document_РТУ_Товары[]')
  })

  it('groups Stream + Base64Data + Type triple into a single ValueStorage field', () => {
    const valueStorageHeader: EdmxEntityType = {
      name: 'Catalog_Файлы',
      key: ['Ref_Key'],
      properties: [
        { name: 'Ref_Key', type: 'Edm.Guid', nullable: false },
        { name: 'ФайлХранилище', type: 'Edm.Stream', nullable: true },
        { name: 'ФайлХранилище_Base64Data', type: 'Edm.Binary', nullable: true },
        { name: 'ФайлХранилище_Type', type: 'Edm.String', nullable: true },
      ],
      navigationProperties: [],
    }
    const out = emitEntityFile({ ...baseInput, header: valueStorageHeader, tabulars: [] })
    expect(out).toContain('ФайлХранилище?: ValueStorage | null')
    expect(out).not.toContain('ФайлХранилище_Base64Data')
    expect(out).not.toContain('ФайлХранилище_Type')
    expect(out).toMatch(/import type \{[^}]*ValueStorage[^}]*\} from '@1c-odata\/client'/)
  })

  it('honours Nullable="false" on composite-ref pair — emits both fields as required string', () => {
    const arHeader: EdmxEntityType = {
      name: 'AccumulationRegister_X',
      key: ['Recorder', 'Recorder_Type'],
      properties: [
        { name: 'Recorder', type: 'Edm.String', nullable: false },
        { name: 'Recorder_Type', type: 'Edm.String', nullable: false },
      ],
      navigationProperties: [],
    }
    const out = emitEntityFile({ ...baseInput, header: arHeader, tabulars: [] })
    expect(out).toContain('Recorder: string\n')
    expect(out).toContain('Recorder_Type: string\n')
    expect(out).not.toContain('Recorder?: string')
  })

  it('honours Nullable="true" on composite-ref pair — emits both fields as optional string | null', () => {
    // baseInput's `ЗаказКлиента` is Nullable="true" (composite-ref pair)
    const out = emitEntityFile(baseInput)
    expect(out).toContain('ЗаказКлиента?: string | null')
    expect(out).toContain('ЗаказКлиента_Type?: string | null')
  })

  it('honours Nullable="false" on ValueStorage base — emits required ValueStorage', () => {
    const valueStorageHeader: EdmxEntityType = {
      name: 'Catalog_Файлы',
      key: ['Ref_Key'],
      properties: [
        { name: 'Ref_Key', type: 'Edm.Guid', nullable: false },
        { name: 'Файл', type: 'Edm.Stream', nullable: false },
        { name: 'Файл_Base64Data', type: 'Edm.Binary', nullable: false },
        { name: 'Файл_Type', type: 'Edm.String', nullable: false },
      ],
      navigationProperties: [],
    }
    const out = emitEntityFile({ ...baseInput, header: valueStorageHeader, tabulars: [] })
    expect(out).toContain('Файл: ValueStorage\n')
    expect(out).not.toContain('Файл?: ValueStorage')
  })

  it('honours Nullable="true" on ValueStorage base — emits optional ValueStorage | null', () => {
    const valueStorageHeader: EdmxEntityType = {
      name: 'Catalog_Файлы',
      key: ['Ref_Key'],
      properties: [
        { name: 'Ref_Key', type: 'Edm.Guid', nullable: false },
        { name: 'Файл', type: 'Edm.Stream', nullable: true },
        { name: 'Файл_Base64Data', type: 'Edm.Binary', nullable: true },
        { name: 'Файл_Type', type: 'Edm.String', nullable: true },
      ],
      navigationProperties: [],
    }
    const out = emitEntityFile({ ...baseInput, header: valueStorageHeader, tabulars: [] })
    expect(out).toContain('Файл?: ValueStorage | null')
  })

  it("consolidates local imports into a single line — one `import type {} from '../index.js'`", () => {
    const multiNav: EdmxEntityType = {
      name: 'Document_Multi',
      key: ['Ref_Key'],
      properties: [{ name: 'Ref_Key', type: 'Edm.Guid', nullable: false }],
      navigationProperties: [
        {
          name: 'A',
          relationship: 'StandardODATA.R1',
          fromRole: 'S',
          toRole: 'T',
          resolvedTargetType: 'StandardODATA.Catalog_A',
        },
        {
          name: 'B',
          relationship: 'StandardODATA.R2',
          fromRole: 'S',
          toRole: 'T',
          resolvedTargetType: 'StandardODATA.Catalog_B',
        },
        {
          name: 'C',
          relationship: 'StandardODATA.R3',
          fromRole: 'S',
          toRole: 'T',
          resolvedTargetType: 'StandardODATA.Catalog_C',
        },
      ],
    }
    const out = emitEntityFile({ ...baseInput, header: multiNav, tabulars: [] })
    const localImportLines = out.split('\n').filter((l) => l.includes("from '../index.js'"))
    expect(localImportLines).toHaveLength(1)
    expect(localImportLines[0]).toBe(`import type { Catalog_A, Catalog_B, Catalog_C } from '../index.js'`)
  })

  it('emits non-nullable Edm.DateTime as `Date | null` in dateMode=date (wire reality)', () => {
    const out = emitEntityFile({
      header: {
        name: 'InformationRegister_X_RecordType',
        key: ['Period', 'Recorder', 'Recorder_Type'],
        properties: [
          { name: 'Period', type: 'Edm.DateTime', nullable: false },
          { name: 'Recorder', type: 'Edm.String', nullable: false },
          { name: 'Recorder_Type', type: 'Edm.String', nullable: false },
        ],
        navigationProperties: [],
      },
      tabulars: [],
      schemaNamespace: 'StandardODATA',
      int64Mode: 'number',
      dateMode: 'date',
    })
    // Non-nullable Edm.DateTime → still `Date | null` because 1С returns sentinel
    // for empty even on Nullable="false" fields.
    expect(out).toContain('Period?: Date | null')
  })

  it('emits non-nullable Edm.DateTime as `string` in dateMode=string (strict EDMX)', () => {
    const out = emitEntityFile({
      header: {
        name: 'InformationRegister_X_RecordType',
        key: ['Period'],
        properties: [{ name: 'Period', type: 'Edm.DateTime', nullable: false }],
        navigationProperties: [],
      },
      tabulars: [],
      schemaNamespace: 'StandardODATA',
      int64Mode: 'number',
      dateMode: 'string',
    })
    expect(out).toContain('Period: string')
    expect(out).not.toContain('Period?:')
    expect(out).not.toContain('string | null')
  })

  it('emits NavigationProperty as `?: Target | null` (wire reality on $expand miss)', () => {
    const out = emitEntityFile({
      header: {
        name: 'Document_X',
        key: ['Ref_Key'],
        properties: [{ name: 'Ref_Key', type: 'Edm.Guid', nullable: false }],
        navigationProperties: [
          {
            name: 'Контрагент',
            relationship: 'StandardODATA.Document_X_Контрагент',
            fromRole: 'X',
            toRole: 'Контрагент',
            resolvedTargetType: 'StandardODATA.Catalog_Контрагенты',
          },
        ],
      },
      tabulars: [],
      schemaNamespace: 'StandardODATA',
      int64Mode: 'number',
      dateMode: 'date',
    })
    expect(out).toContain('Контрагент?: Catalog_Контрагенты | null')
  })

  it('does NOT extend Entity when key is composite (tabular root case)', () => {
    const tabRoot: EdmxEntityType = {
      name: 'Document_РТУ_Товары',
      key: ['Ref_Key', 'LineNumber'],
      properties: [
        { name: 'Ref_Key', type: 'Edm.Guid', nullable: false },
        { name: 'LineNumber', type: 'Edm.Int64', nullable: false },
      ],
      navigationProperties: [],
    }
    const out = emitEntityFile({ ...baseInput, header: tabRoot, tabulars: [] })
    expect(out).toContain('export interface Document_РТУ_Товары {')
    expect(out).not.toContain('extends Entity')
  })
})
