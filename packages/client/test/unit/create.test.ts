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

describe('V3EntitySetHandle.create', () => {
  it('POST to entity-set URL returns full entity with auto Ref_Key + DataVersion', async () => {
    let receivedBody: unknown
    server.use(
      // POST URL has no parens, so a string template is fine here.
      http.post(`${baseUrl}/Catalog_X`, async ({ request }) => {
        receivedBody = await request.json()
        return HttpResponse.json(
          {
            'odata.metadata': `${baseUrl}/$metadata#Catalog_X/@Element`,
            Ref_Key: 'auto-guid',
            Code: 'A',
            DataVersion: 'v1',
          },
          { status: 201 },
        )
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    const r = await c.entity<{ Ref_Key: string; Code: string; DataVersion: string }>('Catalog_X').create({ Code: 'A' })
    expect(receivedBody).toEqual({ Code: 'A' })
    expect(r.Ref_Key).toBe('auto-guid')
    expect(r.DataVersion).toBe('v1')
  })

  it('client.entity(set, key) still returns V3EntityHandle (regression check)', async () => {
    server.use(
      // NOTE: regex matcher — MSW's path-to-regexp interprets `(` in string
      // templates as parameter syntax, so a string template never matches a
      // URL containing parens (e.g. `Catalog_X(guid'...')`).
      http.get(/Catalog_X\(guid'g'\)/, () =>
        HttpResponse.json({
          'odata.metadata': `${baseUrl}/$metadata#Catalog_X/@Element`,
          Ref_Key: 'g',
          Code: 'B',
        }),
      ),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    const r = await c.entity<{ Ref_Key: string; Code: string }>('Catalog_X', 'g').get()
    expect(r.Code).toBe('B')
  })
})
