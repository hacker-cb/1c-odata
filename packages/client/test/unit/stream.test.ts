import { BasicAuth, ODataV3Client } from '@1c-odata/client'
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

describe('stream() async iterator', () => {
  it('paginates through all results in pages of pageSize', async () => {
    server.use(
      http.get(`${base}/Catalog_X`, ({ request }) => {
        const url = new URL(request.url)
        const skip = Number.parseInt(url.searchParams.get('$skip') ?? '0', 10)
        const top = Number.parseInt(url.searchParams.get('$top') ?? '0', 10)
        const all = Array.from({ length: 25 }, (_, i) => ({ Code: `C${i}` }))
        const page = all.slice(skip, skip + top)
        return HttpResponse.json({ value: page })
      }),
    )

    const collected: { Code: string }[] = []
    for await (const item of client.query<{ Code: string }>('Catalog_X').stream({ pageSize: 10 })) {
      collected.push(item)
    }
    expect(collected).toHaveLength(25)
    expect(collected[0].Code).toBe('C0')
    expect(collected[24].Code).toBe('C24')
  })

  it('stops when page returns empty value', async () => {
    let n = 0
    server.use(
      http.get(`${base}/Catalog_X`, () => {
        n++
        return HttpResponse.json({ value: [] })
      }),
    )
    const collected: unknown[] = []
    for await (const item of client.query('Catalog_X').stream({ pageSize: 100 })) {
      collected.push(item)
    }
    expect(collected).toHaveLength(0)
    expect(n).toBe(1)
  })

  it('respects user .top() — exact multiple of pageSize', async () => {
    const seen: { skip: number; top: number }[] = []
    server.use(
      http.get(`${base}/Catalog_X`, ({ request }) => {
        const url = new URL(request.url)
        const skip = Number.parseInt(url.searchParams.get('$skip') ?? '0', 10)
        const top = Number.parseInt(url.searchParams.get('$top') ?? '0', 10)
        seen.push({ skip, top })
        const all = Array.from({ length: 25 }, (_, i) => ({ Code: `C${i}` }))
        return HttpResponse.json({ value: all.slice(skip, skip + top) })
      }),
    )

    const collected: { Code: string }[] = []
    for await (const item of client.query<{ Code: string }>('Catalog_X').top(20).stream({ pageSize: 5 })) {
      collected.push(item)
    }
    expect(collected).toHaveLength(20)
    expect(seen).toEqual([
      { skip: 0, top: 5 },
      { skip: 5, top: 5 },
      { skip: 10, top: 5 },
      { skip: 15, top: 5 },
    ])
  })

  it('respects user .top() — non-multiple of pageSize, last page shrinks', async () => {
    const seen: { skip: number; top: number }[] = []
    server.use(
      http.get(`${base}/Catalog_X`, ({ request }) => {
        const url = new URL(request.url)
        const skip = Number.parseInt(url.searchParams.get('$skip') ?? '0', 10)
        const top = Number.parseInt(url.searchParams.get('$top') ?? '0', 10)
        seen.push({ skip, top })
        const all = Array.from({ length: 25 }, (_, i) => ({ Code: `C${i}` }))
        return HttpResponse.json({ value: all.slice(skip, skip + top) })
      }),
    )

    const collected: { Code: string }[] = []
    for await (const item of client.query<{ Code: string }>('Catalog_X').top(13).stream({ pageSize: 5 })) {
      collected.push(item)
    }
    expect(collected).toHaveLength(13)
    expect(seen).toEqual([
      { skip: 0, top: 5 },
      { skip: 5, top: 5 },
      { skip: 10, top: 3 },
    ])
  })

  it('respects user .top() — top smaller than pageSize, single request', async () => {
    const seen: { skip: number; top: number }[] = []
    server.use(
      http.get(`${base}/Catalog_X`, ({ request }) => {
        const url = new URL(request.url)
        const skip = Number.parseInt(url.searchParams.get('$skip') ?? '0', 10)
        const top = Number.parseInt(url.searchParams.get('$top') ?? '0', 10)
        seen.push({ skip, top })
        const all = Array.from({ length: 25 }, (_, i) => ({ Code: `C${i}` }))
        return HttpResponse.json({ value: all.slice(skip, skip + top) })
      }),
    )

    const collected: { Code: string }[] = []
    for await (const item of client.query<{ Code: string }>('Catalog_X').top(3).stream({ pageSize: 10 })) {
      collected.push(item)
    }
    expect(collected).toHaveLength(3)
    expect(seen).toEqual([{ skip: 0, top: 3 }])
  })

  it('top=0 issues no requests', async () => {
    let n = 0
    server.use(
      http.get(`${base}/Catalog_X`, () => {
        n++
        return HttpResponse.json({ value: [] })
      }),
    )

    const collected: unknown[] = []
    for await (const item of client.query('Catalog_X').top(0).stream({ pageSize: 10 })) {
      collected.push(item)
    }
    expect(collected).toHaveLength(0)
    expect(n).toBe(0)
  })

  it('respects user .skip() as starting offset', async () => {
    const seen: { skip: number; top: number }[] = []
    server.use(
      http.get(`${base}/Catalog_X`, ({ request }) => {
        const url = new URL(request.url)
        const skip = Number.parseInt(url.searchParams.get('$skip') ?? '0', 10)
        const top = Number.parseInt(url.searchParams.get('$top') ?? '0', 10)
        seen.push({ skip, top })
        const all = Array.from({ length: 17 }, (_, i) => ({ Code: `C${i}` }))
        return HttpResponse.json({ value: all.slice(skip, skip + top) })
      }),
    )

    const collected: { Code: string }[] = []
    for await (const item of client.query<{ Code: string }>('Catalog_X').skip(7).stream({ pageSize: 5 })) {
      collected.push(item)
    }
    expect(collected).toHaveLength(10)
    expect(collected[0].Code).toBe('C7')
    expect(collected[9].Code).toBe('C16')
    expect(seen).toEqual([
      { skip: 7, top: 5 },
      { skip: 12, top: 5 },
      { skip: 17, top: 5 },
    ])
  })

  it('respects user .top() and .skip() together', async () => {
    const seen: { skip: number; top: number }[] = []
    server.use(
      http.get(`${base}/Catalog_X`, ({ request }) => {
        const url = new URL(request.url)
        const skip = Number.parseInt(url.searchParams.get('$skip') ?? '0', 10)
        const top = Number.parseInt(url.searchParams.get('$top') ?? '0', 10)
        seen.push({ skip, top })
        const all = Array.from({ length: 30 }, (_, i) => ({ Code: `C${i}` }))
        return HttpResponse.json({ value: all.slice(skip, skip + top) })
      }),
    )

    const collected: { Code: string }[] = []
    for await (const item of client.query<{ Code: string }>('Catalog_X').skip(5).top(7).stream({ pageSize: 3 })) {
      collected.push(item)
    }
    expect(collected).toHaveLength(7)
    expect(collected[0].Code).toBe('C5')
    expect(collected[6].Code).toBe('C11')
    expect(seen).toEqual([
      { skip: 5, top: 3 },
      { skip: 8, top: 3 },
      { skip: 11, top: 1 },
    ])
  })

  it('terminates early when server returns shorter page than requested', async () => {
    let n = 0
    server.use(
      http.get(`${base}/Catalog_X`, ({ request }) => {
        n++
        const url = new URL(request.url)
        const top = Number.parseInt(url.searchParams.get('$top') ?? '0', 10)
        return HttpResponse.json({
          value: Array.from({ length: 3 }, (_, i) => ({ Code: `C${i}` })).slice(0, Math.min(3, top)),
        })
      }),
    )

    const collected: { Code: string }[] = []
    for await (const item of client.query<{ Code: string }>('Catalog_X').stream({ pageSize: 5 })) {
      collected.push(item)
    }
    expect(collected).toHaveLength(3)
    expect(n).toBe(1)
  })

  it('caps yielded items at user .top() even if server ignores $top', async () => {
    // Server returns a full page of 10 regardless of $top — simulating a misbehaving
    // backend. The stream must still cap output at user-supplied .top(7).
    server.use(
      http.get(`${base}/Catalog_X`, () => {
        return HttpResponse.json({
          value: Array.from({ length: 10 }, (_, i) => ({ Code: `C${i}` })),
        })
      }),
    )

    const collected: { Code: string }[] = []
    for await (const item of client.query<{ Code: string }>('Catalog_X').top(7).stream({ pageSize: 5 })) {
      collected.push(item)
    }
    expect(collected).toHaveLength(7)
    expect(collected[0].Code).toBe('C0')
    expect(collected[6].Code).toBe('C6')
  })
})
