import type { EdmxModel } from '@1c-odata/metadata'
import { buildMetadataIndex, fetchMetadataXml, parseEdmx } from '@1c-odata/metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredConnection } from '../../src/config.js'
import { ConnectionPool, type ReadPool } from '../../src/connection-pool.js'
import type { ConnectionSource, ListedConnection } from '../../src/connection-source.js'
import type { SecretSource } from '../../src/secret-store.js'

// The point of the ConnectionSource seam (plan §3.2/3.3): ConnectionPool must
// resolve connections from ANY source, not just config.json + keychain, so
// a multi-tenant host can back it with a DB. Prove it with a pure in-memory
// source — no filesystem, no SecretStore.
vi.mock('@1c-odata/metadata', () => ({
  fetchMetadataXml: vi.fn(),
  parseEdmx: vi.fn(),
  buildMetadataIndex: vi.fn(),
}))
vi.mock('@1c-odata/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@1c-odata/client')>()),
  ODataV3Client: vi.fn(),
}))

/** A minimal in-memory {@link ConnectionSource} — a DB-backed source stand-in. */
class MemorySource implements ConnectionSource {
  readonly secretReads: string[] = []
  constructor(
    private readonly bases: Record<string, StoredConnection>,
    private readonly secrets: Record<string, string>,
  ) {}

  async getBase(name: string): Promise<StoredConnection | undefined> {
    return this.bases[name]
  }
  async listBases(): Promise<ListedConnection[]> {
    // Deliberately unsorted — the pool is responsible for stable ordering.
    return Object.entries(this.bases).map(([name, c]) => ({ name, ...c }))
  }
  async getSecret(name: string): Promise<string | null> {
    this.secretReads.push(name)
    return this.secrets[name] ?? null
  }
  async secretSource(name: string): Promise<SecretSource> {
    return name in this.secrets ? 'file' : 'none'
  }
}

const conn = (baseUrl: string): StoredConnection => ({ baseUrl, login: 'u', serverTimezone: 'Europe/Moscow' })

beforeEach(() => {
  vi.mocked(fetchMetadataXml).mockReset().mockResolvedValue('<edmx/>')
  vi.mocked(parseEdmx)
    .mockReset()
    .mockReturnValue({} as unknown as EdmxModel)
  vi.mocked(buildMetadataIndex)
    .mockReset()
    .mockReturnValue({ entitySetToType: {}, schemas: {} } as never)
})

describe('ConnectionPool over a custom ConnectionSource', () => {
  it('resolves a base from the source and caches it', async () => {
    const source = new MemorySource({ b: conn('http://h/odata/standard.odata') }, { b: 'pw' })
    const pool = new ConnectionPool(source)
    const entry = await pool.get('b')
    expect(entry.name).toBe('b')
    expect(entry.connection.baseUrl).toBe('http://h/odata/standard.odata')
    await pool.get('b')
    expect(vi.mocked(fetchMetadataXml)).toHaveBeenCalledTimes(1) // cached
  })

  it('is a ReadPool', () => {
    // Compile-time guarantee that the concrete pool satisfies the interface the
    // tool registrators (and an alternate host's scoping wrapper) depend on.
    const pool: ReadPool = new ConnectionPool(new MemorySource({}, {}))
    expect(typeof pool.get).toBe('function')
  })

  it('lists summaries sorted by name with the source-reported secret source', async () => {
    const source = new MemorySource({ zeta: conn('http://z/odata'), alpha: conn('http://a/odata') }, { alpha: 'pw' })
    const pool = new ConnectionPool(source)
    await pool.get('alpha') // mark loaded
    const list = await pool.list()
    expect(list.map((c) => c.name)).toEqual(['alpha', 'zeta']) // pool sorts an unsorted source
    expect(list.find((c) => c.name === 'alpha')).toMatchObject({ passwordSource: 'file', loaded: true })
    expect(list.find((c) => c.name === 'zeta')).toMatchObject({ passwordSource: 'none', loaded: false })
  })

  it('falls back to the name when the source reports no label', async () => {
    const source = new MemorySource({ plain: conn('http://h/odata') }, {})
    const [summary] = await new ConnectionPool(source).list()
    expect(summary?.label).toBe('plain')
  })

  it('rejects an unknown base without reading a secret', async () => {
    const source = new MemorySource({}, {})
    await expect(new ConnectionPool(source).get('nope')).rejects.toThrow(/No connection named "nope"/)
    expect(source.secretReads).toEqual([])
  })

  it('rejects a base whose source yields no secret', async () => {
    const source = new MemorySource({ b: conn('http://h/odata') }, {})
    await expect(new ConnectionPool(source).get('b')).rejects.toThrow(/No password for "b"/)
    expect(vi.mocked(fetchMetadataXml)).not.toHaveBeenCalled()
  })

  it('appends the source-supplied remediation hint to the no-secret error', async () => {
    const source = new MemorySource({ b: conn('http://h/odata') }, {})
    // Attach an optional hint the way FileConnectionSource does.
    ;(source as ConnectionSource).missingSecretHint = (name) => `do X for ${name}`
    await expect(new ConnectionPool(source).get('b')).rejects.toThrow('No password for "b". do X for b')
  })
})
