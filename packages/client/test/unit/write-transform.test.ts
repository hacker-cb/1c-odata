import { describe, expect, it } from 'vitest'
import type { EntitySchema, MetadataIndex } from '../../src/validate.js'
import { transformDatesToWire } from '../../src/write-transform.js'

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

describe('transformDatesToWire — dateMode=string', () => {
  it('is no-op in string mode (full passthrough)', () => {
    const obj = { Date: new Date('2025-03-15T12:00:00Z'), Сумма: 100 }
    const out = transformDatesToWire(obj, documentX, TZ, baseMetadata, 'string')
    expect(out).toBe(obj) // same reference
  })
})
