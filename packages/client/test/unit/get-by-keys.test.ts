import { BasicAuth, InvalidArgumentError, ODataV3Client } from '@1c-odata/client'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const base = 'http://1c.test/odata/standard.odata'
const server = setupServer()

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const client = new ODataV3Client({
  baseUrl: base,
  auth: BasicAuth({ username: 'u', password: 'p' }),
  serverTimezone: 'Europe/Moscow',
})

const guid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`

interface Call {
  filter: string
  select: string | null
  expand: string | null
  /** Encoded query-string length (excluding the leading '?'). */
  queryLen: number
}

/**
 * Stub `Catalog_X` to echo back one `{ Ref_Key }` row per `guid'…'` found in
 * `$filter`, and record each request's params. Lets a test assert batch count,
 * concatenation, dedup, and per-batch projection from a single handler.
 */
function stubEcho(): Call[] {
  const calls: Call[] = []
  server.use(
    http.get(`${base}/Catalog_X`, ({ request }) => {
      const url = new URL(request.url)
      const filter = url.searchParams.get('$filter') ?? ''
      calls.push({
        filter,
        select: url.searchParams.get('$select'),
        expand: url.searchParams.get('$expand'),
        queryLen: url.search.length - 1,
      })
      const guids = [...filter.matchAll(/guid'([^']+)'/g)].map((m) => m[1] as string)
      return HttpResponse.json({ value: guids.map((g) => ({ Ref_Key: g })) })
    }),
  )
  return calls
}

describe('getByKeys', () => {
  it('issues ceil(N / batchSize) requests and concatenates rows in order', async () => {
    const calls = stubEcho()
    const guids = Array.from({ length: 23 }, (_, i) => guid(i))

    const rows = await client.query<{ Ref_Key: string }>('Catalog_X').getByKeys('Ref_Key', guids, { batchSize: 5 })

    expect(calls).toHaveLength(5) // ceil(23 / 5)
    expect(rows.map((r) => r.Ref_Key)).toEqual(guids) // concatenated in batch (= input) order
  })

  it('auto-chunks a long GUID list (no batchSize) keeping each query string well under 2048 bytes', async () => {
    const calls = stubEcho()
    // 24 GUIDs + a 5-field nested select + expand — the exact shape that returned
    // an HTML 404 against the live base before this helper existed.
    const guids = Array.from({ length: 24 }, (_, i) => guid(i))

    // Untyped query so the nested `$select` paths (the live-repro shape) are accepted.
    const rows = await client
      .query('Catalog_X')
      .select('Ref_Key', 'Номенклатура_Key', 'Номенклатура/Description', 'Номенклатура/ВидНоменклатуры_Key')
      .expand('Номенклатура')
      .getByKeys('Ref_Key', guids)

    expect(calls.length).toBeGreaterThan(1) // it actually split
    expect(new Set(rows.map((r) => r.Ref_Key))).toEqual(new Set(guids)) // all recovered
    for (const c of calls) {
      expect(c.queryLen).toBeLessThan(2048) // the whole point: under the IIS limit
      expect(c.select).toBe('Ref_Key,Номенклатура_Key,Номенклатура/Description,Номенклатура/ВидНоменклатуры_Key')
      expect(c.expand).toBe('Номенклатура') // projection preserved on every batch
    }
  })

  it('deduplicates keys before batching', async () => {
    const calls = stubEcho()
    const rows = await client
      .query<{ Ref_Key: string }>('Catalog_X')
      .getByKeys('Ref_Key', [guid(1), guid(1), guid(2), guid(2), guid(1)], { batchSize: 10 })

    expect(calls).toHaveLength(1)
    expect(rows.map((r) => r.Ref_Key)).toEqual([guid(1), guid(2)])
  })

  it('AND-combines the key filter with a pre-existing .filter()', async () => {
    const calls = stubEcho()
    const guids = [guid(1), guid(2)]

    await client
      .query<{ Ref_Key: string; DeletionMark: boolean }>('Catalog_X')
      .filter((f) => f.DeletionMark.eq(false))
      .getByKeys('Ref_Key', guids, { batchSize: 10 })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.filter).toBe(
      `DeletionMark eq false and ((Ref_Key eq guid'${guid(1)}') or (Ref_Key eq guid'${guid(2)}'))`,
    )
  })

  it('returns [] without any request for an empty key list', async () => {
    const calls = stubEcho()
    const rows = await client.query('Catalog_X').getByKeys('Ref_Key', [])
    expect(rows).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('returns only matched rows when some keys are missing', async () => {
    // Handler returns rows only for even-indexed guids → odd keys are "missing".
    const calls: string[] = []
    server.use(
      http.get(`${base}/Catalog_X`, ({ request }) => {
        const filter = new URL(request.url).searchParams.get('$filter') ?? ''
        calls.push(filter)
        const guids = [...filter.matchAll(/guid'([^']+)'/g)].map((m) => m[1] as string)
        const found = guids.filter((g) => Number(g.slice(-12)) % 2 === 0)
        return HttpResponse.json({ value: found.map((g) => ({ Ref_Key: g })) })
      }),
    )
    const guids = Array.from({ length: 6 }, (_, i) => guid(i))
    const rows = await client.query<{ Ref_Key: string }>('Catalog_X').getByKeys('Ref_Key', guids, { batchSize: 3 })
    expect(rows.map((r) => r.Ref_Key)).toEqual([guid(0), guid(2), guid(4)])
  })

  describe('input validation (no request issued)', () => {
    it('throws on a non-positive batchSize', async () => {
      const calls = stubEcho()
      await expect(client.query('Catalog_X').getByKeys('Ref_Key', [guid(1)], { batchSize: 0 })).rejects.toBeInstanceOf(
        InvalidArgumentError,
      )
      expect(calls).toHaveLength(0)
    })

    it('throws on a NaN concurrency instead of silently returning [] (regression)', async () => {
      // A NaN limit (e.g. Number(process.env.X) when unset) once produced zero
      // workers → empty result for non-empty input. It must throw now.
      const calls = stubEcho()
      await expect(
        client.query('Catalog_X').getByKeys('Ref_Key', [guid(1), guid(2)], { concurrency: Number.NaN }),
      ).rejects.toBeInstanceOf(InvalidArgumentError)
      expect(calls).toHaveLength(0)
    })

    it('throws on a non-positive queryBudget', async () => {
      const calls = stubEcho()
      await expect(
        client.query('Catalog_X').getByKeys('Ref_Key', [guid(1)], { queryBudget: 0 }),
      ).rejects.toBeInstanceOf(InvalidArgumentError)
      expect(calls).toHaveLength(0)
    })

    it('throws (does not ship an over-limit URL) when the fixed query parts leave no room for keys', async () => {
      // queryBudget so small that $format alone exceeds it → no key budget. This is
      // the same guard that fires for a huge $select/$expand under the default budget;
      // chunking keys cannot help, so it must throw rather than 404 silently.
      const calls = stubEcho()
      await expect(
        client.query('Catalog_X').getByKeys('Ref_Key', [guid(1)], { queryBudget: 20 }),
      ).rejects.toBeInstanceOf(InvalidArgumentError)
      expect(calls).toHaveLength(0)
    })
  })
})
