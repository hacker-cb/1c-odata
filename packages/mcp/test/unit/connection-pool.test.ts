import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EdmxModel } from '@1c-odata/metadata'
import { buildMetadataIndex, fetchMetadataXml, parseEdmx } from '@1c-odata/metadata'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectionPool } from '../../src/connection-pool.js'

// Stub the network + parse + index build so get() never touches a real base;
// keep @1c-odata/client real except the client ctor (InvalidArgumentError, used
// by the pool's error paths, must stay genuine).
vi.mock('@1c-odata/metadata', () => ({
  fetchMetadataXml: vi.fn(),
  parseEdmx: vi.fn(),
  buildMetadataIndex: vi.fn(),
}))
vi.mock('@1c-odata/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@1c-odata/client')>()),
  ODataV3Client: vi.fn(),
}))

let dir: string
const write = (file: string, body: unknown) => writeFileSync(join(dir, file), JSON.stringify(body), { mode: 0o600 })

beforeEach(() => {
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
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const pool = () => new ConnectionPool({ dataDir: dir, insecure: true })

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
