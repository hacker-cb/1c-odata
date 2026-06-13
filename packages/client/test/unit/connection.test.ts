import { describe, expect, it } from 'vitest'
import { type Connection, type DataShape, parseConnectionUrl } from '../../src/connection.js'

describe('DataShape', () => {
  it('allows all shape options as optional', () => {
    const s: DataShape = {}
    expect(s).toBeDefined()
    const full: DataShape = {
      int64Mode: 'bigint',
      dateMode: 'date',
    }
    expect(full.int64Mode).toBe('bigint')
  })
})

describe('Connection', () => {
  it('allows an optional shape', () => {
    const conn: Connection = {
      baseUrl: 'http://x.test/odata',
      auth: { username: 'u', password: 'p' },
      serverTimezone: 'Europe/Moscow',
      shape: { int64Mode: 'bigint' },
    }
    expect(conn.shape?.int64Mode).toBe('bigint')
  })

  it('Connection.auth is required (compile-time check)', () => {
    // @ts-expect-error — auth is required
    const _conn: Connection = { baseUrl: 'http://x', serverTimezone: 'Europe/Moscow' }
    expect(_conn).toBeDefined()
  })

  it('parseConnectionUrl spread integrates with Connection literal', () => {
    const conn: Connection = {
      ...parseConnectionUrl('http://u:p@host/odata'),
      serverTimezone: 'Europe/Moscow',
    }
    expect(conn.baseUrl).toBe('http://host/odata')
    expect(conn.auth).toEqual({ username: 'u', password: 'p' })
  })
})
