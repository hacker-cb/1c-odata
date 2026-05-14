import { BasicAuth, ConcurrencyError, ODataV3Client } from '@1c-odata/client'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())
beforeEach(() => server.resetHandlers())

const baseUrl = 'http://example.test/odata'
const auth = BasicAuth({ username: 'u', password: 'p' })

describe('V3EntityHandle expectVersion option', () => {
  it('proceeds with PATCH when server DataVersion matches', async () => {
    let patchHit = false
    server.use(
      // NOTE: regex matcher — MSW's path-to-regexp interprets `(` in string
      // templates as parameter syntax, so a string template never matches a
      // URL containing parens (e.g. `Catalog_X(guid'g')`).
      http.get(/Catalog_X\(guid'g'\)/, () =>
        HttpResponse.json({
          'odata.metadata': `${baseUrl}/$metadata#Catalog_X/@Element`,
          Ref_Key: 'g',
          DataVersion: 'v1',
          Code: 'OLD',
        }),
      ),
      http.patch(/Catalog_X\(guid'g'\)/, async () => {
        patchHit = true
        return HttpResponse.json({
          'odata.metadata': `${baseUrl}/$metadata#Catalog_X/@Element`,
          Ref_Key: 'g',
          DataVersion: 'v2',
          Code: 'NEW',
        })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    const r = await c
      .entity<{ Ref_Key: string; DataVersion: string; Code: string }>('Catalog_X', 'g')
      .patch({ Code: 'NEW' }, { expectVersion: 'v1' })
    expect(patchHit).toBe(true)
    expect(r.Code).toBe('NEW')
    expect(r.DataVersion).toBe('v2')
  })

  it('throws ConcurrencyError when DataVersion mismatches; PATCH never runs', async () => {
    let patchHit = false
    server.use(
      http.get(/Catalog_X\(guid'g'\)/, () =>
        HttpResponse.json({
          'odata.metadata': `${baseUrl}/$metadata#Catalog_X/@Element`,
          Ref_Key: 'g',
          DataVersion: 'v3',
          Code: 'OLD',
        }),
      ),
      http.patch(/Catalog_X\(guid'g'\)/, async () => {
        patchHit = true
        return HttpResponse.json({})
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await expect(c.entity('Catalog_X', 'g').patch({ Code: 'NEW' }, { expectVersion: 'v1' })).rejects.toBeInstanceOf(
      ConcurrencyError,
    )
    expect(patchHit).toBe(false)
  })

  it('PUT honors expectVersion: throws on mismatch, PUT never runs', async () => {
    let putHit = false
    server.use(
      http.get(/Catalog_X\(guid'g'\)/, () =>
        HttpResponse.json({
          'odata.metadata': `${baseUrl}/$metadata#Catalog_X/@Element`,
          Ref_Key: 'g',
          DataVersion: 'vSERVER',
          Code: 'OLD',
        }),
      ),
      http.put(/Catalog_X\(guid'g'\)/, async () => {
        putHit = true
        return HttpResponse.json({})
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await expect(
      c
        .entity<{ Ref_Key: string; DataVersion: string; Code: string }>('Catalog_X', 'g')
        .put({ Ref_Key: 'g', DataVersion: 'vSERVER', Code: 'NEW' }, { expectVersion: 'vCLIENT' }),
    ).rejects.toBeInstanceOf(ConcurrencyError)
    expect(putHit).toBe(false)
  })

  it('DELETE honors expectVersion: throws on mismatch, DELETE never runs', async () => {
    let deleteHit = false
    server.use(
      http.get(/Catalog_X\(guid'g'\)/, () =>
        HttpResponse.json({
          'odata.metadata': `${baseUrl}/$metadata#Catalog_X/@Element`,
          Ref_Key: 'g',
          DataVersion: 'vSERVER',
        }),
      ),
      http.delete(/Catalog_X\(guid'g'\)/, async () => {
        deleteHit = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await expect(c.entity('Catalog_X', 'g').delete({ expectVersion: 'vCLIENT' })).rejects.toBeInstanceOf(
      ConcurrencyError,
    )
    expect(deleteHit).toBe(false)
  })

  it('writeStream honors expectVersion: throws on mismatch, PATCH never runs', async () => {
    let patchHit = false
    server.use(
      http.get(/Catalog_X\(guid'g'\)/, () =>
        HttpResponse.json({
          'odata.metadata': `${baseUrl}/$metadata#Catalog_X/@Element`,
          Ref_Key: 'g',
          DataVersion: 'vSERVER',
        }),
      ),
      http.patch(/Catalog_X\(guid'g'\)/, async () => {
        patchHit = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await expect(
      c
        .entity('Catalog_X', 'g')
        .writeStream(
          'ФайлХранилище',
          { contentType: 'image/png', base64Data: 'aGVsbG8=' },
          { expectVersion: 'vCLIENT' },
        ),
    ).rejects.toBeInstanceOf(ConcurrencyError)
    expect(patchHit).toBe(false)
  })
})
