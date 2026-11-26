import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serveStdio } from '../../src/server.js'

const EDMX = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
  <edmx:DataServices m:DataServiceVersion="3.0" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
    <Schema Namespace="StandardODATA" xmlns="http://schemas.microsoft.com/ado/2009/11/edm">
      <EntityType Name="Catalog_Валюты">
        <Key><PropertyRef Name="Ref_Key"/></Key>
        <Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/>
        <Property Name="Description" Type="Edm.String" Nullable="false"/>
      </EntityType>
      <EntityContainer Name="StandardODATA" m:IsDefaultEntityContainer="true">
        <EntitySet Name="Catalog_Валюты" EntityType="StandardODATA.Catalog_Валюты"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`

/** One request the stubbed 1С received, and whether its signal aborted while it hung. */
interface Hit {
  url: string
  aborted: boolean
}

/**
 * Stub `fetch` as a 1С that answers `$metadata` with {@link EDMX} where
 * `metadata` is `'answer'`, and leaves every other request hanging until its
 * signal aborts (or 5 s pass). `arrived` resolves at the first hanging request.
 */
function oneC(metadata: 'answer' | 'hang') {
  const hits: Hit[] = []
  let arrivedResolve: (hit: Hit) => void = () => {}
  const arrived = new Promise<Hit>((r) => {
    arrivedResolve = r
  })
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    const hit: Hit = { url: decodeURIComponent(String(url)), aborted: false }
    hits.push(hit)
    if (metadata === 'answer' && hit.url.endsWith('/$metadata')) {
      return new Response(EDMX, { headers: { 'content-type': 'application/xml' } })
    }
    arrivedResolve(hit)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 5000)
      init?.signal?.addEventListener('abort', () => {
        hit.aborted = true
        clearTimeout(timer)
        reject(init.signal?.reason)
      })
    })
    return new Response(JSON.stringify({ value: [] }), { headers: { 'content-type': 'application/json' } })
  })
  return { hits, arrived }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-serve-'))
  const write = (file: string, body: unknown) => writeFileSync(join(dir, file), JSON.stringify(body), { mode: 0o600 })
  write('config.json', {
    connections: { c: { baseUrl: 'http://1c.test/odata/standard.odata', login: 'u', serverTimezone: 'Europe/Moscow' } },
  })
  write('credentials.json', { c: 'pw' })
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

/** `serveStdio` over in-memory streams, with a writer of JSON-RPC lines and a reader of the replies. */
function serve() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const replies: unknown[] = []
  let buffered = ''
  stdout.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8')
    let nl = buffered.indexOf('\n')
    while (nl >= 0) {
      replies.push(JSON.parse(buffered.slice(0, nl)))
      buffered = buffered.slice(nl + 1)
      nl = buffered.indexOf('\n')
    }
  })
  let ended = false
  const done = serveStdio({ dataDir: dir, insecure: true }, stdin, stdout).then(() => {
    ended = true
  })
  const send = (msg: Record<string, unknown>) => stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
  send({
    id: 0,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
  })
  send({ method: 'notifications/initialized' })
  return { stdin, send, done, replies, isEnded: () => ended }
}

const QUERY = {
  id: 1,
  method: 'tools/call',
  params: { name: 'query', arguments: { connection: 'c', entitySet: 'Catalog_Валюты' } },
}

describe('serve closes on the end of stdin (#233)', () => {
  it('resolves once stdin ends, with no call in flight', async () => {
    const s = serve()
    await vi.waitFor(() => expect(s.replies).toHaveLength(1)) // initialize answered
    s.stdin.end()
    await s.done
    expect(s.isEnded()).toBe(true)
  })

  it('resolves once stdin closes without an end', async () => {
    const s = serve()
    await vi.waitFor(() => expect(s.replies).toHaveLength(1))
    s.stdin.destroy()
    await s.done
  })

  it('aborts the page request to 1С of a call still running', async () => {
    const { arrived, hits } = oneC('answer')
    const s = serve()
    s.send(QUERY)
    const hit = await arrived
    expect(hit.url).toContain('Catalog_Валюты?')
    s.stdin.end()
    await s.done
    await vi.waitFor(() => expect(hit.aborted).toBe(true))
    expect(hits.filter((h) => !h.url.endsWith('/$metadata')).every((h) => h.aborted)).toBe(true)
    // The cancelled call answers nothing on a closed connection.
    expect(s.replies.some((r) => (r as { id?: number }).id === 1)).toBe(false)
  })

  it('aborts the $metadata download a call is waiting on', async () => {
    const { arrived } = oneC('hang')
    const s = serve()
    s.send(QUERY)
    const hit = await arrived
    expect(hit.url).toMatch(/\/\$metadata$/)
    s.stdin.end()
    await s.done
    await vi.waitFor(() => expect(hit.aborted).toBe(true))
  })
})
