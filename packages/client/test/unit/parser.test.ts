import { ONEC_EMPTY_DATE } from '@1c-odata/client'
import { describe, expect, it } from 'vitest'
import { ParseError } from '../../src/errors.js'
import { parseV3Collection, parseV3Count, parseV3Single } from '../../src/parser.js'
import { parseInZone } from '../../src/timezone.js'
import type { MetadataIndex } from '../../src/validate.js'

const TZ = 'Europe/Moscow'

describe('V3 parser', () => {
  it('parseV3Collection extracts value array', () => {
    const body = JSON.stringify({
      'odata.metadata': 'http://x/$metadata#Catalog_X',
      value: [
        { Ref_Key: 'a', Code: '1' },
        { Ref_Key: 'b', Code: '2' },
      ],
    })
    const r = parseV3Collection<{ Ref_Key: string; Code: string }>(body, { serverTimezone: TZ })
    expect(r.value).toHaveLength(2)
    expect(r.value[0]?.Code).toBe('1')
    expect(r.odataMetadata).toContain('Catalog_X')
  })

  it('parseV3Collection converts string odata.count → number', () => {
    const body = JSON.stringify({
      'odata.metadata': 'http://x/$metadata#Catalog_X',
      'odata.count': '8',
      value: [],
    })
    const r = parseV3Collection(body, { serverTimezone: TZ })
    expect(r.count).toBe(8)
    expect(typeof r.count).toBe('number')
  })

  it('parseV3Collection maps empty datetime "0001-01-01..." to null unconditionally', () => {
    const body = JSON.stringify({
      value: [{ Ref_Key: 'a', СрокДоставки: '0001-01-01T00:00:00', ДатаПлатежа: '2025-03-15T00:00:00' }],
    })
    const r = parseV3Collection<{ Ref_Key: string; СрокДоставки: Date | null; ДатаПлатежа: Date | null }>(body, {
      serverTimezone: TZ,
    })
    expect(r.value[0]?.СрокДоставки).toBeNull()
    expect(r.value[0]?.ДатаПлатежа).toBeInstanceOf(Date)
  })

  it('parseV3Collection parses valid datetime via parseInZone', () => {
    const input = '2025-03-15T00:00:00'
    const body = JSON.stringify({ value: [{ ДатаПлатежа: input }] })
    const r = parseV3Collection<{ ДатаПлатежа: Date }>(body, { serverTimezone: TZ })
    expect(r.value[0]?.ДатаПлатежа).toEqual(parseInZone(input, TZ))
  })

  it('parseV3Single returns single entity (no value wrapper)', () => {
    const body = JSON.stringify({
      'odata.metadata': 'http://x/$metadata#Catalog_X/@Element',
      Ref_Key: 'a',
      Code: 'V1',
    })
    const r = parseV3Single<{ Ref_Key: string; Code: string }>(body, { serverTimezone: TZ })
    expect(r.Ref_Key).toBe('a')
    expect(r.Code).toBe('V1')
  })

  it('parseV3Count handles plain integer body', () => {
    expect(parseV3Count('10715')).toBe(10715)
  })

  it(`parseV3Count handles BOM-prefixed body`, () => {
    expect(parseV3Count('﻿10715')).toBe(10715)
  })

  it('parseV3Count takes surrounding whitespace and zero (#218)', () => {
    expect(parseV3Count(' 42\r\n')).toBe(42)
    expect(parseV3Count('0')).toBe(0)
  })

  it.each([['12oops'], ['12 13'], ['1.5'], ['-1'], ['+1'], ['1e3'], ['0x10'], [''], ['n/a'], ['9007199254740993']])(
    'parseV3Count refuses %j instead of reading a count off it (#218)',
    (body) => {
      let caught: unknown
      try {
        parseV3Count(body)
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(ParseError)
      expect((caught as ParseError).message).toMatch(/non-negative integer row count in \/\$count/)
    },
  )

  it.each([[' 8\r\n'], ['\uFEFF8'], [8]])('parseV3Collection reads an odata.count of %j as 8', (count) => {
    const body = JSON.stringify({ 'odata.metadata': 'http://x/$metadata#Catalog_X', 'odata.count': count, value: [] })
    expect(parseV3Collection(body, { serverTimezone: TZ }).count).toBe(8)
  })

  it('parseV3Collection leaves count undefined where odata.count is absent', () => {
    const body = JSON.stringify({ 'odata.metadata': 'http://x/$metadata#Catalog_X', value: [] })
    expect(parseV3Collection(body, { serverTimezone: TZ }).count).toBeUndefined()
  })

  it.each([['8oops'], ['-1'], ['1.5'], [''], [-1], [1.5], [null], [true]])(
    'parseV3Collection refuses an odata.count of %j (#218)',
    (count) => {
      const body = JSON.stringify({ 'odata.metadata': 'http://x/$metadata#Catalog_X', 'odata.count': count, value: [] })
      expect(() => parseV3Collection(body, { serverTimezone: TZ })).toThrow(
        /non-negative integer row count in odata\.count/,
      )
    },
  )

  it.each([
    [{ toString: null }, 'an object'],
    [[1], 'an array'],
    [-1, 'number -1'],
    [null, 'null'],
  ])('parseV3Collection refuses an odata.count of %j with a ParseError naming its kind', (count, shown) => {
    const body = JSON.stringify({ 'odata.count': count, value: [] })
    expect(() => parseV3Collection(body, { serverTimezone: TZ })).toThrow(
      new ParseError(`Expected a non-negative integer row count in odata.count, got: ${shown}`),
    )
  })

  it(`ONEC_EMPTY_DATE constant matches default`, () => {
    expect(ONEC_EMPTY_DATE).toBe('0001-01-01T00:00:00')
  })
})

describe('schema-aware parsing', () => {
  const metadataIndex: MetadataIndex = {
    schemaNamespace: 'StandardODATA',
    schemas: {
      Catalog_X: {
        properties: {
          Ref_Key: { type: 'Edm.Guid', nullable: false },
          LineNumber: { type: 'Edm.Int64', nullable: false },
          Recorder: { type: 'Edm.String', nullable: false },
          Recorder_Type: { type: 'Edm.String', nullable: false },
          File: { type: 'Edm.Stream', nullable: true },
          File_Base64Data: { type: 'Edm.Binary', nullable: true },
          File_Type: { type: 'Edm.String', nullable: true },
        },
        valueStorages: ['File'],
      },
    },
    entitySetToType: { Catalog_X: 'Catalog_X' },
    shape: { int64Mode: 'bigint' },
  }

  it('converts Edm.Int64 to bigint when shape.int64Mode=bigint', () => {
    const body = JSON.stringify({
      'odata.metadata': '...',
      Ref_Key: 'guid',
      LineNumber: '1234567890',
      Recorder: 'guid2',
      Recorder_Type: 'StandardODATA.Document_X',
    })
    const r = parseV3Single<{ LineNumber: bigint }>(body, {
      serverTimezone: 'UTC',
      typeHint: 'Catalog_X',
      metadataIndex,
    })
    expect(r.LineNumber).toBe(1234567890n)
  })

  it('Edm.Int64 defaults to number when no shape supplied (matches DataShape JSDoc default)', () => {
    const body = JSON.stringify({
      'odata.metadata': '...',
      Ref_Key: 'guid',
      LineNumber: '42',
      Recorder: 'guid2',
      Recorder_Type: 'StandardODATA.Document_X',
    })
    // Same metadataIndex, but with `shape` stripped — exercises the
    // "no DataShape was set anywhere" path.
    const { shape: _shape, ...idxWithoutShape } = metadataIndex
    const r = parseV3Single<{ LineNumber: number }>(body, {
      serverTimezone: 'UTC',
      typeHint: 'Catalog_X',
      metadataIndex: idxWithoutShape,
    })
    expect(r.LineNumber).toBe(42)
    expect(typeof r.LineNumber).toBe('number')
  })

  it('Edm.Int64 stays wire string when shape.int64Mode=string is explicit', () => {
    const body = JSON.stringify({
      'odata.metadata': '...',
      Ref_Key: 'guid',
      LineNumber: '1234567890',
      Recorder: 'guid2',
      Recorder_Type: 'StandardODATA.Document_X',
    })
    const r = parseV3Single<{ LineNumber: string }>(body, {
      serverTimezone: 'UTC',
      typeHint: 'Catalog_X',
      metadataIndex,
      shape: { int64Mode: 'string' },
    })
    expect(r.LineNumber).toBe('1234567890')
  })

  it('keeps composite ref pair as separate flat string fields (no synthetic grouping)', () => {
    const body = JSON.stringify({
      'odata.metadata': '...',
      Ref_Key: 'guid',
      Recorder: 'recguid',
      Recorder_Type: 'StandardODATA.Document_X',
    })
    const r = parseV3Single<{ Recorder: string; Recorder_Type: string }>(body, {
      serverTimezone: 'UTC',
      typeHint: 'Catalog_X',
      metadataIndex,
    })
    expect(r.Recorder).toBe('recguid')
    expect(r.Recorder_Type).toBe('StandardODATA.Document_X')
  })

  it('groups ValueStorage triple into ValueStorage object', () => {
    const body = JSON.stringify({
      'odata.metadata': '...',
      Ref_Key: 'guid',
      File_Base64Data: 'aGVsbG8=',
      File_Type: 'image/png',
    })
    const r = parseV3Single<{ File: { contentType: string; base64Data: string } }>(body, {
      serverTimezone: 'UTC',
      typeHint: 'Catalog_X',
      metadataIndex,
    })
    expect(r.File).toMatchObject({ contentType: 'image/png', base64Data: 'aGVsbG8=' })
  })

  it('groups ValueStorage triple with null halves into null + removes flat fields', () => {
    const body = JSON.stringify({
      'odata.metadata': '...',
      Ref_Key: 'guid',
      File_Base64Data: null,
      File_Type: null,
    })
    const metadataIndex: MetadataIndex = {
      schemaNamespace: 'StandardODATA',
      schemas: {
        Catalog_X: {
          properties: {
            Ref_Key: { type: 'Edm.Guid', nullable: false },
            File: { type: 'Edm.Stream', nullable: true },
            File_Base64Data: { type: 'Edm.Binary', nullable: true },
            File_Type: { type: 'Edm.String', nullable: true },
          },
          valueStorages: ['File'],
        },
      },
      entitySetToType: { Catalog_X: 'Catalog_X' },
    }
    const r = parseV3Single<Record<string, unknown>>(body, {
      serverTimezone: 'UTC',
      typeHint: 'Catalog_X',
      metadataIndex,
    })
    expect(r.File).toBeNull()
    expect(r.File_Base64Data).toBeUndefined()
    expect(r.File_Type).toBeUndefined()
  })

  it('falls back to date-regex heuristic when no metadataIndex', () => {
    const input = '2025-03-15T00:00:00'
    const body = JSON.stringify({ 'odata.metadata': '...', SomeDate: input })
    const r = parseV3Single<{ SomeDate: Date }>(body, { serverTimezone: 'UTC' })
    expect(r.SomeDate).toBeInstanceOf(Date)
  })

  it('passes Edm.DateTime as wire string when shape.dateMode=string (full passthrough)', () => {
    const body = JSON.stringify({
      value: [{ Ref_Key: 'a', Date: '2025-03-15T15:30:00', EmptyDate: '0001-01-01T00:00:00' }],
    })
    const metadataIndex: MetadataIndex = {
      schemaNamespace: 'StandardODATA',
      schemas: {
        Catalog_X: {
          properties: {
            Ref_Key: { type: 'Edm.Guid', nullable: false },
            Date: { type: 'Edm.DateTime', nullable: true },
            EmptyDate: { type: 'Edm.DateTime', nullable: true },
          },
        },
      },
      entitySetToType: { Catalog_X: 'Catalog_X' },
      shape: { dateMode: 'string' },
    }
    const r = parseV3Collection<{ Date: string; EmptyDate: string }>(body, {
      serverTimezone: 'Europe/Moscow',
      typeHint: 'Catalog_X',
      metadataIndex,
    })
    // dateMode='string' — sentinel is NOT converted to null, visible as literal
    expect(r.value[0]?.Date).toBe('2025-03-15T15:30:00')
    expect(r.value[0]?.EmptyDate).toBe('0001-01-01T00:00:00')
  })

  it('parses nested tabular rows with THEIR OWN schema (Int64 / DateTime / ValueStorage)', () => {
    const nestedIndex: MetadataIndex = {
      schemaNamespace: 'StandardODATA',
      schemas: {
        Document_X: {
          properties: {
            Ref_Key: { type: 'Edm.Guid', nullable: false },
            Код: { type: 'Edm.Int64', nullable: false },
            Товары: { type: 'Collection(StandardODATA.Document_X_Товары_RowType)', nullable: true },
          },
        },
        Document_X_Товары_RowType: {
          properties: {
            LineNumber: { type: 'Edm.Int64', nullable: false },
            ДатаОтгрузки: { type: 'Edm.DateTime', nullable: true },
            Файл_Base64Data: { type: 'Edm.Binary', nullable: true },
            Файл_Type: { type: 'Edm.String', nullable: true },
          },
          valueStorages: ['Файл'],
        },
      },
      entitySetToType: { Document_X: 'Document_X' },
      shape: { int64Mode: 'number', dateMode: 'date' },
    }
    const body = JSON.stringify({
      'odata.metadata': '...',
      Ref_Key: 'g',
      Товары: [
        { LineNumber: '5', ДатаОтгрузки: '2025-03-16T00:00:00', Файл_Base64Data: 'aGk=', Файл_Type: 'image/png' },
      ],
    })
    const r = parseV3Single<{ Товары: Record<string, unknown>[] }>(body, {
      serverTimezone: 'UTC',
      typeHint: 'Document_X',
      metadataIndex: nestedIndex,
    })
    const row = r.Товары[0] as Record<string, unknown>
    // Without the nested-schema fix these would be looked up in Document_X
    // (which lacks LineNumber/ДатаОтгрузки/Файл*) and pass through unconverted.
    expect(row.LineNumber).toBe(5)
    expect(typeof row.LineNumber).toBe('number')
    expect(row.ДатаОтгрузки).toBeInstanceOf(Date)
    expect(row.Файл).toMatchObject({ contentType: 'image/png', base64Data: 'aGk=' })
    expect(row).not.toHaveProperty('Файл_Base64Data')
    expect(row).not.toHaveProperty('Файл_Type')
  })

  it('parses an expanded entity schema-less — parent schema does not bleed into it', () => {
    const nestedIndex: MetadataIndex = {
      schemaNamespace: 'StandardODATA',
      schemas: {
        Document_X: {
          properties: {
            Ref_Key: { type: 'Edm.Guid', nullable: false },
            // Document_X declares `Код` as Int64; the expanded `Owner` entity
            // (a navigation property, absent from `properties`) also has a `Код`
            // that is a plain string. Old behavior reused Document_X's schema for
            // the nested object → Number('ABC-1') = NaN.
            Код: { type: 'Edm.Int64', nullable: false },
          },
        },
      },
      entitySetToType: { Document_X: 'Document_X' },
      shape: { int64Mode: 'number', dateMode: 'date' },
    }
    const body = JSON.stringify({
      'odata.metadata': '...',
      Ref_Key: 'g',
      Owner: { Ref_Key: 'o', Код: 'ABC-1', Дата: '2025-03-16T00:00:00' },
    })
    const r = parseV3Single<{ Owner: Record<string, unknown> }>(body, {
      serverTimezone: 'UTC',
      typeHint: 'Document_X',
      metadataIndex: nestedIndex,
    })
    expect(r.Owner.Код).toBe('ABC-1') // schema-less → not coerced to NaN
    expect(r.Owner.Дата).toBeInstanceOf(Date) // regex heuristic still applies
  })

  it('converts Edm.DateTime sentinel to null when shape.dateMode=date (default)', () => {
    const body = JSON.stringify({
      value: [{ Ref_Key: 'a', Date: '0001-01-01T00:00:00' }],
    })
    const metadataIndex: MetadataIndex = {
      schemaNamespace: 'StandardODATA',
      schemas: {
        Catalog_X: {
          properties: {
            Ref_Key: { type: 'Edm.Guid', nullable: false },
            Date: { type: 'Edm.DateTime', nullable: true },
          },
        },
      },
      entitySetToType: { Catalog_X: 'Catalog_X' },
      shape: { dateMode: 'date' },
    }
    const r = parseV3Collection<{ Date: Date | null }>(body, {
      serverTimezone: 'Europe/Moscow',
      typeHint: 'Catalog_X',
      metadataIndex,
    })
    expect(r.value[0]?.Date).toBeNull()
  })
})

describe('V3 parser — date-times parseInZone used to drop or shift (#193)', () => {
  const index: MetadataIndex = {
    schemaNamespace: 'StandardODATA',
    schemas: {
      Catalog_X: {
        properties: {
          Date: { type: 'Edm.DateTime', nullable: true },
          Code: { type: 'Edm.String', nullable: true },
        },
      },
    },
    entitySetToType: { Catalog_X: 'Catalog_X' },
  }
  const typed = (value: Record<string, unknown>[], serverTimezone = TZ) =>
    parseV3Collection<{ Date: Date | null; Code: unknown }>(JSON.stringify({ value }), {
      serverTimezone,
      typeHint: 'Catalog_X',
      metadataIndex: index,
    })

  it('reads a year below 1000 (a typo such as 0202) instead of failing the whole collection', () => {
    const r = typed([{ Date: '0202-03-15T00:00:00' }, { Date: '2025-03-15T00:00:00' }], 'UTC')
    expect(r.value[0]?.Date?.toISOString()).toBe('0202-03-15T00:00:00.000Z')
    expect(r.value[1]?.Date?.toISOString()).toBe('2025-03-15T00:00:00.000Z')
  })

  it('still reads the 1С empty date as null, before any zone conversion', () => {
    expect(typed([{ Date: ONEC_EMPTY_DATE }]).value[0]?.Date).toBeNull()
    expect(parseV3Single<{ D: unknown }>(JSON.stringify({ D: ONEC_EMPTY_DATE }), { serverTimezone: TZ }).D).toBeNull()
  })

  it('takes only the exact empty date for null — not a value it merely starts', () => {
    expect(() => typed([{ Date: '0001-01-01T00:00:00garbage' }])).toThrow(ParseError)
    const r = parseV3Single<{ D: unknown }>(JSON.stringify({ D: '0001-01-01T00:00:00.250' }), { serverTimezone: 'UTC' })
    expect((r.D as Date).toISOString()).toBe('0001-01-01T00:00:00.250Z')
  })

  it('fails a schema-typed Edm.DateTime that is not a string or null', () => {
    expect(() => typed([{ Date: 20260315 }])).toThrow(
      'Edm.DateTime field Date: expected a date-time string or null, got number 20260315',
    )
    // dateMode: 'string' passes every value through untouched.
    const r = parseV3Collection<{ Date: unknown }>(JSON.stringify({ value: [{ Date: 20260315 }] }), {
      serverTimezone: TZ,
      typeHint: 'Catalog_X',
      metadataIndex: index,
      shape: { dateMode: 'string' },
    })
    expect(r.value[0]?.Date).toBe(20260315)
  })

  it('reads a time a daylight-saving switch skips moved forward by the gap', () => {
    const r = typed([{ Date: '2018-11-04T00:30:00' }], 'America/Sao_Paulo')
    // 00:30 does not exist that night; 01:30 -02:00 does.
    expect(r.value[0]?.Date?.toISOString()).toBe('2018-11-04T03:30:00.000Z')
  })

  it('fails a schema-typed Edm.DateTime that names no real date with a ParseError naming the field', () => {
    expect(() => typed([{ Date: '2026-02-30T00:00:00' }])).toThrow(ParseError)
    expect(() => typed([{ Date: '2026-02-30T00:00:00' }])).toThrow(
      'Edm.DateTime field Date: Invalid naive date-time "2026-02-30T00:00:00"',
    )
  })

  it('leaves a schema-less string the date heuristic matched but which names no real date as it came', () => {
    const r = parseV3Single<{ Note: unknown }>(JSON.stringify({ Note: '2026-13-45T99:00:00' }), { serverTimezone: TZ })
    expect(r.Note).toBe('2026-13-45T99:00:00')
  })
})
