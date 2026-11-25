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

describe('V3EntityHandle.patch', () => {
  it('PATCH partial update returns the parsed entity', async () => {
    let receivedBody: unknown
    server.use(
      // NOTE: regex matcher — MSW's path-to-regexp interprets `(` in string
      // templates as parameter syntax, so a string template never matches a
      // URL containing parens (e.g. `Catalog_X(guid'...')`).
      http.patch(/Catalog_X\(guid'818ed18b-76c9-11e4-8918-003048663bbb'\)/, async ({ request }) => {
        receivedBody = await request.json()
        return HttpResponse.json({
          'odata.metadata': `${baseUrl}/$metadata#Catalog_X/@Element`,
          Ref_Key: '818ed18b-76c9-11e4-8918-003048663bbb',
          Code: 'NEW',
          DataVersion: 'v2',
        })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    const result = await c
      .entity<{ Ref_Key: string; Code: string; DataVersion: string }>(
        'Catalog_X',
        '818ed18b-76c9-11e4-8918-003048663bbb',
      )
      .patch({ Code: 'NEW' })
    expect(result.Code).toBe('NEW')
    expect(result.DataVersion).toBe('v2')
    expect(receivedBody).toEqual({ Code: 'NEW' })
  })
})

describe('V3EntityHandle.put', () => {
  it('PUT full replace returns the parsed entity', async () => {
    let receivedMethod: string | null = null
    let receivedBody: unknown
    server.use(
      // NOTE: regex matcher — MSW's path-to-regexp interprets `(` in string
      // templates as parameter syntax, so a string template never matches a
      // URL containing parens (e.g. `Catalog_X(guid'...')`).
      http.put(/Catalog_X\(guid'00000000-0000-0000-0000-00000000000a'\)/, async ({ request }) => {
        receivedMethod = request.method
        receivedBody = await request.json()
        return HttpResponse.json({
          'odata.metadata': `${baseUrl}/$metadata#Catalog_X/@Element`,
          Ref_Key: 'g',
          Code: 'A',
          Description: 'B',
          DataVersion: 'v2',
        })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    const r = await c
      .entity<{ Ref_Key: string; Code: string; Description: string; DataVersion: string }>(
        'Catalog_X',
        '00000000-0000-0000-0000-00000000000a',
      )
      .put({ Ref_Key: 'g', Code: 'A', Description: 'B', DataVersion: 'v1' })
    expect(receivedMethod).toBe('PUT')
    expect(r.Description).toBe('B')
    expect(receivedBody).toMatchObject({ Code: 'A', Description: 'B' })
  })
})

describe('V3EntityHandle.delete', () => {
  it('DELETE returns void on 204', async () => {
    server.use(
      // NOTE: regex matcher — MSW's path-to-regexp interprets `(` in string
      // templates as parameter syntax, so a string template never matches a
      // URL containing parens (e.g. `Catalog_X(guid'...')`).
      http.delete(
        /Catalog_X\(guid'00000000-0000-0000-0000-00000000000a'\)/,
        () => new HttpResponse(null, { status: 204 }),
      ),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await expect(c.entity('Catalog_X', '00000000-0000-0000-0000-00000000000a').delete()).resolves.toBeUndefined()
  })
})

describe('V3EntityHandle.markForDeletion / unmarkForDeletion', () => {
  it('markForDeletion sends PATCH { DeletionMark: true }', async () => {
    let received: unknown
    server.use(
      // NOTE: regex matcher — MSW's path-to-regexp interprets `(` in string
      // templates as parameter syntax, so a string template never matches a
      // URL containing parens (e.g. `Catalog_X(guid'...')`).
      http.patch(/Catalog_X\(guid'00000000-0000-0000-0000-00000000000a'\)/, async ({ request }) => {
        received = await request.json()
        return HttpResponse.json({
          'odata.metadata': `${baseUrl}/$metadata#Catalog_X/@Element`,
          Ref_Key: 'g',
          DeletionMark: true,
        })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    const r = await c
      .entity<{ Ref_Key: string; DeletionMark: boolean }>('Catalog_X', '00000000-0000-0000-0000-00000000000a')
      .markForDeletion()
    expect(received).toEqual({ DeletionMark: true })
    expect(r.DeletionMark).toBe(true)
  })

  it('unmarkForDeletion sends PATCH { DeletionMark: false }', async () => {
    let received: unknown
    server.use(
      // NOTE: regex matcher — MSW's path-to-regexp interprets `(` in string
      // templates as parameter syntax, so a string template never matches a
      // URL containing parens (e.g. `Catalog_X(guid'...')`).
      http.patch(/Catalog_X\(guid'00000000-0000-0000-0000-00000000000a'\)/, async ({ request }) => {
        received = await request.json()
        return HttpResponse.json({
          'odata.metadata': `${baseUrl}/$metadata#Catalog_X/@Element`,
          Ref_Key: 'g',
          DeletionMark: false,
        })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    const r = await c
      .entity<{ Ref_Key: string; DeletionMark: boolean }>('Catalog_X', '00000000-0000-0000-0000-00000000000a')
      .unmarkForDeletion()
    expect(received).toEqual({ DeletionMark: false })
    expect(r.DeletionMark).toBe(false)
  })
})

describe('V3EntityHandle.withHeader', () => {
  it('adds custom header to PATCH request', async () => {
    let dataLoadMode: string | null = null
    server.use(
      // NOTE: regex matcher — see CRUD describes above for rationale.
      http.patch(/Catalog_X\(guid'00000000-0000-0000-0000-00000000000a'\)/, async ({ request }) => {
        dataLoadMode = request.headers.get('1c_odata-dataloadmode')
        return HttpResponse.json({
          'odata.metadata': `${baseUrl}/$metadata#Catalog_X/@Element`,
          Ref_Key: 'g',
          Code: 'A',
        })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await c
      .entity('Catalog_X', '00000000-0000-0000-0000-00000000000a')
      .withHeader('1C_OData-DataLoadMode', 'true')
      .patch({ Code: 'A' })
    expect(dataLoadMode).toBe('true')
  })

  it('multiple withHeader calls accumulate', async () => {
    let h1: string | null = null
    let h2: string | null = null
    server.use(
      http.patch(/Catalog_X\(guid'00000000-0000-0000-0000-00000000000a'\)/, async ({ request }) => {
        h1 = request.headers.get('x-custom-1')
        h2 = request.headers.get('x-custom-2')
        return HttpResponse.json({
          'odata.metadata': `${baseUrl}/$metadata#Catalog_X/@Element`,
          Ref_Key: 'g',
        })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await c
      .entity('Catalog_X', '00000000-0000-0000-0000-00000000000a')
      .withHeader('X-Custom-1', 'a')
      .withHeader('X-Custom-2', 'b')
      .patch({})
    expect(h1).toBe('a')
    expect(h2).toBe('b')
  })
})

describe('V3EntityHandle — composite key per call', () => {
  it('follows the key object across calls on a reused handle', async () => {
    const urls: string[] = []
    server.use(
      http.delete(/InformationRegister_X\(.*\)/, ({ request }) => {
        urls.push(decodeURIComponent(request.url))
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    const key = { Period: 'A' }
    const handle = c.entity('InformationRegister_X', key)
    await handle.delete()
    key.Period = 'B'
    await handle.delete()
    expect(urls.map((u) => u.match(/Period='(\w)'/)?.[1])).toEqual(['A', 'B'])
  })

  it('aims the expectVersion check and the mutation at the same row within one call', async () => {
    const key = { Period: 'A' }
    const deleted: string[] = []
    server.use(
      http.get(/InformationRegister_X\(.*\)/, () => {
        key.Period = 'B' // the caller changes its object while the check is in flight
        return HttpResponse.json({ DataVersion: 'v1' })
      }),
      http.delete(/InformationRegister_X\(.*\)/, ({ request }) => {
        deleted.push(decodeURIComponent(request.url))
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await c.entity('InformationRegister_X', key).delete({ expectVersion: 'v1' })
    expect(deleted[0]).toContain("(Period='A')")
  })

  it('keeps a Date key value fixed within one call, even if the caller mutates it (#194)', async () => {
    const period = new Date('2024-12-31T21:00:00Z') // 2025-01-01 00:00 Moscow
    const urls: string[] = []
    server.use(
      http.get(/InformationRegister_X\(.*\)/, ({ request }) => {
        urls.push(decodeURIComponent(request.url))
        period.setTime(Date.parse('2025-01-31T21:00:00Z')) // reused Date moves while the check is in flight
        return HttpResponse.json({ DataVersion: 'v1' })
      }),
      http.delete(/InformationRegister_X\(.*\)/, ({ request }) => {
        urls.push(decodeURIComponent(request.url))
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await c.entity('InformationRegister_X', { Period: period }).delete({ expectVersion: 'v1' })
    expect(urls.map((u) => u.match(/Period=datetime'([^']+)'/)?.[1])).toEqual([
      '2025-01-01T00:00:00',
      '2025-01-01T00:00:00',
    ])
  })
})
