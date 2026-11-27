import { describe, expect, it } from 'vitest'
import type { EntitySchema, MetadataIndex } from '../../src/validate.js'
import {
  bigintToStringReplacer,
  splitValueStorages,
  transformDatesToWire,
  transformDateValuesUntyped,
} from '../../src/write-transform.js'

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

describe('splitValueStorages — a storage read back is written by its halves (#293)', () => {
  const withVs: EntitySchema = {
    properties: {
      Ref_Key: { type: 'Edm.Guid', nullable: false },
      Файл: { type: 'Edm.Stream', nullable: true },
      Файл_Base64Data: { type: 'Edm.Binary', nullable: true },
      Файл_Type: { type: 'Edm.String', nullable: true },
      Товары: { type: 'Collection(StandardODATA.Строка)', nullable: true },
    },
    valueStorages: ['Файл'],
  }
  const index: MetadataIndex = {
    ...baseMetadata,
    schemas: { ...baseMetadata.schemas, Строка: { properties: {}, valueStorages: ['Скан'] } },
  }
  const split = (body: Record<string, unknown>) => splitValueStorages(body, withVs, index)

  it('splits a grouped ValueStorage object back into the two wire halves', () => {
    expect(split({ Ref_Key: 'g', Файл: { contentType: 'image/png', base64Data: 'aGk=' } })).toEqual({
      Ref_Key: 'g',
      Файл_Type: 'image/png',
      Файл_Base64Data: 'aGk=',
    })
  })

  it('writes a null storage as `_Base64Data: null`, `_Type` left out', () => {
    expect(split({ Файл: null })).toEqual({ Файл_Base64Data: null })
  })

  it('lets each half the payload sets win, the other taken from the grouped value', () => {
    const stale = { contentType: 'image/png', base64Data: 'b2xk' }
    expect(split({ Файл: stale, Файл_Base64Data: 'bmV3' })).toEqual({ Файл_Type: 'image/png', Файл_Base64Data: 'bmV3' })
    expect(split({ Файл: stale, Файл_Type: 'image/jpeg' })).toEqual({
      Файл_Type: 'image/jpeg',
      Файл_Base64Data: 'b2xk',
    })
    expect(split({ Файл: null, Файл_Type: 'image/jpeg' })).toEqual({ Файл_Type: 'image/jpeg', Файл_Base64Data: null })
  })

  it('reads a half set to undefined as not set — the grouped value is not lost to it', () => {
    const out = split({ Файл: { contentType: 'image/png', base64Data: 'bmV3' }, Файл_Base64Data: undefined })
    expect(out).toEqual({ Файл_Type: 'image/png', Файл_Base64Data: 'bmV3' })
  })

  it('splits a storage of a tabular row too', () => {
    expect(split({ Товары: [{ Скан: { contentType: 'image/png', base64Data: 'aGk=' } }, { Скан: null }, 5] })).toEqual({
      Товары: [{ Скан_Type: 'image/png', Скан_Base64Data: 'aGk=' }, { Скан_Base64Data: null }, 5],
    })
  })

  it('leaves halves alone, and any other value under the base, as they came', () => {
    expect(split({ Файл_Type: 'image/png', Файл_Base64Data: 'aGk=' })).toEqual({
      Файл_Type: 'image/png',
      Файл_Base64Data: 'aGk=',
    })
    expect(split({ Файл: '' })).toEqual({ Файл: '' })
  })

  it('returns a body nothing changes in as it came — itself, its prototype included', () => {
    class Row {
      Ref_Key = 'g'
      toJSON() {
        return { Ref_Key: 'from toJSON' }
      }
    }
    const row = new Row()
    expect(splitValueStorages(row as unknown as Record<string, unknown>, withVs, index)).toBe(row)
    const rows = { Товары: [{ LineNumber: 1 }] }
    expect(split(rows)).toBe(rows)
  })
})

describe('transformDatesToWire — leaves ValueStorages to splitValueStorages', () => {
  it('passes a grouped value through untouched', () => {
    const schema: EntitySchema = {
      properties: { Файл: { type: 'Edm.Stream', nullable: true } },
      valueStorages: ['Файл'],
    }
    const grouped = { contentType: 'image/png', base64Data: 'aGk=' }
    expect(transformDatesToWire({ Файл: grouped }, schema, TZ, baseMetadata, 'date')).toEqual({ Файл: grouped })
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

describe('transformDatesToWire — a `__proto__` key is written as the payload’s own field (#275)', () => {
  it('keeps the field and the Object prototype, at the top and in a tabular row', () => {
    const body = JSON.parse('{"__proto__":{"x":1},"Сумма":1,"Товары":[{"__proto__":{"y":1},"LineNumber":1}]}')
    const out = transformDatesToWire(body, documentX, TZ, baseMetadata, 'date')
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(Object.keys(out)).toEqual(['__proto__', 'Сумма', 'Товары'])
    expect((out as { x?: unknown }).x).toBeUndefined()
    const row = (out.Товары as Record<string, unknown>[])[0] as Record<string, unknown>
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype)
    expect((row as { y?: unknown }).y).toBeUndefined()
    expect(JSON.stringify(out)).toBe('{"__proto__":{"x":1},"Сумма":1,"Товары":[{"__proto__":{"y":1},"LineNumber":1}]}')
  })
})

describe('splitValueStorages — a ValueStorage base named `__proto__` (#275)', () => {
  const schema: EntitySchema = {
    properties: {
      __proto___Base64Data: { type: 'Edm.Binary', nullable: true },
      __proto___Type: { type: 'Edm.String', nullable: true },
    },
    valueStorages: ['__proto__'],
  }

  it('wire halves alone pass through, the accessor never read as the grouped value', () => {
    const out = splitValueStorages({ __proto___Type: 'text/plain', __proto___Base64Data: 'QQ==' }, schema, baseMetadata)
    expect(out).toEqual({ __proto___Type: 'text/plain', __proto___Base64Data: 'QQ==' })
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
  })

  it('a grouped value under an own `__proto__` key splits into the halves', () => {
    const body = JSON.parse('{"__proto__":{"contentType":"text/plain","base64Data":"QQ=="}}')
    const out = splitValueStorages(body, schema, baseMetadata)
    expect(out).toEqual({ __proto___Type: 'text/plain', __proto___Base64Data: 'QQ==' })
    expect(Object.hasOwn(out, '__proto__')).toBe(false)
  })
})
