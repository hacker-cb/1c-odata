import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HTTPError, ODataError } from '@1c-odata/client'
import * as metadata from '@1c-odata/metadata'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { runFetch } from '../../src/commands/fetch.js'
import { rejection } from './_helpers.js'

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
  it('writes <metadataDir>/<target>.xml for each target', async () => {
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
        targets: {
          x: {
            connection: {
              baseUrl: 'http://example.test/odata',
              auth: { username: 'u', password: 'p' },
              serverTimezone: 'Europe/Moscow',
            },
          },
          y: {
            connection: {
              baseUrl: 'http://other.test/odata',
              auth: { username: 'u2', password: 'p2' },
              serverTimezone: 'Europe/Moscow',
            },
          },
        },
      },
    })
    expect(readFileSync(join(tmp, 'metadata/x.xml'), 'utf8')).toBe('<edmx:Edmx>X</edmx:Edmx>')
    expect(readFileSync(join(tmp, 'metadata/y.xml'), 'utf8')).toBe('<edmx:Edmx>Y</edmx:Edmx>')
  })

  it('filters to a single target when "target" option is set', async () => {
    let xCalled = 0
    let yCalled = 0
    server.use(
      http.get('http://example.test/odata/$metadata', () => {
        xCalled++
        return HttpResponse.text('<edmx:Edmx>X</edmx:Edmx>', { status: 200 })
      }),
      http.get('http://other.test/odata/$metadata', () => {
        yCalled++
        return HttpResponse.text('<edmx:Edmx>Y</edmx:Edmx>', { status: 200 })
      }),
    )
    await runFetch({
      cwd: tmp,
      target: 'x',
      config: {
        targets: {
          x: {
            connection: {
              baseUrl: 'http://example.test/odata',
              auth: { username: 'u', password: 'p' },
              serverTimezone: 'Europe/Moscow',
            },
          },
          y: {
            connection: {
              baseUrl: 'http://other.test/odata',
              auth: { username: 'u2', password: 'p2' },
              serverTimezone: 'Europe/Moscow',
            },
          },
        },
      },
    })
    expect(xCalled).toBe(1)
    expect(yCalled).toBe(0)
  })

  it('throws when filter names an unknown target', async () => {
    await expect(
      runFetch({
        cwd: tmp,
        target: 'nope',
        config: {
          targets: {
            x: {
              connection: {
                baseUrl: 'http://example.test/odata',
                auth: { username: 'u', password: 'p' },
                serverTimezone: 'Europe/Moscow',
              },
            },
          },
        },
      }),
    ).rejects.toThrow(/target "nope" not found/i)
  })

  it('wraps HTTP errors with the target name', async () => {
    server.use(
      http.get('http://example.test/odata/$metadata', () => HttpResponse.text('Server Error', { status: 500 })),
    )
    await expect(
      runFetch({
        cwd: tmp,
        config: {
          targets: {
            x: {
              connection: {
                baseUrl: 'http://example.test/odata',
                auth: { username: 'u', password: 'p' },
                serverTimezone: 'Europe/Moscow',
              },
            },
          },
        },
      }),
    ).rejects.toThrow(/target "x".*500/i)
  })

  it('attempts every target even when one fails (best-effort)', async () => {
    // x fails (500), y succeeds. Best-effort: y must still be written even
    // though x failed, and the thrown error names the failing target.
    server.use(
      http.get('http://example.test/odata/$metadata', () => HttpResponse.text('Server Error', { status: 500 })),
      http.get('http://other.test/odata/$metadata', () =>
        HttpResponse.text('<edmx:Edmx>Y</edmx:Edmx>', { status: 200 }),
      ),
    )
    const err = await rejection(
      runFetch({
        cwd: tmp,
        config: {
          metadataDir: './metadata',
          targets: {
            x: {
              connection: {
                baseUrl: 'http://example.test/odata',
                auth: { username: 'u', password: 'p' },
                serverTimezone: 'Europe/Moscow',
              },
            },
            y: {
              connection: {
                baseUrl: 'http://other.test/odata',
                auth: { username: 'u2', password: 'p2' },
                serverTimezone: 'Europe/Moscow',
              },
            },
          },
        },
      }),
    )
    expect(err.message).toMatch(/target "x".*500/i)
    // y was still fetched despite x failing (best-effort, not fail-fast).
    expect(readFileSync(join(tmp, 'metadata/y.xml'), 'utf8')).toBe('<edmx:Edmx>Y</edmx:Edmx>')
  })

  it('downloads targets concurrently rather than serially', async () => {
    // Hold x's response until y's request lands — only possible if the two
    // downloads overlap. A serial loop would await x before issuing y, so this
    // would deadlock (and time out) instead of passing.
    let releaseX: (() => void) | undefined
    const xHeld = new Promise<void>((resolve) => {
      releaseX = resolve
    })
    let yRequested = false
    server.use(
      http.get('http://example.test/odata/$metadata', async () => {
        await xHeld
        return HttpResponse.text('<edmx:Edmx>X</edmx:Edmx>', { status: 200 })
      }),
      http.get('http://other.test/odata/$metadata', () => {
        yRequested = true
        releaseX?.()
        return HttpResponse.text('<edmx:Edmx>Y</edmx:Edmx>', { status: 200 })
      }),
    )
    await runFetch({
      cwd: tmp,
      config: {
        targets: {
          x: {
            connection: {
              baseUrl: 'http://example.test/odata',
              auth: { username: 'u', password: 'p' },
              serverTimezone: 'Europe/Moscow',
            },
          },
          y: {
            connection: {
              baseUrl: 'http://other.test/odata',
              auth: { username: 'u2', password: 'p2' },
              serverTimezone: 'Europe/Moscow',
            },
          },
        },
      },
    })
    expect(yRequested).toBe(true)
    expect(readFileSync(join(tmp, 'metadata/x.xml'), 'utf8')).toBe('<edmx:Edmx>X</edmx:Edmx>')
    expect(readFileSync(join(tmp, 'metadata/y.xml'), 'utf8')).toBe('<edmx:Edmx>Y</edmx:Edmx>')
  })

  it('rethrows the first failure in target order when multiple targets fail', async () => {
    // x (first) → 500, y (second) → 503. Both fail, but the surfaced error must
    // be x's (lowest target index), not whichever download settled first.
    let yRequested = false
    server.use(
      http.get('http://example.test/odata/$metadata', () => HttpResponse.text('boom', { status: 500 })),
      http.get('http://other.test/odata/$metadata', () => {
        yRequested = true
        return HttpResponse.text('boom', { status: 503 })
      }),
    )
    const err = await rejection(
      runFetch({
        cwd: tmp,
        config: {
          targets: {
            x: {
              connection: {
                baseUrl: 'http://example.test/odata',
                auth: { username: 'u', password: 'p' },
                serverTimezone: 'Europe/Moscow',
              },
            },
            y: {
              connection: {
                baseUrl: 'http://other.test/odata',
                auth: { username: 'u2', password: 'p2' },
                serverTimezone: 'Europe/Moscow',
              },
            },
          },
        },
      }),
    )
    expect(err.message).toMatch(/target "x".*500/i)
    expect(err.message).not.toMatch(/503/) // y's later failure must not mask x's
    expect(yRequested).toBe(true) // y still attempted despite x failing
  })

  it('preserves typed-error identity when prepending the target name (STABILITY.md contract)', async () => {
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
    const err = await rejection(
      runFetch({
        cwd: tmp,
        config: {
          targets: {
            x: {
              connection: {
                baseUrl: 'http://example.test/odata',
                auth: { username: 'u', password: 'p' },
                serverTimezone: 'Europe/Moscow',
              },
            },
          },
        },
      }),
    )
    expect(err).toBeInstanceOf(HTTPError)
    expect(err).toBeInstanceOf(ODataError)
    expect(err.message).toMatch(/target "x"/)
    expect((err as HTTPError).status).toBe(400)
  })

  it('passes per-target fetchTimeout to fetchMetadataXml (override beats config default)', async () => {
    const spy = vi.spyOn(metadata, 'fetchMetadataXml').mockResolvedValueOnce('<edmx:Edmx/>')
    await runFetch({
      cwd: tmp,
      config: {
        fetchTimeout: 10_000,
        targets: {
          x: {
            connection: {
              baseUrl: 'http://example.test/odata',
              auth: { username: 'u', password: 'p' },
              serverTimezone: 'Europe/Moscow',
            },
            fetchTimeout: 60_000,
          },
        },
      },
    })
    expect(spy).toHaveBeenCalledOnce()
    expect(spy.mock.calls[0]?.[0]?.timeout).toBe(60_000)
    spy.mockRestore()
  })

  it('falls back to config-level fetchTimeout when no per-target override is set', async () => {
    const spy = vi.spyOn(metadata, 'fetchMetadataXml').mockResolvedValueOnce('<edmx:Edmx/>')
    await runFetch({
      cwd: tmp,
      config: {
        fetchTimeout: 10_000,
        targets: {
          x: {
            connection: {
              baseUrl: 'http://example.test/odata',
              auth: { username: 'u', password: 'p' },
              serverTimezone: 'Europe/Moscow',
            },
          },
        },
      },
    })
    expect(spy.mock.calls[0]?.[0]?.timeout).toBe(10_000)
    spy.mockRestore()
  })
})
