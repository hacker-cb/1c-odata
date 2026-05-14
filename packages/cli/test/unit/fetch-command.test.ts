import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HTTPError, ODataError } from '@1c-odata/client'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { runFetch } from '../../src/commands/fetch.js'
import * as fetcher from '../../src/fetcher.js'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), '1c-odata-fetch-cmd-'))
  server.resetHandlers()
})
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

describe('runFetch', () => {
  it('writes <metadataDir>/<connection>.xml for each connection', async () => {
    server.use(
      http.get('http://example.test/odata/$metadata', () =>
        HttpResponse.text('<edmx:Edmx>X</edmx:Edmx>', { status: 200 }),
      ),
      http.get('http://other.test/odata/$metadata', () =>
        HttpResponse.text('<edmx:Edmx>Y</edmx:Edmx>', { status: 200 }),
      ),
    )
    await runFetch({
      cwd: tmp,
      config: {
        metadataDir: './metadata',
        fetchTimeout: 30_000,
        connections: {
          x: {
            baseUrl: 'http://example.test/odata',
            auth: { username: 'u', password: 'p' },
            serverTimezone: 'Europe/Moscow',
          },
          y: {
            baseUrl: 'http://other.test/odata',
            auth: { username: 'u2', password: 'p2' },
            serverTimezone: 'Europe/Moscow',
          },
        },
      },
    })
    expect(readFileSync(join(tmp, 'metadata/x.xml'), 'utf8')).toBe('<edmx:Edmx>X</edmx:Edmx>')
    expect(readFileSync(join(tmp, 'metadata/y.xml'), 'utf8')).toBe('<edmx:Edmx>Y</edmx:Edmx>')
  })

  it('filters to a single connection when "connection" option is set', async () => {
    let xCalled = 0
    let yCalled = 0
    server.use(
      http.get('http://example.test/odata/$metadata', () => {
        xCalled++
        return HttpResponse.text('X', { status: 200 })
      }),
      http.get('http://other.test/odata/$metadata', () => {
        yCalled++
        return HttpResponse.text('Y', { status: 200 })
      }),
    )
    await runFetch({
      cwd: tmp,
      connection: 'x',
      config: {
        connections: {
          x: {
            baseUrl: 'http://example.test/odata',
            auth: { username: 'u', password: 'p' },
            serverTimezone: 'Europe/Moscow',
          },
          y: {
            baseUrl: 'http://other.test/odata',
            auth: { username: 'u2', password: 'p2' },
            serverTimezone: 'Europe/Moscow',
          },
        },
      },
    })
    expect(xCalled).toBe(1)
    expect(yCalled).toBe(0)
  })

  it('throws when filter targets an unknown connection', async () => {
    await expect(
      runFetch({
        cwd: tmp,
        connection: 'nope',
        config: {
          connections: {
            x: {
              baseUrl: 'http://example.test/odata',
              auth: { username: 'u', password: 'p' },
              serverTimezone: 'Europe/Moscow',
            },
          },
        },
      }),
    ).rejects.toThrow(/connection "nope" not found/i)
  })

  it('wraps HTTP errors with the connection name', async () => {
    server.use(
      http.get('http://example.test/odata/$metadata', () => HttpResponse.text('Server Error', { status: 500 })),
    )
    await expect(
      runFetch({
        cwd: tmp,
        config: {
          connections: {
            x: {
              baseUrl: 'http://example.test/odata',
              auth: { username: 'u', password: 'p' },
              serverTimezone: 'Europe/Moscow',
            },
          },
        },
      }),
    ).rejects.toThrow(/connection "x".*500/i)
  })

  it('preserves typed-error identity when prepending the connection name (STABILITY.md contract)', async () => {
    // Real 1С error shape: status 4xx/5xx + JSON `odata.error` body — that's
    // what triggers `mapResponseToError` to produce a typed `HTTPError` rather
    // than a `ParseError` fallback. Use 400 here so the `code: '0'` doesn't
    // collide with the 500+code='-1' BusinessError dispatch.
    server.use(
      http.get('http://example.test/odata/$metadata', () =>
        HttpResponse.json(
          { 'odata.error': { code: '0', message: { value: 'Bad Request' } } },
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )
    const err = await runFetch({
      cwd: tmp,
      config: {
        connections: {
          x: {
            baseUrl: 'http://example.test/odata',
            auth: { username: 'u', password: 'p' },
            serverTimezone: 'Europe/Moscow',
          },
        },
      },
    }).catch((e) => e as Error)
    expect(err).toBeInstanceOf(HTTPError)
    expect(err).toBeInstanceOf(ODataError)
    expect(err.message).toMatch(/connection "x"/)
    expect((err as HTTPError).status).toBe(400)
  })

  it('passes per-connection fetchTimeout to fetcher (override beats config default)', async () => {
    const spy = vi.spyOn(fetcher, 'fetchMetadata').mockResolvedValueOnce('<edmx:Edmx/>')
    await runFetch({
      cwd: tmp,
      config: {
        fetchTimeout: 10_000,
        connections: {
          x: {
            baseUrl: 'http://example.test/odata',
            auth: { username: 'u', password: 'p' },
            serverTimezone: 'Europe/Moscow',
            fetchTimeout: 60_000,
          },
        },
      },
    })
    expect(spy).toHaveBeenCalledOnce()
    expect(spy.mock.calls[0]?.[0]?.timeout).toBe(60_000)
    spy.mockRestore()
  })

  it('falls back to config-level fetchTimeout when no per-connection override is set', async () => {
    const spy = vi.spyOn(fetcher, 'fetchMetadata').mockResolvedValueOnce('<edmx:Edmx/>')
    await runFetch({
      cwd: tmp,
      config: {
        fetchTimeout: 10_000,
        connections: {
          x: {
            baseUrl: 'http://example.test/odata',
            auth: { username: 'u', password: 'p' },
            serverTimezone: 'Europe/Moscow',
          },
        },
      },
    })
    expect(spy.mock.calls[0]?.[0]?.timeout).toBe(10_000)
    spy.mockRestore()
  })
})
