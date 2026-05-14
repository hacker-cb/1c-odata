import { describe, expect, it } from 'vitest'
import type { Connection } from '../../src/connection.js'
import { parseV3Single } from '../../src/parser.js'
import { clientOptionsFromConnection } from '../../src/runtime.js'

const baseConn: Connection = {
  baseUrl: 'http://example.com',
  auth: { username: 'u', password: 'p' },
  serverTimezone: 'Europe/Moscow',
}

describe('clientOptionsFromConnection — shape propagation', () => {
  it('forwards Connection.shape into options.shape', () => {
    const opts = clientOptionsFromConnection({
      ...baseConn,
      shape: { int64Mode: 'string', dateMode: 'string' },
    })
    expect(opts.shape).toEqual({ int64Mode: 'string', dateMode: 'string' })
  })

  it('does NOT add shape field when Connection.shape is undefined', () => {
    const opts = clientOptionsFromConnection(baseConn)
    expect('shape' in opts).toBe(false)
  })
})

describe('parser — shape resolution from opts.shape vs metadataIndex.shape', () => {
  // Synthetic minimal body: just the field we want to test.
  const body = JSON.stringify({
    'odata.metadata': 'http://x/$metadata#X',
    BigNum: '12345',
  })

  it('uses opts.shape when provided (no metadataIndex)', () => {
    const result = parseV3Single<{ BigNum: string | number | bigint }>(body, {
      serverTimezone: 'Europe/Moscow',
      shape: { int64Mode: 'string', dateMode: 'date' },
    })
    // Without metadataIndex, parser can't know BigNum is Edm.Int64, so no
    // int64Mode applied — value stays as wire string. This test verifies
    // opts.shape is at least accepted as a field; behavior matches no-meta.
    expect(typeof result.BigNum).toBe('string')
  })

  it('opts.shape takes precedence over metadataIndex.shape', () => {
    const result = parseV3Single<{ BigNum: string | number | bigint }>(body, {
      serverTimezone: 'Europe/Moscow',
      typeHint: 'X',
      metadataIndex: {
        schemaNamespace: 'StandardODATA',
        schemas: { X: { properties: { BigNum: { type: 'Edm.Int64', nullable: false } } } },
        entitySetToType: { X: 'X' },
        shape: { int64Mode: 'bigint', dateMode: 'date' }, // metadataIndex says bigint
      },
      shape: { int64Mode: 'string', dateMode: 'date' }, // opts.shape says string — WINS
    })
    expect(result.BigNum).toBe('12345') // string, not bigint
  })

  it('falls back to metadataIndex.shape when opts.shape not set', () => {
    const result = parseV3Single<{ BigNum: string | number | bigint }>(body, {
      serverTimezone: 'Europe/Moscow',
      typeHint: 'X',
      metadataIndex: {
        schemaNamespace: 'StandardODATA',
        schemas: { X: { properties: { BigNum: { type: 'Edm.Int64', nullable: false } } } },
        entitySetToType: { X: 'X' },
        shape: { int64Mode: 'bigint', dateMode: 'date' },
      },
    })
    expect(result.BigNum).toBe(12345n) // bigint from metadataIndex.shape
  })
})
