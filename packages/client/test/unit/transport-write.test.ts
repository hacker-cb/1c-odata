import type { MetadataIndex } from '@1c-odata/client'
import { BasicAuth, ODataV3Client } from '@1c-odata/client'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())
beforeEach(() => server.resetHandlers())

const baseUrl = 'http://example.test/odata'
const auth = BasicAuth({ username: 'u', password: 'p' })

describe('transport write methods', () => {
  it('transportPost sends POST with JSON body + Content-Type + Content-Length', async () => {
    let received: { method: string; ct?: string; cl?: string; body?: string } | null = null
    server.use(
      http.post(`${baseUrl}/Catalog_X`, async ({ request }) => {
        received = {
          method: request.method,
          ct: request.headers.get('content-type') ?? undefined,
          cl: request.headers.get('content-length') ?? undefined,
          body: await request.text(),
        }
        return HttpResponse.json({ Ref_Key: 'g', Code: 'X' }, { status: 201 })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    const r = await c.transportPost(`${baseUrl}/Catalog_X`, { Code: 'X' }, {}, 'Catalog_X')
    expect(r.status).toBe(201)
    expect(received?.method).toBe('POST')
    expect(received?.ct).toBe('application/json')
    expect(received?.cl).toBe(String(Buffer.byteLength(received?.body ?? '', 'utf8')))
    expect(JSON.parse(received?.body ?? '')).toEqual({ Code: 'X' })
  })

  // NOTE: parentheses are reserved in MSW's path-to-regexp matcher, so the
  // key-URL handlers below use a RegExp (matching the convention already used
  // in test/client.test.ts) instead of a string template.
  it('transportPatch sends PATCH with JSON body', async () => {
    server.use(
      http.patch(/Catalog_X\(guid'g'\)/, () => HttpResponse.json({ Ref_Key: 'g', Code: 'Y' }, { status: 200 })),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    const r = await c.transportPatch(`${baseUrl}/Catalog_X(guid'g')`, { Code: 'Y' }, {}, 'Catalog_X')
    expect(r.status).toBe(200)
  })

  it('transportPut sends PUT with JSON body', async () => {
    server.use(http.put(/Catalog_X\(guid'g'\)/, () => HttpResponse.json({ Ref_Key: 'g', Code: 'Z' }, { status: 200 })))
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    const r = await c.transportPut(`${baseUrl}/Catalog_X(guid'g')`, { Code: 'Z' }, {}, 'Catalog_X')
    expect(r.status).toBe(200)
  })

  it('transportDelete sends DELETE with no body but explicit Content-Length: 0', async () => {
    let cl: string | null = null
    server.use(
      http.delete(/Catalog_X\(guid'g'\)/, ({ request }) => {
        cl = request.headers.get('content-length')
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    const r = await c.transportDelete(`${baseUrl}/Catalog_X(guid'g')`, {}, 'Catalog_X')
    expect(r.status).toBe(204)
    expect(cl).toBe('0')
  })

  it('withHeader merges case-insensitively (user override wins, no duplicates)', async () => {
    let received: { allHeaders: Record<string, string> } | null = null
    server.use(
      http.patch(/Catalog_X\(guid'g'\)/, ({ request }) => {
        const all: Record<string, string> = {}
        request.headers.forEach((v, k) => {
          all[k] = v
        })
        received = { allHeaders: all }
        return HttpResponse.json({ Ref_Key: 'g', Code: 'Y' }, { status: 200 })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await c.entity('Catalog_X', 'g').withHeader('authorization', 'Bearer custom-token').patch({ Code: 'Y' })

    expect(received).not.toBeNull()
    expect(received?.allHeaders?.authorization).toBe('Bearer custom-token')
  })

  it('withHeader cannot override library-managed Content-Type on write', async () => {
    let received: { ct?: string } | null = null
    server.use(
      http.patch(/Catalog_X\(guid'g'\)/, ({ request }) => {
        received = { ct: request.headers.get('content-type') ?? undefined }
        return HttpResponse.json({ Ref_Key: 'g', Code: 'Y' }, { status: 200 })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await c.entity('Catalog_X', 'g').withHeader('content-type', 'text/plain').patch({ Code: 'Y' })
    expect(received?.ct).toBe('application/json')
  })
})

describe('transport write — transformDatesToWire integration', () => {
  const metadataIndex: MetadataIndex = {
    schemaNamespace: 'StandardODATA',
    schemas: {
      Document_X: {
        properties: {
          Ref_Key: { type: 'Edm.Guid', nullable: false },
          Date: { type: 'Edm.DateTime', nullable: true },
        },
      },
    },
    entitySetToType: { Document_X: 'Document_X' },
    shape: { dateMode: 'date', int64Mode: 'number' },
  }

  it('serializes Date instance to naive ISO in server tz on PATCH', async () => {
    let capturedBody: unknown
    server.use(
      http.patch(/Document_X\(guid'a'\)/, async ({ request }) => {
        capturedBody = await request.json()
        return HttpResponse.json({ Ref_Key: 'a', Date: '2025-03-15T15:00:00' })
      }),
    )
    const client = new ODataV3Client({
      baseUrl,
      serverTimezone: 'Europe/Moscow',
      auth,
      metadataIndex,
    })
    await client.entity('Document_X', 'a').patch({ Date: new Date('2025-03-15T12:00:00Z') })
    // 12:00 UTC + 3h Moscow tz = 15:00 local naive
    expect(capturedBody).toMatchObject({ Date: '2025-03-15T15:00:00' })
  })

  it('serializes null Date to ONEC_EMPTY_DATE sentinel', async () => {
    let capturedBody: unknown
    server.use(
      http.patch(/Document_X\(guid'a'\)/, async ({ request }) => {
        capturedBody = await request.json()
        return HttpResponse.json({ Ref_Key: 'a' })
      }),
    )
    const client = new ODataV3Client({
      baseUrl,
      serverTimezone: 'Europe/Moscow',
      auth,
      metadataIndex,
    })
    await client.entity('Document_X', 'a').patch({ Date: null })
    expect(capturedBody).toMatchObject({ Date: '0001-01-01T00:00:00' })
  })

  it('passes body through unchanged when no metadataIndex is loaded', async () => {
    let capturedBody: unknown
    server.use(
      http.patch(/Document_X\(guid'a'\)/, async ({ request }) => {
        capturedBody = await request.json()
        return HttpResponse.json({ Ref_Key: 'a' })
      }),
    )
    const client = new ODataV3Client({
      baseUrl,
      serverTimezone: 'Europe/Moscow',
      auth,
    })
    const d = new Date('2025-03-15T12:00:00Z')
    await client.entity('Document_X', 'a').patch({ Date: d })
    // No metadataIndex → no transform, Date.toJSON() yields ISO-Z
    expect(capturedBody).toMatchObject({ Date: '2025-03-15T12:00:00.000Z' })
  })
})
