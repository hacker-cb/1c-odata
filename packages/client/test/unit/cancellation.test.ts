import { BasicAuth, ODataV3Client, type RetryPolicy } from '@1c-odata/client'
import { HttpResponse, http } from 'msw'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { requestWithRetry } from '../../src/http/retry.js'
import { createMswServer } from '../fixtures/msw-server.js'

const server = createMswServer()

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const base = 'http://1c.test/odata/standard.odata'
const auth = BasicAuth({ username: 'u', password: 'p' })
const GUID = '11111111-2222-3333-4444-555555555555'

/** A handler that answers only once its request is aborted (or after 2 s) — and records that abort. */
function hanging(aborted: string[], name: string, answer: () => Response = () => HttpResponse.json({ value: [] })) {
  return async ({ request }: { request: Request }) => {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000)
      request.signal.addEventListener('abort', () => {
        aborted.push(name)
        clearTimeout(timer)
        resolve()
      })
    })
    return answer()
  }
}

describe('client.signal with a call of its own signal (#203)', () => {
  const calls: [string, (c: ODataV3Client, signal: AbortSignal) => Promise<unknown>][] = [
    ['query().get (transportGet)', (c, signal) => c.query('Catalog_X').get({ signal })],
    ['query().raw (transportFetch)', (c, signal) => c.query('Catalog_X').raw({ signal })],
    ['entity().create (transportWrite)', (c, signal) => c.entity('Catalog_X').create({ A: 1 }, { signal })],
    [
      'entity().readStream (transportStream)',
      (c, signal) => c.entity('Catalog_X', GUID).readStream('Файл', { signal }),
    ],
  ]

  it.each(calls)('%s: the client’s abort aborts it, with the client’s reason', async (_name, call) => {
    const aborted: string[] = []
    server.use(http.all(/\/Catalog_X/, hanging(aborted, 'req')))
    const clientCtrl = new AbortController()
    const client = new ODataV3Client({
      baseUrl: base,
      auth,
      serverTimezone: 'Europe/Moscow',
      signal: clientCtrl.signal,
    })
    const reason = new Error('service stopping')
    const pending = call(client, new AbortController().signal).catch((e: unknown) => e)
    setTimeout(() => clientCtrl.abort(reason), 20)
    expect(await pending).toBe(reason)
    expect(aborted).toEqual(['req'])
  })

  it.each(calls)('%s: its own abort still aborts it, with its reason', async (_name, call) => {
    server.use(http.all(/\/Catalog_X/, hanging([], 'req')))
    const client = new ODataV3Client({
      baseUrl: base,
      auth,
      serverTimezone: 'Europe/Moscow',
      signal: new AbortController().signal,
    })
    const callCtrl = new AbortController()
    const reason = new Error('caller gave up')
    const pending = call(client, callCtrl.signal).catch((e: unknown) => e)
    setTimeout(() => callCtrl.abort(reason), 20)
    expect(await pending).toBe(reason)
  })

  it('register().balance({ count: true }): the client’s abort aborts both the page and /$count', async () => {
    const aborted: string[] = []
    server.use(
      http.get(
        /\/AccumulationRegister_X\/Balance\(\)\/\$count/,
        hanging(aborted, 'count', () => HttpResponse.text('0')),
      ),
      http.get(
        /\/AccumulationRegister_X\/Balance\(\)(\?.*)?$/,
        hanging(aborted, 'page', () => HttpResponse.json({ 'odata.metadata': '#X', value: [] })),
      ),
    )
    const clientCtrl = new AbortController()
    const client = new ODataV3Client({
      baseUrl: base,
      auth,
      serverTimezone: 'Europe/Moscow',
      signal: clientCtrl.signal,
    })
    const reason = new Error('service stopping')
    const pending = client
      .register('AccumulationRegister_X')
      .balance({}, { count: true })
      .catch((e: unknown) => e)
    setTimeout(() => clientCtrl.abort(reason), 20)
    expect(await pending).toBe(reason)
    await new Promise((r) => setTimeout(r, 20))
    expect(aborted.sort()).toEqual(['count', 'page'])
  })
})

describe('requestWithRetry — the pause hears the abort (#203)', () => {
  // A pause far longer than any test: only the abort can end it.
  const policy: RetryPolicy = {
    maxRetries: 3,
    retryableStatuses: [503],
    retryableMethods: ['GET'],
    initialDelayMs: 60_000,
    maxDelayMs: 60_000,
    backoffMultiplier: 1,
    jitter: 'none',
  }
  const get = { method: 'GET' as const, url: `${base}/Catalog_X`, headers: { Authorization: auth.header } }
  const busy = () =>
    new HttpResponse('{"odata.error":{"code":"0","message":{"value":"busy"}}}', {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })

  it.each([
    ['the call’s signal', (signal: AbortSignal) => ({ config: { ...get, signal }, opts: {} })],
    ['the client’s signal', (signal: AbortSignal) => ({ config: get, opts: { signal } })],
  ])('an abort of %s during the pause ends the call at once, with no next attempt', async (_name, wire) => {
    let n = 0
    server.use(
      http.get(`${base}/Catalog_X`, () => {
        n++
        return busy()
      }),
    )
    const ctrl = new AbortController()
    const reason = new Error('cancelled')
    const beforeRequest = vi.fn()
    const onError = vi.fn(() => {
      // The first attempt has failed: the pause starts right after onError.
      setTimeout(() => ctrl.abort(reason), 10)
    })
    const { config, opts } = wire(ctrl.signal)
    const started = Date.now()
    const err = await requestWithRetry(config, { ...opts, retry: policy, hooks: { beforeRequest, onError } }).catch(
      (e: unknown) => e,
    )
    expect(err).toBe(reason)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(n).toBe(1)
    expect(beforeRequest).toHaveBeenCalledOnce()
  })

  it('the pause ends on the abort even where an earlier listener stops the event, and not on a forged one', async () => {
    let n = 0
    server.use(
      http.get(`${base}/Catalog_X`, () => {
        n++
        return busy()
      }),
    )
    const ctrl = new AbortController()
    ctrl.signal.addEventListener('abort', (ev) => ev.stopImmediatePropagation())
    const reason = new Error('cancelled')
    const onError = vi.fn(() => {
      setTimeout(() => ctrl.signal.dispatchEvent(new Event('abort')), 5)
      setTimeout(() => ctrl.abort(reason), 30)
    })
    const started = Date.now()
    const err = await requestWithRetry({ ...get, signal: ctrl.signal }, { retry: policy, hooks: { onError } }).catch(
      (e: unknown) => e,
    )
    expect(err).toBe(reason)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(n).toBe(1)
  })

  it('a signal aborted before the call never calls beforeRequest, and is not retried', async () => {
    const fetched = vi.fn(() => HttpResponse.json({ value: [] }))
    server.use(http.get(`${base}/Catalog_X`, fetched))
    const ctrl = new AbortController()
    const reason = new Error('already cancelled')
    ctrl.abort(reason)
    const beforeRequest = vi.fn()
    const onError = vi.fn()
    const err = await requestWithRetry(
      { ...get, signal: ctrl.signal },
      { retry: policy, hooks: { beforeRequest, onError } },
    ).catch((e: unknown) => e)
    expect(err).toBe(reason)
    expect(beforeRequest).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    expect(fetched).not.toHaveBeenCalled()
  })
})
