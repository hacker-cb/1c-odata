import { describe, expect, it } from 'vitest'
import { MINIMALMETADATA_JSON, NOMETADATA_JSON, readFormat, wireSelect } from '../../src/read-format.js'
import type { MetadataIndex } from '../../src/validate.js'

// #289: 1С withholds a ValueStorage's `_Type` in `nometadata`; a read whose reply carries a storage asks for
// `minimalmetadata`, every other read stays `nometadata`.
const index: MetadataIndex = {
  schemaNamespace: 'StandardODATA',
  schemas: {
    Catalog_Файлы: {
      properties: { Ref_Key: { type: 'Edm.Guid', nullable: false } },
      valueStorages: ['Файл'],
      navigation: { Владелец: { type: 'Catalog_Контрагенты' } },
    },
    Catalog_Контрагенты: {
      properties: { Ref_Key: { type: 'Edm.Guid', nullable: false } },
      navigation: { Логотип: { type: 'Catalog_Файлы' }, Висячая: { type: 'Catalog_Нет' } },
    },
  },
  entitySetToType: { Catalog_Файлы: 'Catalog_Файлы', Catalog_Контрагенты: 'Catalog_Контрагенты' },
}

describe('readFormat (#289)', () => {
  it('stays nometadata without an index, for a type it does not hold, and for a type without storages', () => {
    expect(readFormat(undefined, 'Catalog_Файлы')).toBe(NOMETADATA_JSON)
    expect(readFormat(index, undefined)).toBe(NOMETADATA_JSON)
    expect(readFormat(index, 'Catalog_Нет')).toBe(NOMETADATA_JSON)
    expect(readFormat(index, 'Catalog_Контрагенты')).toBe(NOMETADATA_JSON)
  })

  it.each([
    [[], MINIMALMETADATA_JSON],
    [['*'], MINIMALMETADATA_JSON],
    [['**'], MINIMALMETADATA_JSON],
    [['Ref_Key', 'Файл'], MINIMALMETADATA_JSON],
    [['Файл_Base64Data'], MINIMALMETADATA_JSON],
    [[' Файл_Type '], MINIMALMETADATA_JSON],
    [['Ref_Key,Файл'], MINIMALMETADATA_JSON],
    [['Ref_Key'], NOMETADATA_JSON],
    [['Владелец/Файл'], NOMETADATA_JSON],
  ])('a row of a type with a storage, $select %j → %s', (select, format) => {
    expect(readFormat(index, 'Catalog_Файлы', { select })).toBe(format)
  })

  it.each([
    [[], MINIMALMETADATA_JSON],
    [['Ref_Key', 'Логотип'], MINIMALMETADATA_JSON],
    [['Ref_Key', 'Логотип/*'], MINIMALMETADATA_JSON],
    [['Ref_Key', 'Логотип/Файл'], MINIMALMETADATA_JSON],
    [['Ref_Key', 'Логотип/Файл_Base64Data'], MINIMALMETADATA_JSON],
    [['Ref_Key', 'Логотип/**'], MINIMALMETADATA_JSON],
    [['*'], MINIMALMETADATA_JSON],
    [['**'], MINIMALMETADATA_JSON],
    [['Ref_Key,Логотип/Файл'], MINIMALMETADATA_JSON],
    [['Ref_Key', 'Логотип/Ref_Key'], NOMETADATA_JSON],
    [['Ref_Key'], NOMETADATA_JSON],
  ])('an $expand reaching a type with a storage, $select %j → %s', (select, format) => {
    expect(readFormat(index, 'Catalog_Контрагенты', { select, expand: ['Логотип'] })).toBe(format)
  })

  it('follows an $expand path through each navigation it names', () => {
    expect(readFormat(index, 'Catalog_Файлы', { select: ['Ref_Key'], expand: ['Владелец/Логотип'] })).toBe(
      NOMETADATA_JSON,
    )
    expect(readFormat(index, 'Catalog_Файлы', { select: ['Владелец/Логотип'], expand: ['Владелец/Логотип'] })).toBe(
      MINIMALMETADATA_JSON,
    )
    // `Владелец` named whole keeps the `Логотип` expanded inside it whole too.
    expect(readFormat(index, 'Catalog_Файлы', { select: ['Владелец'], expand: ['Владелец/Логотип'] })).toBe(
      MINIMALMETADATA_JSON,
    )
    expect(readFormat(index, 'Catalog_Контрагенты', { expand: ['Висячая', 'Нет', ''] })).toBe(NOMETADATA_JSON)
  })

  it('reads `*` in an $expand as every navigation of its level, and a comma inside an entry as a list', () => {
    expect(readFormat(index, 'Catalog_Контрагенты', { select: ['Ref_Key'], expand: ['*'] })).toBe(NOMETADATA_JSON)
    expect(readFormat(index, 'Catalog_Контрагенты', { expand: ['*'] })).toBe(MINIMALMETADATA_JSON)
    expect(readFormat(index, 'Catalog_Файлы', { select: ['Ref_Key'], expand: ['Владелец/*'] })).toBe(NOMETADATA_JSON)
    // `Владелец/*` keeps `Владелец` whole, the entities expanded inside it included.
    expect(readFormat(index, 'Catalog_Файлы', { expand: ['Владелец/*'], select: ['Ref_Key', 'Владелец/*'] })).toBe(
      MINIMALMETADATA_JSON,
    )
    expect(readFormat(index, 'Catalog_Файлы', { expand: ['Владелец/*'], select: ['Владелец/Логотип'] })).toBe(
      MINIMALMETADATA_JSON,
    )
    expect(readFormat(index, 'Catalog_Контрагенты', { select: ['Ref_Key'], expand: ['Висячая,Логотип'] })).toBe(
      NOMETADATA_JSON,
    )
    expect(readFormat(index, 'Catalog_Контрагенты', { expand: ['Висячая,Логотип'] })).toBe(MINIMALMETADATA_JSON)
  })

  it('reads `*` only at the end of an $expand path — inside one it names nothing, however long the path', () => {
    const path = Array(40).fill('*').concat('Логотип').join('/')
    expect(readFormat(index, 'Catalog_Контрагенты', { select: ['Ref_Key'], expand: [path] })).toBe(NOMETADATA_JSON)
  })
})

describe('wireSelect (#286)', () => {
  it('writes a storage base — of the row or through a navigation path — as its halves, any other name as given', () => {
    expect(
      wireSelect(index, 'Catalog_Контрагенты', ['Ref_Key', 'Логотип/Файл', 'Логотип/Ref_Key', 'Висячая/Файл', 'Файл']),
    ).toEqual(['Ref_Key', 'Логотип/Файл_Base64Data', 'Логотип/Файл_Type', 'Логотип/Ref_Key', 'Висячая/Файл', 'Файл'])
    expect(wireSelect(index, 'Catalog_Файлы', ['Файл', 'Владелец/Логотип/Файл'])).toEqual([
      'Файл_Base64Data',
      'Файл_Type',
      'Владелец/Логотип/Файл_Base64Data',
      'Владелец/Логотип/Файл_Type',
    ])
  })

  it('reads names as 1С does — commas split, names and path segments trimmed — a name not repeated', () => {
    expect(wireSelect(index, 'Catalog_Контрагенты', ['Ref_Key , Логотип / Файл', 'Логотип/Файл_Type'])).toEqual([
      'Ref_Key',
      'Логотип/Файл_Base64Data',
      'Логотип/Файл_Type',
    ])
  })

  it('is undefined without an index, for a type it does not hold, and for separators alone', () => {
    expect(wireSelect(undefined, 'Catalog_Файлы', ['Файл'])).toBeUndefined()
    expect(wireSelect(index, 'Catalog_Нет', ['Файл'])).toBeUndefined()
    expect(wireSelect(index, 'Catalog_Файлы', [','])).toBeUndefined()
    expect(wireSelect(index, 'Catalog_Файлы', undefined)).toBeUndefined()
  })
})

describe('tabular parts (#290)', () => {
  const doc: MetadataIndex = {
    schemaNamespace: 'StandardODATA',
    schemas: {
      Document_X: {
        properties: {
          Ref_Key: { type: 'Edm.Guid', nullable: false },
          Товары: { type: 'Collection(StandardODATA.Document_X_Товары_RowType)', nullable: true },
          Услуги: { type: 'Collection(StandardODATA.Document_X_Услуги_RowType)', nullable: true },
        },
      },
      Document_X_Товары_RowType: {
        properties: { LineNumber: { type: 'Edm.Int64', nullable: false } },
        valueStorages: ['Файл'],
      },
      Document_X_Услуги_RowType: { properties: { LineNumber: { type: 'Edm.Int64', nullable: false } } },
    },
    entitySetToType: { Document_X: 'Document_X' },
  }

  it.each([
    [[], MINIMALMETADATA_JSON],
    [['*'], MINIMALMETADATA_JSON],
    [['Товары'], MINIMALMETADATA_JSON],
    [['Товары/*'], MINIMALMETADATA_JSON],
    [['Товары/Файл'], MINIMALMETADATA_JSON],
    [['Товары/Файл_Base64Data'], MINIMALMETADATA_JSON],
    [['Товары/**'], MINIMALMETADATA_JSON],
    [['**'], NOMETADATA_JSON],
    [['Ref_Key', 'Услуги'], NOMETADATA_JSON],
    [['Товары/LineNumber'], NOMETADATA_JSON],
  ])('a document whose tabular rows carry a storage, $select %j → %s', (select, format) => {
    expect(readFormat(doc, 'Document_X', { select })).toBe(format)
  })

  it("follows an expanded entity's tabular parts: `<Nav>/**` leaves them out, `<Nav>/*` and `<Nav>` keep them", () => {
    const withNav: MetadataIndex = {
      ...doc,
      schemas: {
        ...doc.schemas,
        Catalog_Y: {
          properties: { Ref_Key: { type: 'Edm.Guid', nullable: false } },
          navigation: { Документ: { type: 'Document_X' } },
        },
      },
    }
    const read = (select: string[]) => readFormat(withNav, 'Catalog_Y', { select, expand: ['Документ'] })
    expect(read(['Документ/**'])).toBe(NOMETADATA_JSON)
    expect(read(['Документ/*'])).toBe(MINIMALMETADATA_JSON)
    expect(read(['Документ'])).toBe(MINIMALMETADATA_JSON)
    expect(read(['Документ/Товары'])).toBe(MINIMALMETADATA_JSON)
    expect(read(['Документ/Ref_Key'])).toBe(NOMETADATA_JSON)
  })

  it('writes a tabular row storage selected by its path as its halves', () => {
    expect(wireSelect(doc, 'Document_X', ['Товары/Файл', 'Товары/LineNumber', 'Услуги/Файл'])).toEqual([
      'Товары/Файл_Base64Data',
      'Товары/Файл_Type',
      'Товары/LineNumber',
      'Услуги/Файл',
    ])
  })
})
