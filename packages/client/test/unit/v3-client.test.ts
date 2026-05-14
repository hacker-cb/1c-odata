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

describe('ODataV3Client.query', () => {
  it('returns parsed collection with value + odataMetadata', async () => {
    server.use(
      http.get(`${base}/Catalog_X`, () =>
        HttpResponse.json({
          'odata.metadata': `${base}/$metadata#Catalog_X`,
          value: [
            { Ref_Key: 'a', Code: '1' },
            { Ref_Key: 'b', Code: '2' },
          ],
        }),
      ),
    )
    const res = await client.query<{ Ref_Key: string; Code: string }>('Catalog_X').get()
    expect(res.value).toHaveLength(2)
    expect(res.odataMetadata).toContain('Catalog_X')
  })

  it('honors filter + top + select via URL', async () => {
    let capturedUrl = ''
    server.use(
      http.get(`${base}/Catalog_X`, ({ request }) => {
        capturedUrl = request.url
        return HttpResponse.json({ value: [] })
      }),
    )
    await client
      .query<{ Code: string; DeletionMark: boolean }>('Catalog_X')
      .filter((f) => f.DeletionMark.eq(false))
      .select('Code')
      .top(5)
      .get()
    expect(capturedUrl).toContain('%24filter=DeletionMark%20eq%20false')
    expect(capturedUrl).toContain('%24top=5')
    expect(capturedUrl).toContain('%24select=Code')
  })

  it('count() returns plain integer from /$count endpoint', async () => {
    server.use(
      http.get(
        `${base}/Catalog_X/$count`,
        () => new HttpResponse('10715', { headers: { 'content-type': 'text/plain' } }),
      ),
    )
    const n = await client.query('Catalog_X').count()
    expect(n).toBe(10715)
  })

  it('entity(set, key).get() returns single entity', async () => {
    server.use(
      http.get(/Catalog_X\(guid'818ed18b-76c9-11e4-8918-003048663bbb'\)/, () =>
        HttpResponse.json({
          'odata.metadata': `${base}/$metadata#Catalog_X/@Element`,
          Ref_Key: '818ed18b-76c9-11e4-8918-003048663bbb',
          Code: 'V1',
        }),
      ),
    )
    const entity = await client
      .entity<{ Ref_Key: string; Code: string }>('Catalog_X', '818ed18b-76c9-11e4-8918-003048663bbb')
      .get()
    expect(entity.Code).toBe('V1')
  })

  it('raw() returns native Response without parsing', async () => {
    server.use(http.get(`${base}/Catalog_X`, () => HttpResponse.json({ value: [1, 2, 3] })))
    const resp = await client.query('Catalog_X').raw()
    expect(resp.status).toBe(200)
    const text = await resp.text()
    expect(JSON.parse(text)).toEqual({ value: [1, 2, 3] })
  })
})
