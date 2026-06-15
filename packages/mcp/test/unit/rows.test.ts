import { describe, expect, it } from 'vitest'
import { capLongStrings, fitRows, stripNoise, toJsonSafe } from '../../src/rows.js'

describe('toJsonSafe', () => {
  it('converts bigint to string and Date to ISO', () => {
    expect(toJsonSafe({ n: 5n, d: new Date('2024-01-02T03:04:05.000Z'), s: 'x' })).toEqual({
      n: '5',
      d: '2024-01-02T03:04:05.000Z',
      s: 'x',
    })
  })

  it('recurses into arrays and nested objects', () => {
    expect(toJsonSafe([{ a: 1n }, { b: [2n] }])).toEqual([{ a: '1' }, { b: ['2'] }])
  })

  it('treats a __proto__ key as ordinary data without polluting the prototype', () => {
    // JSON.parse yields an OWN "__proto__" key — a null-proto accumulator keeps it
    // as data instead of mutating the object's prototype.
    const evil = JSON.parse('{"__proto__": "x", "keep": 1}')
    const out = toJsonSafe(evil) as Record<string, unknown>
    expect(Object.getPrototypeOf(out)).toBeNull()
    expect(out.keep).toBe(1)
    expect(({} as Record<string, unknown>).x).toBeUndefined() // no global pollution
  })
})

describe('stripNoise', () => {
  it('drops *_Type, @odata.* and __metadata, keeps *_Key', () => {
    expect(
      stripNoise({
        Ref_Key: 'g',
        Склад_Key: 'h',
        Recorder: 'r',
        Recorder_Type: 'StandardODATA.Document_X',
        '@odata.etag': 'e',
        __metadata: { uri: 'u' },
        Description: 'd',
      }),
    ).toEqual({ Ref_Key: 'g', Склад_Key: 'h', Recorder: 'r', Description: 'd' })
  })

  it('recurses into expanded nested objects and arrays', () => {
    expect(
      stripNoise({
        Партнер: { Ref_Key: 'p', Owner_Type: 'X', Name: 'n' },
        lines: [{ Item_Type: 'Y', Qty: 2 }],
      }),
    ).toEqual({ Партнер: { Ref_Key: 'p', Name: 'n' }, lines: [{ Qty: 2 }] })
  })

  it('preserves Date values (does not flatten them to {})', () => {
    const d = new Date('2024-01-02T03:04:05.000Z')
    const out = stripNoise({ Period: d, X_Type: 'z' }) as { Period: Date }
    expect(out.Period).toBeInstanceOf(Date)
    expect(out.Period.getTime()).toBe(d.getTime())
  })

  it('passes through null and scalars, and recurses a top-level array', () => {
    expect(stripNoise(null)).toBeNull()
    expect(stripNoise(42)).toBe(42)
    expect(stripNoise([{ A_Type: 'x', B: 1 }])).toEqual([{ B: 1 }])
  })
})

describe('fitRows', () => {
  it('keeps all rows when they fit the budget', () => {
    const rows = [{ a: 1 }, { a: 2 }]
    expect(fitRows(rows, 10_000)).toEqual({ rows, truncated: false })
  })

  it('truncates to the longest prefix within budget and flags it', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ i, pad: 'x'.repeat(50) }))
    const out = fitRows(rows, 300)
    expect(out.truncated).toBe(true)
    expect(out.rows.length).toBeGreaterThan(0)
    expect(out.rows.length).toBeLessThan(100)
    expect(out.rows[0]).toEqual(rows[0])
  })

  it('keeps at least one row even if it alone exceeds the budget', () => {
    const rows = [{ big: 'x'.repeat(1000) }, { a: 1 }]
    const out = fitRows(rows, 50)
    expect(out.rows).toHaveLength(1)
    expect(out.truncated).toBe(true)
  })

  it('handles an empty array', () => {
    expect(fitRows([], 100)).toEqual({ rows: [], truncated: false })
  })

  it('keeps the exact maximal prefix at the budget boundary', () => {
    // Uniform rows: {"i":N} for single-digit N → 7 bytes each, +1 separator = 8.
    const rows = Array.from({ length: 5 }, (_, i) => ({ i }))
    const s = Buffer.byteLength(JSON.stringify(rows[0]), 'utf8') + 1
    // Budget window for keeping exactly k rows is [2 + k*s, 2 + (k+1)*s).
    expect(fitRows(rows, 2 + 3 * s).rows).toHaveLength(3)
    expect(fitRows(rows, 2 + 4 * s - 1).rows).toHaveLength(3)
    expect(fitRows(rows, 2 + 4 * s).rows).toHaveLength(4)
  })
})

describe('capLongStrings', () => {
  it('caps strings over the byte budget with a marker, leaves short ones, and shrinks them', () => {
    const out = capLongStrings({ small: 'ok', big: 'x'.repeat(5000) }, 1000) as Record<string, string>
    expect(out.small).toBe('ok')
    expect(out.big ?? '').toContain('truncated')
    expect((out.big ?? '').length).toBeLessThan(5000)
    // The replacement (head + marker) must itself stay within the cap.
    expect(Buffer.byteLength(out.big ?? '', 'utf8')).toBeLessThanOrEqual(1000)
  })

  it('keeps the replacement within capBytes (and below the original) when only slightly over', () => {
    // 60-byte Cyrillic value, cap 50: a naive head(50) + marker would exceed both
    // 50 and the original 60 — the marker budget prevents that.
    const original = Buffer.byteLength('я'.repeat(30), 'utf8') // 60
    const out = capLongStrings({ s: 'я'.repeat(30) }, 50) as Record<string, string>
    const capped = out.s ?? ''
    expect(capped).toContain('truncated')
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(50)
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThan(original)
  })

  it('recurses into nested objects and arrays', () => {
    const out = capLongStrings({ a: { b: 'y'.repeat(100) }, list: ['z'.repeat(100)] }, 20) as {
      a: { b: string }
      list: string[]
    }
    expect(out.a.b).toContain('truncated')
    expect(out.list[0]).toContain('truncated')
  })

  it('measures UTF-8 bytes (Cyrillic is 2 bytes/char)', () => {
    // 30 Cyrillic chars = 60 bytes > 50 budget → capped.
    const out = capLongStrings({ s: 'я'.repeat(30) }, 50) as Record<string, string>
    expect(out.s).toContain('truncated')
  })

  it('preserves Date, number, bigint and null', () => {
    const d = new Date('2024-01-02T03:04:05.000Z')
    const out = capLongStrings({ d, n: 5, big: 9n, nil: null }, 4) as {
      d: Date
      n: number
      big: bigint
      nil: null
    }
    expect(out.d).toBeInstanceOf(Date)
    expect(out.n).toBe(5)
    expect(out.big).toBe(9n)
    expect(out.nil).toBeNull()
  })
})
