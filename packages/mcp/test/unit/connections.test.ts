import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from '@1c-odata/client/internal'
import { fetchMetadataXml } from '@1c-odata/metadata'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../../src/config.js'
import {
  assertAddable,
  removeConnection,
  setConnectionLabel,
  updateConnectionCredentials,
  upsertConnection,
  verifyConnectivity,
  verifyReachability,
} from '../../src/connections.js'
import { SecretStore } from '../../src/secret-store.js'

// Isolate from the real OS keychain (best-effort keychain deletes on write/remove).
vi.mock('@napi-rs/keyring', () => ({
  Entry: class {
    getPassword(): string | null {
      return null
    }
    setPassword(): void {}
    deletePassword(): boolean {
      return false
    }
  },
}))

// Two paths touch the network: verifyConnectivity (via fetchMetadataXml, stubbed
// here) and verifyReachability (via the client transport `request`, stubbed below).
vi.mock('@1c-odata/metadata', () => ({ fetchMetadataXml: vi.fn().mockResolvedValue('<edmx/>') }))

// verifyReachability GETs the service root through the client transport — stub it.
vi.mock('@1c-odata/client/internal', async (orig) => {
  const actual = await orig<typeof import('@1c-odata/client/internal')>()
  return {
    ...actual,
    request: vi.fn().mockResolvedValue({ status: 200, statusText: 'OK', headers: {}, body: '{}', durationMs: 1 }),
  }
})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-conn-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// insecure: true keeps the password on the deterministic file backend.
const base = {
  baseUrl: 'http://host/odata/standard.odata',
  login: 'u',
  serverTimezone: 'Europe/Moscow',
  insecure: true,
} as const

const fileStore = () => new SecretStore({ dataDir: dir, insecure: true, warn: () => {} })

describe('upsertConnection', () => {
  it('saves the config and stores the password', async () => {
    const result = await upsertConnection({ ...base, dataDir: dir, name: 'trade', password: 'pw' })
    expect(result).toEqual({ overwritten: false, passwordBackend: 'file' })
    expect(loadConfig(dir).connections.trade).toEqual({
      baseUrl: 'http://host/odata/standard.odata',
      login: 'u',
      serverTimezone: 'Europe/Moscow',
    })
    expect(await fileStore().read('trade')).toEqual({ password: 'pw', source: 'file' })
  })

  it('stores the password verbatim — never trims edge whitespace', async () => {
    await upsertConnection({ ...base, dataDir: dir, name: 'trade', password: '  s p a c e s  ' })
    expect(await fileStore().read('trade')).toEqual({ password: '  s p a c e s  ', source: 'file' })
  })

  it('saves config only when no password is given', async () => {
    const result = await upsertConnection({ ...base, dataDir: dir, name: 'trade' })
    expect(result.passwordBackend).toBeUndefined()
    expect(loadConfig(dir).connections.trade?.login).toBe('u')
    expect(await fileStore().read('trade')).toBeNull()
  })

  it('trims surrounding whitespace from serverTimezone (so a valid zone is not rejected)', async () => {
    await upsertConnection({ ...base, dataDir: dir, name: 'trade', serverTimezone: '  Europe/Moscow  ' })
    expect(loadConfig(dir).connections.trade?.serverTimezone).toBe('Europe/Moscow')
  })

  it('strips userinfo from baseUrl before saving', async () => {
    await upsertConnection({ ...base, dataDir: dir, name: 'trade', baseUrl: 'http://u:p@host/odata' })
    expect(loadConfig(dir).connections.trade?.baseUrl).toBe('http://host/odata')
  })

  it('refuses to overwrite an existing connection by default', async () => {
    await upsertConnection({ ...base, dataDir: dir, name: 'trade' })
    await expect(upsertConnection({ ...base, dataDir: dir, name: 'trade' })).rejects.toThrow(/already exists/)
  })

  it('overwrites with overwrite: true', async () => {
    await upsertConnection({ ...base, dataDir: dir, name: 'trade', login: 'old' })
    const result = await upsertConnection({ ...base, dataDir: dir, name: 'trade', login: 'new', overwrite: true })
    expect(result.overwritten).toBe(true)
    expect(loadConfig(dir).connections.trade?.login).toBe('new')
  })

  it('stores a trimmed label, and skips a blank one', async () => {
    await upsertConnection({ ...base, dataDir: dir, name: 'trade', label: '  Торговля  ' })
    expect(loadConfig(dir).connections.trade?.label).toBe('Торговля')
    await upsertConnection({ ...base, dataDir: dir, name: 'blank', label: '   ' })
    expect(loadConfig(dir).connections.blank?.label).toBeUndefined()
  })

  it('preserves an existing label on an overwrite that does not supply one', async () => {
    await upsertConnection({ ...base, dataDir: dir, name: 'trade', label: 'Торговля' })
    await upsertConnection({ ...base, dataDir: dir, name: 'trade', serverTimezone: 'UTC', overwrite: true })
    expect(loadConfig(dir).connections.trade?.label).toBe('Торговля')
  })

  it('replaces the label when an overwrite supplies a new one', async () => {
    await upsertConnection({ ...base, dataDir: dir, name: 'trade', label: 'Старый' })
    await upsertConnection({ ...base, dataDir: dir, name: 'trade', label: 'Новый', overwrite: true })
    expect(loadConfig(dir).connections.trade?.label).toBe('Новый')
  })

  it('rejects an invalid (non-ASCII) connection name', async () => {
    await expect(upsertConnection({ ...base, dataDir: dir, name: 'Валюта' })).rejects.toThrow(/Invalid connection name/)
  })

  it('rejects a name colliding on the password env var with a DIFFERENT connection', async () => {
    await upsertConnection({ ...base, dataDir: dir, name: 'tvip-trade', password: 'pw' })
    // 'tvip_trade' slugs to the same ONEC_TVIP_TRADE_PASSWORD as 'tvip-trade';
    // allowing it would let the new connection resolve the other's env password.
    await expect(upsertConnection({ ...base, dataDir: dir, name: 'tvip_trade' })).rejects.toThrow(/collides/)
    // Re-saving the SAME name is fine (not a cross-connection collision).
    await expect(
      upsertConnection({ ...base, dataDir: dir, name: 'tvip-trade', overwrite: true }),
    ).resolves.toBeDefined()
  })

  it('clears the stored password on a passwordless overwrite that changes the auth target', async () => {
    await upsertConnection({ ...base, dataDir: dir, name: 'trade', password: 'pw' })
    const r = await upsertConnection({
      ...base,
      dataDir: dir,
      name: 'trade',
      baseUrl: 'http://other/odata',
      overwrite: true,
    })
    expect(r.passwordCleared).toBe(true)
    expect(await fileStore().read('trade')).toBeNull()
  })

  it('keeps the stored password on a passwordless overwrite that does not change the auth target', async () => {
    await upsertConnection({ ...base, dataDir: dir, name: 'trade', password: 'pw' })
    const r = await upsertConnection({ ...base, dataDir: dir, name: 'trade', serverTimezone: 'UTC', overwrite: true })
    expect(r.passwordCleared).toBeUndefined()
    expect(await fileStore().read('trade')).toEqual({ password: 'pw', source: 'file' })
  })
})

describe('removeConnection', () => {
  it('removes the config and the stored password', async () => {
    await upsertConnection({ ...base, dataDir: dir, name: 'trade', password: 'pw' })
    expect(await removeConnection({ dataDir: dir, name: 'trade', insecure: true })).toBe(true)
    expect(loadConfig(dir).connections.trade).toBeUndefined()
    expect(await fileStore().read('trade')).toBeNull()
  })

  it('returns false for an unknown connection', async () => {
    expect(await removeConnection({ dataDir: dir, name: 'nope', insecure: true })).toBe(false)
  })
})

describe('assertAddable', () => {
  it('throws on a duplicate without overwrite, passes with overwrite or when absent', async () => {
    await upsertConnection({ ...base, dataDir: dir, name: 'trade' })
    expect(() => assertAddable(dir, 'trade', false)).toThrow(/already exists/)
    expect(() => assertAddable(dir, 'trade', true)).not.toThrow()
    expect(() => assertAddable(dir, 'fresh', false)).not.toThrow()
  })

  it('rejects an invalid name before any existence check', () => {
    expect(() => assertAddable(dir, 'Валюта', false)).toThrow(/Invalid connection name/)
  })

  it('throws on a password-env-var collision before any verify (preflight)', async () => {
    await upsertConnection({ ...base, dataDir: dir, name: 'tvip-trade', password: 'pw' })
    expect(() => assertAddable(dir, 'tvip_trade', false)).toThrow(/collides/)
  })
})

describe('setConnectionLabel', () => {
  it('sets a label, leaving other fields untouched', async () => {
    await upsertConnection({ ...base, dataDir: dir, name: 'trade', password: 'pw' })
    const result = await setConnectionLabel({ dataDir: dir, name: 'trade', label: '  Торговля  ' })
    expect(result).toEqual({ label: 'Торговля', cleared: false })
    expect(loadConfig(dir).connections.trade?.label).toBe('Торговля')
    // Credentials and the rest of the descriptor are preserved.
    expect(loadConfig(dir).connections.trade?.login).toBe('u')
    expect(await fileStore().read('trade')).toEqual({ password: 'pw', source: 'file' })
  })

  it('clears the label with a blank value (reverts to the name fallback)', async () => {
    await upsertConnection({ ...base, dataDir: dir, name: 'trade', label: 'Торговля' })
    const result = await setConnectionLabel({ dataDir: dir, name: 'trade', label: '   ' })
    expect(result).toEqual({ label: 'trade', cleared: true })
    expect(loadConfig(dir).connections.trade?.label).toBeUndefined()
  })

  it('throws for an unknown connection', async () => {
    await expect(setConnectionLabel({ dataDir: dir, name: 'nope', label: 'x' })).rejects.toThrow(/No connection named/)
  })
})

describe('updateConnectionCredentials', () => {
  it('updates the login only, keeping the stored password', async () => {
    await upsertConnection({ ...base, dataDir: dir, name: 'trade', password: 'pw' })
    const result = await updateConnectionCredentials({ dataDir: dir, name: 'trade', login: 'newuser', insecure: true })
    expect(result).toEqual({ loginUpdated: true, passwordUpdated: false })
    expect(loadConfig(dir).connections.trade?.login).toBe('newuser')
    expect(await fileStore().read('trade')).toEqual({ password: 'pw', source: 'file' })
  })

  it('updates the password only, keeping the login', async () => {
    await upsertConnection({ ...base, dataDir: dir, name: 'trade', password: 'old' })
    const result = await updateConnectionCredentials({ dataDir: dir, name: 'trade', password: 'new', insecure: true })
    expect(result).toEqual({ loginUpdated: false, passwordUpdated: true, passwordBackend: 'file' })
    expect(loadConfig(dir).connections.trade?.login).toBe('u')
    expect(await fileStore().read('trade')).toEqual({ password: 'new', source: 'file' })
  })

  it('updates both together and preserves the label', async () => {
    await upsertConnection({ ...base, dataDir: dir, name: 'trade', password: 'old', label: 'Торговля' })
    const result = await updateConnectionCredentials({
      dataDir: dir,
      name: 'trade',
      login: 'newuser',
      password: 'new',
      insecure: true,
    })
    expect(result).toEqual({ loginUpdated: true, passwordUpdated: true, passwordBackend: 'file' })
    const conn = loadConfig(dir).connections.trade
    expect(conn?.login).toBe('newuser')
    expect(conn?.label).toBe('Торговля')
    expect(await fileStore().read('trade')).toEqual({ password: 'new', source: 'file' })
  })

  it('trims the login and reports loginUpdated false when it matches the current one', async () => {
    await upsertConnection({ ...base, dataDir: dir, name: 'trade', login: 'u' })
    const result = await updateConnectionCredentials({ dataDir: dir, name: 'trade', login: '  u  ', insecure: true })
    expect(result.loginUpdated).toBe(false)
    expect(loadConfig(dir).connections.trade?.login).toBe('u')
  })

  it('rejects an empty login / empty password / neither field', async () => {
    await upsertConnection({ ...base, dataDir: dir, name: 'trade' })
    await expect(updateConnectionCredentials({ dataDir: dir, name: 'trade', login: '   ' })).rejects.toThrow(
      /login must not be empty/,
    )
    await expect(updateConnectionCredentials({ dataDir: dir, name: 'trade', password: '' })).rejects.toThrow(
      /password must not be empty/,
    )
    await expect(updateConnectionCredentials({ dataDir: dir, name: 'trade' })).rejects.toThrow(/Provide a new login/)
  })

  it('throws for an unknown connection', async () => {
    await expect(updateConnectionCredentials({ dataDir: dir, name: 'nope', password: 'x' })).rejects.toThrow(
      /No connection named/,
    )
  })
})

describe('verifyConnectivity', () => {
  it('strips userinfo and trims the login before fetching $metadata', async () => {
    vi.mocked(fetchMetadataXml).mockClear()
    await verifyConnectivity({ baseUrl: 'http://user:secret@host/odata', login: '  u  ', password: 'pw' })
    expect(vi.mocked(fetchMetadataXml)).toHaveBeenCalledTimes(1)
    const arg = vi.mocked(fetchMetadataXml).mock.calls[0]?.[0]
    expect(arg?.baseUrl).toBe('http://host/odata')
  })

  it('propagates a fetch failure (auth/network error)', async () => {
    vi.mocked(fetchMetadataXml).mockRejectedValueOnce(new Error('401 Unauthorized'))
    await expect(verifyConnectivity({ baseUrl: 'http://host/odata', login: 'u', password: 'bad' })).rejects.toThrow(
      /401/,
    )
  })
})

describe('verifyReachability', () => {
  it('GETs the OData service ROOT with basic auth (not $metadata)', async () => {
    vi.mocked(request).mockClear()
    await verifyReachability({ baseUrl: 'http://user:secret@host/odata/', login: '  u  ', password: 'pw' })
    expect(vi.mocked(request)).toHaveBeenCalledTimes(1)
    const [req] = vi.mocked(request).mock.calls[0] ?? []
    expect(req?.method).toBe('GET')
    expect(req?.url).toBe('http://host/odata/') // root + trailing slash, userinfo stripped
    expect(req?.url).not.toContain('$metadata') // light probe — never downloads the schema
    expect(String(req?.headers?.Authorization)).toMatch(/^Basic /)
  })

  it('propagates a non-2xx (auth/network) failure', async () => {
    vi.mocked(request).mockRejectedValueOnce(new Error('401 Unauthorized'))
    await expect(verifyReachability({ baseUrl: 'http://host/odata/', login: 'u', password: 'bad' })).rejects.toThrow(
      /401/,
    )
  })

  it('rejects a 2xx HTML response (sign-in portal / wrong URL) instead of reporting healthy', async () => {
    vi.mocked(request).mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: '<!doctype html><html><body>Please sign in</body></html>',
      durationMs: 1,
    })
    await expect(verifyReachability({ baseUrl: 'http://host/odata/', login: 'u', password: 'pw' })).rejects.toThrow(
      /OData document/,
    )
  })

  it('rejects a 2xx non-JSON/non-XML body (proxy plain-text page) instead of reporting healthy', async () => {
    vi.mocked(request).mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/plain' },
      body: 'Service temporarily unavailable',
      durationMs: 1,
    })
    await expect(verifyReachability({ baseUrl: 'http://host/odata/', login: 'u', password: 'pw' })).rejects.toThrow(
      /OData document/,
    )
  })

  it('rejects a bare `<…>` HTML fragment that is not an OData service document', async () => {
    // A missing/misleading content-type + a body like `<body>…` must NOT pass just
    // because it starts with `<` — only an Atom <service> document is a valid XML root.
    vi.mocked(request).mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: {},
      body: '<body>Welcome to the portal</body>',
      durationMs: 1,
    })
    await expect(verifyReachability({ baseUrl: 'http://host/odata/', login: 'u', password: 'pw' })).rejects.toThrow(
      /OData document/,
    )
  })

  it('accepts an Atom <service> document (behind an XML declaration)', async () => {
    vi.mocked(request).mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/atomsvc+xml' },
      body: '<?xml version="1.0" encoding="UTF-8"?><service xmlns="http://www.w3.org/2007/app"><workspace/></service>',
      durationMs: 1,
    })
    await expect(
      verifyReachability({ baseUrl: 'http://host/odata/', login: 'u', password: 'pw' }),
    ).resolves.toBeUndefined()
  })

  it('accepts a <service> document behind a long prolog/comment (head slice is not too short)', async () => {
    // A >256-byte leading comment would push <service> out of an over-tight slice.
    const longComment = `<!-- ${'x'.repeat(400)} -->`
    vi.mocked(request).mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: {},
      body: `<?xml version="1.0"?>${longComment}<service xmlns="http://www.w3.org/2007/app"><workspace/></service>`,
      durationMs: 1,
    })
    await expect(
      verifyReachability({ baseUrl: 'http://host/odata/', login: 'u', password: 'pw' }),
    ).resolves.toBeUndefined()
  })
})

describe('concurrent mutations', () => {
  it('serializes a parallel upsert + remove without losing the new connection', async () => {
    await upsertConnection({ ...base, dataDir: dir, name: 'a' })
    await Promise.all([
      upsertConnection({ ...base, dataDir: dir, name: 'b' }),
      removeConnection({ dataDir: dir, name: 'a', insecure: true }),
    ])
    const conns = loadConfig(dir).connections
    expect(conns.a).toBeUndefined()
    expect(conns.b).toBeDefined()
  })
})
