import { ConnectionPool, type ConnectionSource, type PoolEntry, type ReadPool } from '@1c-odata/mcp/internal'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildMcpServer } from '../../src/server-factory.js'

const MINI_EDMX = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
  <edmx:DataServices m:DataServiceVersion="3.0" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
    <Schema Namespace="StandardODATA" xmlns="http://schemas.microsoft.com/ado/2009/11/edm">
      <EntityType Name="Catalog_X">
        <Key><PropertyRef Name="Ref_Key"/></Key>
        <Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/>
        <Property Name="Code" Type="Edm.String" Nullable="false" MaxLength="3"/>
      </EntityType>
      <EntityContainer Name="StandardODATA" m:IsDefaultEntityContainer="true">
        <EntitySet Name="Catalog_X" EntityType="StandardODATA.Catalog_X"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`

const upstream = setupServer()
beforeAll(() => upstream.listen({ onUnhandledRequest: 'error' }))
afterAll(() => upstream.close())
beforeEach(() => upstream.resetHandlers())

// A ConnectionSource with exactly one base at http://example.test/odata.
const source: ConnectionSource = {
  async getBase(name) {
    return name === 'demo' ? { baseUrl: 'http://example.test/odata', login: 'u', serverTimezone: 'UTC' } : undefined
  },
  async listBases() {
    return [{ name: 'demo', baseUrl: 'http://example.test/odata', login: 'u', serverTimezone: 'UTC' }]
  },
  async getSecret() {
    return 'p'
  },
  async secretSource() {
    return 'env'
  },
}

/** Wrap a real pool but allow only whitelisted names — the per-session scoping seam. */
function scopedPool(inner: ReadPool, allowed: Set<string>): ReadPool {
  return {
    async get(name): Promise<PoolEntry> {
      if (!allowed.has(name)) throw new Error(`forbidden: ${name}`)
      return inner.get(name)
    },
    async list() {
      return (await inner.list()).filter((c) => allowed.has(c.name))
    },
    refresh(name) {
      inner.refresh(name)
    },
  }
}

async function connectClient(pool: ReadPool): Promise<Client> {
  const server = buildMcpServer(pool, { version: '9.9.9', dataDir: '/synthetic' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

describe('buildMcpServer', () => {
  it('registers the read surface and omits management tools', async () => {
    const client = await connectClient(new ConnectionPool(source))
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toEqual(
      expect.arrayContaining(['query', 'get_entity', 'count', 'list_entities', 'describe_entity', 'server_info']),
    )
    expect(names).not.toContain('add')
    expect(names).not.toContain('set_credentials')
    await client.close()
  })

  it('list_entities resolves for the in-scope base (one $metadata fetch)', async () => {
    let metadataHits = 0
    upstream.use(
      http.get('http://example.test/odata/$metadata', () => {
        metadataHits += 1
        return HttpResponse.text(MINI_EDMX, { headers: { 'Content-Type': 'application/xml' } })
      }),
    )
    const pool = scopedPool(new ConnectionPool(source), new Set(['demo']))
    const client = await connectClient(pool)
    const res = await client.callTool({ name: 'list_entities', arguments: { connection: 'demo' } })
    expect(res.isError).toBeFalsy()
    expect(JSON.stringify(res.structuredContent)).toContain('Catalog_X')
    expect(metadataHits).toBe(1)
    await client.close()
  })

  it('denies an out-of-scope connection', async () => {
    const pool = scopedPool(new ConnectionPool(source), new Set(['demo']))
    const client = await connectClient(pool)
    const res = await client.callTool({ name: 'list_entities', arguments: { connection: 'nope' } })
    expect(res.isError).toBe(true)
    await client.close()
  })

  it("tenancy server_info redacts the host dataDir and counts the CALLER's visible bases", async () => {
    // A zero-grant scoped pool: server_info must report 0 connections and MUST NOT
    // leak the operator's on-disk dataDir to the tenant.
    const emptyPool = scopedPool(new ConnectionPool(source), new Set())
    const server = buildMcpServer(emptyPool, {
      version: '9.9.9',
      dataDir: '/host/secret/data-dir',
      serverInfo: 'tenancy',
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '0' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    try {
      const res = await client.callTool({ name: 'server_info', arguments: {} })
      const payload = JSON.stringify(res)
      expect(res.isError).toBeFalsy()
      expect(payload).not.toContain('/host/secret/data-dir')
      expect(payload).not.toContain('dataDir')
      expect(res.structuredContent).toMatchObject({ name: '1c-odata', version: '9.9.9', connections: 0 })
    } finally {
      await client.close()
    }
  })
})
