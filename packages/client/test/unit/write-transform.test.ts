import { describe, expect, it } from 'vitest'
import type { EntitySchema, MetadataIndex } from '../../src/validate.js'
import { bigintToStringReplacer, transformDatesToWire, transformDateValuesUntyped } from '../../src/write-transform.js'

const TZ = 'Europe/Moscow'

const documentX: EntitySchema = {
  properties: {
    Ref_Key: { type: 'Edm.Guid', nullable: false },
    Date: { type: 'Edm.DateTime', nullable: true },
    Сумма: { type: 'Edm.Double', nullable: true },
    Товары: { type: 'Collection(StandardODATA.Document_X_Товары_RowType)', nullable: true },
  },
}

const documentXTovary: EntitySchema = {
  properties: {
    LineNumber: { type: 'Edm.Int64', nullable: false },
    ДатаОтгрузки: { type: 'Edm.DateTime', nullable: true },
  },
}

const baseMetadata: MetadataIndex = {
  schemaNamespace: 'StandardODATA',
  schemas: {
    Document_X: documentX,
    Document_X_Товары_RowType: documentXTovary,
  },
  entitySetToType: { Document_X: 'Document_X' },
  shape: { dateMode: 'date', int64Mode: 'number' },
}

describe('transformDatesToWire — dateMode=date', () => {
  it('converts Date instance to ISO in server tz', () => {
    const out = transformDatesToWire({ Date: new Date('2025-03-15T12:00:00Z') }, documentX, TZ, baseMetadata, 'date')
    // 12:00 UTC + 3h Moscow = 15:00 local
    expect(out.Date).toBe('2025-03-15T15:00:00')
  })

  it('converts null to ONEC_EMPTY_DATE sentinel', () => {
    const out = transformDatesToWire({ Date: null }, documentX, TZ, baseMetadata, 'date')
    expect(out.Date).toBe('0001-01-01T00:00:00')
  })

  it('omits undefined fields from output', () => {
    const out = transformDatesToWire({ Date: undefined, Сумма: 100 }, documentX, TZ, baseMetadata, 'date')
    expect(out).not.toHaveProperty('Date')
    expect(out.Сумма).toBe(100)
  })

  it('passes through string DateTime value (user already formatted)', () => {
    const out = transformDatesToWire({ Date: '2025-03-15T15:00:00' }, documentX, TZ, baseMetadata, 'date')
    expect(out.Date).toBe('2025-03-15T15:00:00')
  })

  it('passes non-DateTime fields unchanged', () => {
    const out = transformDatesToWire({ Сумма: 100, Ref_Key: 'guid' }, documentX, TZ, baseMetadata, 'date')
    expect(out.Сумма).toBe(100)
    expect(out.Ref_Key).toBe('guid')
  })

  it('recurses into tabular array, converting nested DateTime fields', () => {
    const out = transformDatesToWire(
      {
        Date: new Date('2025-03-15T12:00:00Z'),
        Товары: [
          { LineNumber: 1, ДатаОтгрузки: new Date('2025-03-16T09:00:00Z') },
          { LineNumber: 2, ДатаОтгрузки: null },
        ],
      },
      documentX,
      TZ,
      baseMetadata,
      'date',
    )
    expect(out.Date).toBe('2025-03-15T15:00:00')
    const rows = out.Товары as Record<string, unknown>[]
    expect(rows[0]?.ДатаОтгрузки).toBe('2025-03-16T12:00:00')
    expect(rows[1]?.ДатаОтгрузки).toBe('0001-01-01T00:00:00')
  })
})

describe('transformDatesToWire — ValueStorage round-trip', () => {
  const withVs: EntitySchema = {
    properties: {
      Ref_Key: { type: 'Edm.Guid', nullable: false },
      Файл: { type: 'Edm.Stream', nullable: true },
      Файл_Base64Data: { type: 'Edm.Binary', nullable: true },
      Файл_Type: { type: 'Edm.String', nullable: true },
    },
    valueStorages: ['Файл'],
  }

  it('splits a grouped ValueStorage object back into the two wire halves', () => {
    const out = transformDatesToWire(
      { Ref_Key: 'g', Файл: { contentType: 'image/png', base64Data: 'aGk=' } },
      withVs,
      TZ,
      baseMetadata,
      'date',
    )
    expect(out.Файл_Type).toBe('image/png')
    expect(out.Файл_Base64Data).toBe('aGk=')
    expect(out).not.toHaveProperty('Файл')
  })

  it('leaves already-split wire halves untouched (no double processing)', () => {
    const out = transformDatesToWire(
      { Файл_Type: 'image/png', Файл_Base64Data: 'aGk=' },
      withVs,
      TZ,
      baseMetadata,
      'date',
    )
    expect(out.Файл_Type).toBe('image/png')
    expect(out.Файл_Base64Data).toBe('aGk=')
    expect(out).not.toHaveProperty('Файл')
  })

  it('does not split a non-ValueStorage-shaped value under the base key', () => {
    // A bare string (e.g. user clearing the field) is not the grouped object.
    const out = transformDatesToWire({ Файл: '' }, withVs, TZ, baseMetadata, 'date')
    expect(out.Файл).toBe('')
    expect(out).not.toHaveProperty('Файл_Type')
  })

  it('leaves a null base value untouched (no split, no crash)', () => {
    const out = transformDatesToWire({ Файл: null }, withVs, TZ, baseMetadata, 'date')
    expect(out.Файл).toBeNull()
    expect(out).not.toHaveProperty('Файл_Type')
    expect(out).not.toHaveProperty('Файл_Base64Data')
  })
})

describe('transformDatesToWire — dateMode=string', () => {
  it('is no-op in string mode (full passthrough)', () => {
    const obj = { Date: new Date('2025-03-15T12:00:00Z'), Сумма: 100 }
    const out = transformDatesToWire(obj, documentX, TZ, baseMetadata, 'string')
    expect(out).toBe(obj) // same reference
  })
})

describe('transformDatesToWire — fields missing from the schema (forward-compat)', () => {
  it('applies the value heuristic to an undeclared field', () => {
    const out = transformDatesToWire(
      { НоваяДата: new Date('2025-03-15T12:00:00Z'), НовоеЧисло: 5 },
      documentX,
      TZ,
      baseMetadata,
      'date',
    )
    expect(out.НоваяДата).toBe('2025-03-15T15:00:00')
    expect(out.НовоеЧисло).toBe(5)
  })

  it('does NOT sentinel null in an undeclared field', () => {
    const out = transformDatesToWire({ НоваяДата: null }, documentX, TZ, baseMetadata, 'date')
    expect(out.НоваяДата).toBeNull()
  })
})

describe('transformDateValuesUntyped — schema-less value heuristic', () => {
  it('converts a top-level Date to naive ISO in server tz', () => {
    expect(transformDateValuesUntyped(new Date('2025-03-15T12:00:00Z'), TZ)).toBe('2025-03-15T15:00:00')
  })

  it('recurses into plain objects and arrays of objects', () => {
    const out = transformDateValuesUntyped(
      {
        Date: new Date('2025-03-15T12:00:00Z'),
        Товары: [{ Срок: new Date('2025-06-01T00:00:00Z'), Кол: 2 }],
      },
      TZ,
    ) as Record<string, unknown>
    expect(out.Date).toBe('2025-03-15T15:00:00')
    expect((out.Товары as Record<string, unknown>[])[0]?.Срок).toBe('2025-06-01T03:00:00')
    expect((out.Товары as Record<string, unknown>[])[0]?.Кол).toBe(2)
  })

  it('leaves null untouched (no sentinel without a schema)', () => {
    const out = transformDateValuesUntyped({ Date: null }, TZ) as Record<string, unknown>
    expect(out.Date).toBeNull()
  })

  it('leaves ISO-looking strings untouched (strings are never re-parsed)', () => {
    const out = transformDateValuesUntyped({ Date: '2025-03-15T12:00:00' }, TZ) as Record<string, unknown>
    expect(out.Date).toBe('2025-03-15T12:00:00')
  })

  it('passes primitives and exotic objects through unchanged', () => {
    expect(transformDateValuesUntyped(42, TZ)).toBe(42)
    expect(transformDateValuesUntyped('text', TZ)).toBe('text')
    const map = new Map([['a', 1]])
    expect(transformDateValuesUntyped(map, TZ)).toBe(map)
  })

  it('omits undefined object fields (matches JSON.stringify semantics)', () => {
    const out = transformDateValuesUntyped({ a: undefined, b: 1 }, TZ) as Record<string, unknown>
    expect(out).not.toHaveProperty('a')
    expect(out.b).toBe(1)
  })
})

describe('bigintToStringReplacer', () => {
  it('serializes bigint values as decimal strings via JSON.stringify', () => {
    expect(JSON.stringify({ BigNum: 123456789012345678901234n, N: 1 }, bigintToStringReplacer)).toBe(
      '{"BigNum":"123456789012345678901234","N":1}',
    )
  })
})
