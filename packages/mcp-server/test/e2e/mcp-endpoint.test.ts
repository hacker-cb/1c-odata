import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ConnectionPool, type ConnectionSource } from '@1c-odata/mcp/internal'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/http/app.js'
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

/**
 * A minimal REAL 1С OData stub on a loopback port: `$metadata` + one entity set.
 * We use a real server (not MSW) because the MCP client↔Express leg streams SSE,
 * and an in-process request interceptor mangles that stream — so this e2e keeps
 * every hop as genuine HTTP: MCP client → Express `/mcp` → this upstream stub.
 */
function startUpstream(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?', 1)[0]
    if (path === '/odata/$metadata') {
      res.writeHead(200, { 'Content-Type': 'application/xml' })
      res.end(MINI_EDMX)
      return
    }
    if (path === '/odata/Catalog_X') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ 'odata.metadata': 'm', value: [{ Ref_Key: 'a', Code: 'RUB' }] }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/odata` })
    })
  })
}

describe('e2e: MCP over Express /mcp', () => {
  let httpServer: Server
  let upstream: Server
  let baseUrl: URL
  let stopSessions: () => void

  beforeEach(async () => {
    const up = await startUpstream()
    upstream = up.server
    const source: ConnectionSource = {
      async getBase(name) {
        return name === 'demo' ? { baseUrl: up.baseUrl, login: 'u', serverTimezone: 'UTC' } : undefined
      },
      async listBases() {
        return [{ name: 'demo', baseUrl: up.baseUrl, login: 'u', serverTimezone: 'UTC' }]
      },
      async getSecret() {
        return 'p'
      },
      async secretSource() {
        return 'env'
      },
    }
    const pool = new ConnectionPool(source)
    const { app, sessions } = createApp({
      buildServer: () => buildMcpServer(pool, { version: '9.9.9', dataDir: '/synthetic' }),
    })
    stopSessions = () => sessions.stop()
    httpServer = app.listen(0)
    await new Promise<void>((r) => httpServer.once('listening', r))
    const { port } = httpServer.address() as AddressInfo
    baseUrl = new URL(`http://127.0.0.1:${port}/mcp`)
  })

  afterEach(async () => {
    stopSessions()
    await new Promise<void>((r) => httpServer.close(() => r()))
    await new Promise<void>((r) => upstream.close(() => r()))
  })

  it('initialize -> tools/list -> tools/call round-trips against the stub 1С base', async () => {
    const client = new Client({ name: 'e2e', version: '0' })
    const transport = new StreamableHTTPClientTransport(baseUrl)
    // Cast to Transport: SDK's client transport types `sessionId` as
    // `string | undefined`, tripping exactOptionalPropertyTypes (same upstream
    // quirk as the server transport in src/http/mcp-route.ts).
    await client.connect(transport as Transport) // performs the MCP initialize handshake

    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['query', 'get_entity', 'count', 'list_entities']))
    expect(names).not.toContain('add')

    const res = await client.callTool({
      name: 'query',
      arguments: { connection: 'demo', entitySet: 'Catalog_X' },
    })
    expect(res.isError).toBeFalsy()
    expect(JSON.stringify(res.structuredContent)).toContain('RUB')

    await client.close()
  })
})

describe('e2e: DNS-rebinding protection', () => {
  it('rejects a POST whose Host is not in allowedHosts', async () => {
    const source: ConnectionSource = {
      async getBase() {
        return undefined
      },
      async listBases() {
        return []
      },
      async getSecret() {
        return null
      },
      async secretSource() {
        return 'none'
      },
    }
    const pool = new ConnectionPool(source)
    const { app, sessions } = createApp({
      buildServer: () => buildMcpServer(pool, { version: '9.9.9', dataDir: '/synthetic' }),
      // Allowlist deliberately EXCLUDES the loopback host the request will carry.
      allowedHosts: ['allowed.example:1234'],
    })
    const server = app.listen(0)
    await new Promise<void>((r) => server.once('listening', r))
    const { port } = server.address() as AddressInfo
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
        }),
      })
      // The SDK's DNS-rebinding guard rejects the mismatched Host before any session opens.
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(res.headers.get('mcp-session-id')).toBeNull()
    } finally {
      sessions.stop()
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})
