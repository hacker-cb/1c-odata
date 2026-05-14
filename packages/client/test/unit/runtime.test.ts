import { describe, expect, it } from 'vitest'
import type { Connection } from '../../src/connection.js'
import { clientOptionsFromConnection } from '../../src/runtime.js'

describe('clientOptionsFromConnection', () => {
  it('builds ODataV3ClientOptions from Connection', () => {
    const conn: Connection = {
      baseUrl: 'http://x.test/odata',
      auth: { username: 'u', password: 'p' },
      serverTimezone: 'Europe/Moscow',
      shape: { int64Mode: 'bigint' },
      codegen: { include: ['Catalog_*'] },
    }
    const opts = clientOptionsFromConnection(conn)
    expect(opts.baseUrl).toBe('http://x.test/odata')
    expect(opts.serverTimezone).toBe('Europe/Moscow')
    // `shape` is forwarded from Connection into ODataV3ClientOptions so the client
    // can resolve it at runtime even when no metadataIndex is loaded.
    expect((opts as Record<string, unknown>).shape).toEqual({ int64Mode: 'bigint' })
    expect(opts.auth.scheme).toBe('basic')
    expect(opts.auth.header).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`)
    expect((opts as Record<string, unknown>).codegen).toBeUndefined()
  })

  it('does NOT read process.env (pure)', () => {
    // No env setup at all — should still work when serverTimezone is provided.
    const conn: Connection = {
      baseUrl: 'http://x',
      auth: { username: 'u', password: 'p' },
      serverTimezone: 'Europe/Moscow',
    }
    expect(() => clientOptionsFromConnection(conn)).not.toThrow()
  })
})
