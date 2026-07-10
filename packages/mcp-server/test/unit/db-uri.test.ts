// test/unit/db-uri.test.ts
// Guards the boot-time Postgres-URI validation (deploy/.env.example mandates a
// URL-safe password; createDb enforces it before pg sees a corrupt URI).
import { describe, expect, it } from 'vitest'
import { createDb } from '../../src/store/db.js'

describe('createDb pg URI validation', () => {
  it('rejects a URI whose password carries a raw "/" (base64 footgun)', () => {
    expect(() => createDb({ kind: 'pg', connectionString: 'postgres://mcp:Ab+/cd==xy@db:5432/mcp' })).toThrow(
      /URL-unsafe|openssl rand -hex/,
    )
  })

  it('accepts a URL-safe (hex password) URI without throwing', () => {
    // Pool construction is lazy — no connection is attempted here. Close it so the
    // test leaves no open handle.
    const handle = createDb({ kind: 'pg', connectionString: 'postgres://mcp:0a1b2c3d@db:5432/mcp' })
    expect(handle.dialect).toBe('pg')
    return handle.close()
  })

  it('accepts a pre-encoded "%2F" password (already URL-safe)', () => {
    const handle = createDb({ kind: 'pg', connectionString: 'postgres://mcp:a%2Fb@db:5432/mcp' })
    return handle.close()
  })

  it('leaves the libpq keyword form (not a URI) for pg to parse', () => {
    // `host=… password=…` is not a URI — validation must skip it, not reject it.
    const handle = createDb({ kind: 'pg', connectionString: 'host=db port=5432 dbname=mcp user=mcp password=a/b' })
    return handle.close()
  })
})
