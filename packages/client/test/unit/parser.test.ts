import { ONEC_EMPTY_DATE } from '@1c-odata/client'
import { describe, expect, it } from 'vitest'
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
    expect(r.value[0].Code).toBe('1')
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
    expect(r.value[0].СрокДоставки).toBeNull()
    expect(r.value[0].ДатаПлатежа).toBeInstanceOf(Date)
  })

  it('parseV3Collection parses valid datetime via parseInZone', () => {
    const input = '2025-03-15T00:00:00'
    const body = JSON.stringify({ value: [{ ДатаПлатежа: input }] })
    const r = parseV3Collection<{ ДатаПлатежа: Date }>(body, { serverTimezone: TZ })
    expect(r.value[0].ДатаПлатежа).toEqual(parseInZone(input, TZ))
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
    expect(r.value[0].Date).toBe('2025-03-15T15:30:00')
    expect(r.value[0].EmptyDate).toBe('0001-01-01T00:00:00')
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
    expect(r.value[0].Date).toBeNull()
  })
})
