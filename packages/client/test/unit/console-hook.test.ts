import { consoleHook, HTTPError, type RequestEvent, type ResponseEvent } from '@1c-odata/client'
import { describe, expect, it, vi } from 'vitest'

describe('consoleHook', () => {
  it('logs request line on beforeRequest', async () => {
    const out: string[] = []
    const writeFn = vi.fn((s: string) => {
      out.push(s)
    })
    const hooks = consoleHook({ writeFn })
    const req: RequestEvent = { method: 'GET', url: 'http://x/Catalog_X?$top=10', headers: {} }
    await hooks.beforeRequest!(req)
    expect(out.join('')).toContain('→ GET')
    expect(out.join('')).toContain('Catalog_X')
  })

  it('logs status + duration on afterResponse', async () => {
    const out: string[] = []
    const writeFn = vi.fn((s: string) => {
      out.push(s)
    })
    const hooks = consoleHook({ writeFn })
    const req: RequestEvent = { method: 'GET', url: 'http://x/Catalog_X', headers: {} }
    const res: ResponseEvent = { status: 200, statusText: 'OK', headers: {}, body: '{"value":[]}', durationMs: 127 }
    await hooks.afterResponse!(req, res)
    expect(out.join('')).toContain('← 200')
    expect(out.join('')).toContain('127ms')
  })

  it('truncates body to maxBodyChars', async () => {
    const out: string[] = []
    const writeFn = vi.fn((s: string) => {
      out.push(s)
    })
    const hooks = consoleHook({ logBodies: true, maxBodyChars: 10, writeFn })
    const req: RequestEvent = { method: 'POST', url: 'http://x/Catalog_X', headers: {}, body: '{"a":"verylongbody"}' }
    await hooks.beforeRequest!(req)
    expect(out.some((l) => l.includes('verylongbody'))).toBe(false)
    expect(out.some((l) => l.includes('…'))).toBe(true)
  })

  it('logs error class and code on onError', async () => {
    const out: string[] = []
    const writeFn = vi.fn((s: string) => {
      out.push(s)
    })
    const hooks = consoleHook({ writeFn })
    const req: RequestEvent = { method: 'GET', url: 'http://x/Catalog_X', headers: {} }
    const err = new HTTPError('HTTP 500 Internal Server Error: X', {
      status: 500,
      statusText: 'Internal Server Error',
      code: '-1',
      errorFormat: 'json',
      body: { code: '-1', message: 'X' },
    })
    await hooks.onError!(req, err)
    expect(out.join('')).toContain('HTTPError')
    expect(out.join('')).toContain('-1')
  })
})
