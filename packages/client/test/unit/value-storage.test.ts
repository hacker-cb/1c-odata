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

describe('readStream', () => {
  it('GET <entity>/<prop>/$value returns body + contentType', async () => {
    server.use(
      // NOTE: regex matcher — MSW's path-to-regexp interprets `(` in string
      // templates as parameter syntax, so a string template never matches a
      // URL containing parens (e.g. `Catalog_Файлы(guid'g')`). Cyrillic
      // segment names are URL-encoded by `buildV3KeyUrl`, so the regex is
      // matched against the encoded form.
      http.get(
        /Catalog_%D0%A4%D0%B0%D0%B9%D0%BB%D1%8B\(guid'g'\)\/%D0%A4%D0%B0%D0%B9%D0%BB%D0%A5%D1%80%D0%B0%D0%BD%D0%B8%D0%BB%D0%B8%D1%89%D0%B5\/\$value/,
        () => {
          return new HttpResponse(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), {
            status: 200,
            headers: { 'Content-Type': 'image/jpeg' },
          })
        },
      ),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    const stream = await c.entity('Catalog_Файлы', 'g').readStream('ФайлХранилище')
    expect(stream.contentType).toBe('image/jpeg')
    const reader = stream.body.getReader()
    const chunk = await reader.read()
    expect(chunk.value).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))
  })

  it('readStream surfaces server contentType + body even for empty payload', async () => {
    // Server explicitly sends application/octet-stream and a 1-byte payload.
    server.use(
      http.get(/Catalog_%D0%A4%D0%B0%D0%B9%D0%BB%D1%8B\(guid'g'\)\/X\/\$value/, () => {
        return new HttpResponse(new Uint8Array([0]), {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    const stream = await c.entity('Catalog_Файлы', 'g').readStream('X')
    expect(stream.contentType).toBe('application/octet-stream')
    expect(stream.body).toBeDefined()
  })
})

describe('writeStream', () => {
  it('PATCHes the entity with <prop>_Type and <prop>_Base64Data fields', async () => {
    let received: unknown
    server.use(
      // NOTE: regex matcher — see readStream above for rationale. The Cyrillic
      // entity-set name is URL-encoded by `buildV3KeyUrl`.
      http.patch(/Catalog_%D0%A4%D0%B0%D0%B9%D0%BB%D1%8B\(guid'g'\)/, async ({ request }) => {
        received = await request.json()
        return HttpResponse.json({
          'odata.metadata': `${baseUrl}/$metadata#Catalog_Файлы/@Element`,
          Ref_Key: 'g',
        })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await c.entity('Catalog_Файлы', 'g').writeStream('ФайлХранилище', {
      contentType: 'image/jpeg',
      base64Data: 'AQID',
    })
    expect(received).toEqual({
      ФайлХранилище_Type: 'image/jpeg',
      ФайлХранилище_Base64Data: 'AQID',
    })
  })
})
