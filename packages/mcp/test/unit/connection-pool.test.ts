import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EdmxModel } from '@1c-odata/metadata'
import { buildMetadataIndex, fetchMetadataXml, parseEdmx } from '@1c-odata/metadata'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { ConnectionPool } from '../../src/connection-pool.js'
import { removeConnection, upsertConnection } from '../../src/connections.js'
import { FileConnectionSource } from '../../src/file-connection-source.js'
import { secretKey } from '../../src/secret-store.js'

// Stub the network + parse + index build so get() never touches a real base;
// keep @1c-odata/client real except the client ctor (InvalidArgumentError, used
// by the pool's error paths, must stay genuine).
vi.mock('@1c-odata/metadata', () => ({
  fetchMetadataXml: vi.fn(),
  parseEdmx: vi.fn(),
  buildMetadataIndex: vi.fn(),
}))
// Isolate from the real OS keychain: upsertConnection / removeConnection delete best-effort there.
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
vi.mock('@1c-odata/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@1c-odata/client')>()),
  ODataV3Client: vi.fn(),
}))

let dir: string
const write = (file: string, body: unknown) => writeFileSync(join(dir, file), JSON.stringify(body), { mode: 0o600 })

beforeEach(() => {
  // A password the developer's shell sets for `trade` would outrank the stored ones.
  vi.stubEnv('ONEC_TRADE_PASSWORD', '')
  dir = mkdtempSync(join(tmpdir(), 'mcp-pool-'))
  vi.mocked(fetchMetadataXml).mockReset().mockResolvedValue('<edmx/>')
  vi.mocked(parseEdmx)
    .mockReset()
    .mockReturnValue({} as unknown as EdmxModel)
  vi.mocked(buildMetadataIndex)
    .mockReset()
    .mockReturnValue({ entitySetToType: {}, schemas: {} } as never)
  // One connection 'trade' with a file-backend password; 'nopw' has none.
  write('config.json', {
    connections: {
      trade: { baseUrl: 'http://h/odata/standard.odata', login: 'u', serverTimezone: 'Europe/Moscow' },
      nopw: { baseUrl: 'http://h2/odata/standard.odata', login: 'u', serverTimezone: 'Europe/Moscow' },
    },
  })
  write('credentials.json', { trade: 'pw' })
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const pool = () => new ConnectionPool(new FileConnectionSource({ dataDir: dir, insecure: true }))

describe('ConnectionPool.get', () => {
  it('downloads $metadata once for concurrent calls on the same connection', async () => {
    const p = pool()
    const [a, b] = await Promise.all([p.get('trade'), p.get('trade')])
    expect(a).toBe(b) // same cached entry
    expect(vi.mocked(fetchMetadataXml)).toHaveBeenCalledTimes(1)
  })

  it('does not cache a failed build — the next call retries', async () => {
    const p = pool()
    vi.mocked(fetchMetadataXml).mockRejectedValueOnce(new Error('network down'))
    await expect(p.get('trade')).rejects.toThrow('network down')
    // Second attempt succeeds (default mockResolvedValue) and re-fetches.
    await expect(p.get('trade')).resolves.toBeDefined()
    expect(vi.mocked(fetchMetadataXml)).toHaveBeenCalledTimes(2)
  })

  it('caches a successful build — a second call does not re-download', async () => {
    const p = pool()
    await p.get('trade')
    await p.get('trade')
    expect(vi.mocked(fetchMetadataXml)).toHaveBeenCalledTimes(1)
  })

  it('rejects an unknown connection', async () => {
    await expect(pool().get('missing')).rejects.toThrow(/No connection named "missing"/)
  })

  it('rejects a connection with no resolvable password', async () => {
    await expect(pool().get('nopw')).rejects.toThrow(/No password for "nopw"/)
  })

  it('validates a loaded connection (IANA timezone) before downloading $metadata', async () => {
    // A hand-edited/migrated config.json bypasses the add-path validation; the
    // pool must reject a bad timezone up front, not after a multi-MB $metadata fetch.
    write('config.json', {
      connections: { badtz: { baseUrl: 'http://h/odata/standard.odata', login: 'u', serverTimezone: 'Europe/Mosow' } },
    })
    write('credentials.json', { badtz: 'pw' })
    await expect(pool().get('badtz')).rejects.toThrow(/serverTimezone is not a valid IANA timezone/)
    expect(vi.mocked(fetchMetadataXml)).not.toHaveBeenCalled()
  })

  it('refresh() drops the cache so the next get re-downloads', async () => {
    const p = pool()
    await p.get('trade')
    p.refresh('trade')
    await p.get('trade')
    expect(vi.mocked(fetchMetadataXml)).toHaveBeenCalledTimes(2)
  })
})

describe('ConnectionPool.get — a connection another process changed (#274)', () => {
  // Two pools on one data dir stand for two processes: `serve` holding a cached
  // client, and the CLI (or another MCP server) changing config.json and the
  // password store behind it — nothing calls refresh() on the first pool.
  const trade = { name: 'trade', baseUrl: 'http://h/odata/standard.odata', login: 'u' }
  /** The key `trade`'s password lives under, as config.json stands. */
  const tradeKey = () => {
    const conn = loadConfig(dir).connections.trade
    if (conn === undefined) throw new Error('trade missing')
    return secretKey('trade', conn)
  }
  const change = (input: Partial<Parameters<typeof upsertConnection>[0]>) =>
    upsertConnection({
      ...trade,
      dataDir: dir,
      serverTimezone: 'Europe/Moscow',
      password: 'pw',
      insecure: true,
      overwrite: true,
      ...input,
    })

  it('keeps the cached entry while nothing changed — the label is cosmetic', async () => {
    const serve = pool()
    const built = await serve.get('trade')
    await change({ label: 'Торговля' })
    await expect(serve.get('trade')).resolves.toBe(built)
    expect(vi.mocked(fetchMetadataXml)).toHaveBeenCalledTimes(1)
  })

  it('rebuilds after another process changes the timezone', async () => {
    const serve = pool()
    const built = await serve.get('trade')
    await change({ serverTimezone: 'Asia/Novosibirsk' })
    const rebuilt = await serve.get('trade')
    expect(rebuilt).not.toBe(built)
    expect(rebuilt.connection.serverTimezone).toBe('Asia/Novosibirsk')
    // The other process's own pool builds the same, and the server's is cached again.
    expect((await pool().get('trade')).connection.serverTimezone).toBe('Asia/Novosibirsk')
    await expect(serve.get('trade')).resolves.toBe(rebuilt)
    expect(vi.mocked(fetchMetadataXml)).toHaveBeenCalledTimes(3)
  })

  it('rebuilds after another process changes the login, the URL or the shape', async () => {
    const serve = pool()
    await serve.get('trade')
    await change({ login: 'u2' })
    expect((await serve.get('trade')).connection.auth).toMatchObject({ username: 'u2' })
    await change({ login: 'u2', baseUrl: 'http://h4/odata/standard.odata' })
    expect((await serve.get('trade')).connection.baseUrl).toBe('http://h4/odata/standard.odata')
    await change({ login: 'u2', baseUrl: 'http://h4/odata/standard.odata', shape: { int64Mode: 'bigint' } })
    expect((await serve.get('trade')).connection.shape).toEqual({ int64Mode: 'bigint' })
    expect(vi.mocked(fetchMetadataXml)).toHaveBeenCalledTimes(4)
  })

  it('rebuilds after another process changes only the password', async () => {
    const serve = pool()
    await serve.get('trade')
    await change({ password: 'pw2' })
    const rebuilt = await serve.get('trade')
    expect(rebuilt.connection.auth).toMatchObject({ username: 'u', password: 'pw2' })
    expect(vi.mocked(fetchMetadataXml)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(fetchMetadataXml).mock.lastCall?.[0].auth).toMatchObject({ header: `Basic ${btoa('u:pw2')}` })
  })

  it('fails as an unknown connection once another process removes it, and builds anew when re-added', async () => {
    const serve = pool()
    const built = await serve.get('trade')
    await removeConnection({ dataDir: dir, name: 'trade', insecure: true })
    await expect(serve.get('trade')).rejects.toThrow(/No connection named "trade"/)
    expect((await serve.list()).map((c) => c.name)).toEqual(['nopw'])
    await change({})
    const readded = await serve.get('trade')
    expect(readded).not.toBe(built)
    expect(vi.mocked(fetchMetadataXml)).toHaveBeenCalledTimes(2)
  })

  it('keeps an entry whose password no longer reads — a locked keychain reads the same — while its descriptor stands', async () => {
    const serve = pool()
    const built = await serve.get('trade')
    write('credentials.json', {})
    await expect(serve.get('trade')).resolves.toBe(built)
    expect((await serve.list()).find((c) => c.name === 'trade')?.loaded).toBe(true)
    // A descriptor changed too: nothing to build with, so it fails as password-less.
    await change({ serverTimezone: 'Asia/Novosibirsk' })
    write('credentials.json', {})
    await expect(serve.get('trade')).rejects.toThrow(/No password for "trade"/)
    // Under the key the changed connection reads — its target's (#272).
    write('credentials.json', { [tradeKey()]: 'pw' })
    await expect(serve.get('trade')).resolves.not.toBe(built)
    expect(vi.mocked(fetchMetadataXml)).toHaveBeenCalledTimes(2)
  })

  it('reports an entry built with an older password as not loaded', async () => {
    const serve = pool()
    await serve.get('trade')
    await change({ password: 'pw2' })
    expect((await serve.list()).find((c) => c.name === 'trade')?.loaded).toBe(false)
  })

  it('drops the entry of a connection another process removed once it is listed, without a get by its name', async () => {
    const serve = pool()
    const built = await serve.get('trade')
    await removeConnection({ dataDir: dir, name: 'trade', insecure: true })
    await serve.list()
    // Re-added unchanged: the old entry is gone, so it builds anew.
    await change({})
    await expect(serve.get('trade')).resolves.not.toBe(built)
    expect(vi.mocked(fetchMetadataXml)).toHaveBeenCalledTimes(2)
  })

  it('reads a shape with its keys reordered as unchanged', async () => {
    write('config.json', {
      connections: {
        trade: { ...trade, serverTimezone: 'Europe/Moscow', shape: { int64Mode: 'bigint', dateMode: 'string' } },
      },
    })
    const serve = pool()
    const built = await serve.get('trade')
    write('config.json', {
      connections: {
        trade: { ...trade, serverTimezone: 'Europe/Moscow', shape: { dateMode: 'string', int64Mode: 'bigint' } },
      },
    })
    await expect(serve.get('trade')).resolves.toBe(built)
    expect(vi.mocked(fetchMetadataXml)).toHaveBeenCalledTimes(1)
  })

  it('reads a null shape as none', async () => {
    write('config.json', { connections: { trade: { ...trade, serverTimezone: 'Europe/Moscow', shape: null } } })
    const serve = pool()
    await expect(serve.get('trade')).resolves.toBeDefined()
    expect((await serve.list()).find((c) => c.name === 'trade')?.loaded).toBe(true)
  })

  it('a listing never fails on one connection whose password cannot be read', async () => {
    const source = new FileConnectionSource({ dataDir: dir, insecure: true })
    const serve = new ConnectionPool(source)
    await serve.get('trade')
    vi.spyOn(source, 'getSecret').mockRejectedValue(new Error('decrypt failed'))
    expect((await serve.list()).find((c) => c.name === 'trade')?.loaded).toBe(false)
  })

  it('a call still reading when the connection is removed fails as unknown instead of caching it again', async () => {
    const source = new FileConnectionSource({ dataDir: dir, insecure: true })
    const serve = new ConnectionPool(source)
    await serve.get('trade')
    const getSecret = source.getSecret.bind(source)
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    vi.spyOn(source, 'getSecret')
      .mockImplementationOnce(async (name, base) => {
        await gate
        return getSecret(name, base)
      })
      .mockImplementation(getSecret)
    const late = serve.get('trade') // reads the connection, then waits on its password
    await vi.waitFor(() => expect(source.getSecret).toHaveBeenCalledTimes(1))
    await removeConnection({ dataDir: dir, name: 'trade', insecure: true })
    await serve.list() // drops the entry
    release()
    await expect(late).rejects.toThrow(/No connection named "trade"/)
    await change({})
    await serve.get('trade')
    expect(vi.mocked(fetchMetadataXml)).toHaveBeenCalledTimes(2)
  })

  it('a call that read the source earlier never replaces an entry built from a later read', async () => {
    const source = new FileConnectionSource({ dataDir: dir, insecure: true })
    const getSecret = source.getSecret.bind(source)
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    // The first read of the password waits; every later one answers at once.
    vi.spyOn(source, 'getSecret')
      .mockImplementationOnce(async (name, base) => {
        await gate
        return getSecret(name, base)
      })
      .mockImplementation(getSecret)
    const serve = new ConnectionPool(source)
    const early = serve.get('trade') // reads Europe/Moscow, then waits on its password
    await vi.waitFor(() => expect(source.getSecret).toHaveBeenCalledTimes(1))
    await change({ serverTimezone: 'Asia/Novosibirsk' })
    const late = await serve.get('trade') // reads Asia/Novosibirsk and builds
    release()
    await expect(early).resolves.toBe(late)
    await expect(serve.get('trade')).resolves.toBe(late)
    expect(late.connection.serverTimezone).toBe('Asia/Novosibirsk')
    expect(vi.mocked(fetchMetadataXml)).toHaveBeenCalledTimes(1)
  })

  it('reports an entry built from an older descriptor as not loaded', async () => {
    const serve = pool()
    await serve.get('trade')
    await change({ serverTimezone: 'Asia/Novosibirsk' })
    expect((await serve.list()).find((c) => c.name === 'trade')?.loaded).toBe(false)
    await serve.get('trade')
    expect((await serve.list()).find((c) => c.name === 'trade')?.loaded).toBe(true)
  })

  it('a call whose slot keeps moving under every read answers from its own read and leaves the cache alone', async () => {
    const source = new FileConnectionSource({ dataDir: dir, insecure: true })
    const serve = new ConnectionPool(source)
    await serve.get('trade')
    const cache = Reflect.get(serve, 'cache') as Map<string, unknown>
    const getSecret = source.getSecret.bind(source)
    // Every password read sees another call put a slot of its own in place.
    let moved: unknown
    vi.spyOn(source, 'getSecret').mockImplementation(async (name, base) => {
      moved = { entry: new Promise(() => {}), descriptor: 'another', password: 'another' }
      cache.set('trade', moved)
      return getSecret(name, base)
    })
    const entry = await serve.get('trade')
    expect(entry.connection.serverTimezone).toBe('Europe/Moscow')
    expect(source.getSecret).toHaveBeenCalledTimes(3)
    expect(cache.get('trade')).toBe(moved)
    expect(vi.mocked(fetchMetadataXml)).toHaveBeenCalledTimes(2)
  })

  it('a stale build that fails leaves the newer build cached', async () => {
    const serve = pool()
    let failStale: (err: Error) => void = () => {}
    vi.mocked(fetchMetadataXml).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          failStale = reject
        }),
    )
    const stale = serve.get('trade')
    await vi.waitFor(() => expect(vi.mocked(fetchMetadataXml)).toHaveBeenCalledTimes(1))
    await change({ serverTimezone: 'Asia/Novosibirsk' })
    const fresh = await serve.get('trade')
    failStale(new Error('network down'))
    await expect(stale).rejects.toThrow('network down')
    await expect(serve.get('trade')).resolves.toBe(fresh)
    expect(vi.mocked(fetchMetadataXml)).toHaveBeenCalledTimes(2)
  })
})

describe('ConnectionPool.abortDownloads (#233)', () => {
  /** A download that hangs until its signal aborts, as fetchMetadataXml does. */
  const hang = () =>
    vi.mocked(fetchMetadataXml).mockImplementation(
      ({ signal }) =>
        new Promise((_, reject) => {
          if (signal?.aborted === true) reject(signal.reason)
          signal?.addEventListener('abort', () => reject(signal.reason))
        }),
    )

  it('aborts the $metadata download in flight; built entries stay, and a later get downloads anew', async () => {
    const p = pool()
    const built = await p.get('trade')
    write('config.json', {
      connections: {
        trade: { baseUrl: 'http://h/odata/standard.odata', login: 'u', serverTimezone: 'Europe/Moscow' },
        other: { baseUrl: 'http://h3/odata/standard.odata', login: 'u', serverTimezone: 'Europe/Moscow' },
      },
    })
    write('credentials.json', { trade: 'pw', other: 'pw' })
    hang()
    const pending = p.get('other')
    await vi.waitFor(() => expect(vi.mocked(fetchMetadataXml)).toHaveBeenCalledTimes(2))
    p.abortDownloads()
    await expect(pending).rejects.toThrow()
    await expect(p.get('trade')).resolves.toBe(built)
    vi.mocked(fetchMetadataXml).mockReset().mockResolvedValue('<edmx/>')
    await expect(p.get('other')).resolves.toBeDefined()
    expect(vi.mocked(fetchMetadataXml)).toHaveBeenCalledTimes(1)
  })

  it('drops a build still reading its source: it fails, and the next get builds anew', async () => {
    const source = new FileConnectionSource({ dataDir: dir, insecure: true })
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const getSecret = source.getSecret.bind(source)
    vi.spyOn(source, 'getSecret').mockImplementationOnce(async (name) => {
      await gate
      return getSecret(name)
    })
    const p = new ConnectionPool(source)
    const stale = p.get('trade')
    await vi.waitFor(() => expect(source.getSecret).toHaveBeenCalledTimes(1))
    p.abortDownloads()
    const fresh = p.get('trade')
    release()
    await expect(stale).rejects.toThrow()
    await expect(fresh).resolves.toBeDefined()
    expect(vi.mocked(fetchMetadataXml)).toHaveBeenCalledTimes(1)
  })
})

describe('ConnectionPool.list', () => {
  it('lists connections sorted by name with their password source and loaded flag', async () => {
    const p = pool()
    await p.get('trade') // mark loaded
    const list = await p.list()
    expect(list.map((c) => c.name)).toEqual(['nopw', 'trade'])
    const trade = list.find((c) => c.name === 'trade')
    expect(trade).toMatchObject({ baseUrl: 'http://h/odata/standard.odata', passwordSource: 'file', loaded: true })
    expect(list.find((c) => c.name === 'nopw')).toMatchObject({ passwordSource: 'none', loaded: false })
  })

  it('reports the stored label, falling back to the name when none is set', async () => {
    write('config.json', {
      connections: {
        labelled: { baseUrl: 'http://h/odata', login: 'u', serverTimezone: 'Europe/Moscow', label: 'Торговля' },
        plain: { baseUrl: 'http://h/odata', login: 'u', serverTimezone: 'Europe/Moscow' },
      },
    })
    const list = await pool().list()
    expect(list.find((c) => c.name === 'labelled')?.label).toBe('Торговля')
    expect(list.find((c) => c.name === 'plain')?.label).toBe('plain')
  })
})
