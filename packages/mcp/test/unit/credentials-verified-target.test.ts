import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runSetCredentials } from '../../src/commands/set-credentials.js'
import { loadConfig, saveConfig } from '../../src/config.js'
import { ConnectionPool } from '../../src/connection-pool.js'
import { updateConnectionCredentials, upsertConnection } from '../../src/connections.js'
import { FileConnectionSource } from '../../src/file-connection-source.js'
import { registerManagementTools } from '../../src/tools/management.js'

// Isolate from the real OS keychain.
vi.mock('@napi-rs/keyring', () => ({
  Entry: class {
    getPassword(): string | null {
      return null
    }
    setPassword(): void {
      throw new Error('no keychain in tests')
    }
    deletePassword(): boolean {
      return false
    }
  },
}))

/**
 * #273: set_credentials / `set-credentials` verify a new password against the
 * connection as read BEFORE the lock. Another process may re-point the
 * connection while the verify is in flight; the password must then not be
 * stored for a target it was never checked on.
 */

const S = 'http://s.test/odata/standard.odata'
const T = 'http://t.test/odata/standard.odata'

let dir: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-verified-target-'))
  vi.stubEnv('ONEC_PROD_PASSWORD', '')
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  await upsertConnection({
    dataDir: dir,
    name: 'prod',
    baseUrl: S,
    login: 'u',
    serverTimezone: 'Europe/Moscow',
    password: 'old-secret',
    insecure: true,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

/**
 * Stub the 1С so its `$metadata` answers only once `release` is called;
 * `arrived` resolves when the verify request comes in.
 */
function heldOneC() {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let arrive!: (url: string) => void
  const arrived = new Promise<string>((resolve) => {
    arrive = resolve
  })
  vi.stubGlobal('fetch', async (url: string | URL) => {
    arrive(String(url))
    await gate
    return new Response('<edmx:Edmx/>', { headers: { 'content-type': 'application/xml' } })
  })
  return { arrived, release }
}

/** Another process re-points `prod` to `baseUrl`, as `add --force` there would. */
function repointElsewhere(baseUrl: string, login = 'u'): void {
  const config = loadConfig(dir)
  const prod = config.connections.prod
  if (prod === undefined) throw new Error('prod missing')
  config.connections.prod = { ...prod, baseUrl, login }
  saveConfig(dir, config)
}

const secret = () => new FileConnectionSource({ dataDir: dir, insecure: true }).getSecret('prod')

describe('a credential change verified on one target is not stored for another (#273)', () => {
  it('CLI set-credentials: refused where the connection was re-pointed during the verify', async () => {
    const oneC = heldOneC()
    const run = runSetCredentials({ dataDir: dir, name: 'prod', password: 'new-secret', insecure: true })
    expect(await oneC.arrived).toContain('s.test')
    repointElsewhere(T)
    oneC.release()
    await expect(run).rejects.toThrow(/changed while its credentials were being verified.*t\.test.*Nothing was changed/)
    expect(await secret()).toBe('old-secret')
    expect(loadConfig(dir).connections.prod?.baseUrl).toBe(T)
  })

  it('MCP set_credentials: refused where the connection was re-pointed during the verify', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' })
    const pool = new ConnectionPool(new FileConnectionSource({ dataDir: dir, insecure: true }))
    registerManagementTools(server, pool, { dataDir: dir, insecure: true })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    const mcp = new Client({ name: 'test-client', version: '0.0.0' })
    await Promise.all([server.connect(serverSide), mcp.connect(clientSide)])

    const oneC = heldOneC()
    const call = mcp.callTool({ name: 'set_credentials', arguments: { connection: 'prod', password: 'new-secret' } })
    expect(await oneC.arrived).toContain('s.test')
    repointElsewhere(T)
    oneC.release()
    const result = await call
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/changed while its credentials were being verified/)
    expect(await secret()).toBe('old-secret')
    await mcp.close()
  })

  it('a re-pointed login counts as another target too', async () => {
    const oneC = heldOneC()
    const run = runSetCredentials({ dataDir: dir, name: 'prod', password: 'new-secret', insecure: true })
    await oneC.arrived
    repointElsewhere(S, 'someone-else')
    oneC.release()
    await expect(run).rejects.toThrow(/changed while its credentials were being verified/)
    expect(await secret()).toBe('old-secret')
  })

  it('stores the change where the connection still points where it was verified', async () => {
    const oneC = heldOneC()
    const run = runSetCredentials({ dataDir: dir, name: 'prod', password: 'new-secret', insecure: true })
    await oneC.arrived
    oneC.release()
    await run
    expect(await secret()).toBe('new-secret')
  })

  it('the target compares as stored: a trailing slash or padded login is the same target', async () => {
    await expect(
      updateConnectionCredentials({
        dataDir: dir,
        name: 'prod',
        password: 'new-secret',
        insecure: true,
        verifiedTarget: { baseUrl: `${S}/`, login: ' u ' },
      }),
    ).resolves.toMatchObject({ passwordUpdated: true })
    expect(await secret()).toBe('new-secret')
  })
})
