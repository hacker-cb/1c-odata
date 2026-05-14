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
      http.put(/Catalog_X\(guid'g'\)/, async ({ request }) => {
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
      .entity<{ Ref_Key: string; Code: string; Description: string; DataVersion: string }>('Catalog_X', 'g')
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
      http.delete(/Catalog_X\(guid'g'\)/, () => new HttpResponse(null, { status: 204 })),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await expect(c.entity('Catalog_X', 'g').delete()).resolves.toBeUndefined()
  })
})

describe('V3EntityHandle.markForDeletion / unmarkForDeletion', () => {
  it('markForDeletion sends PATCH { DeletionMark: true }', async () => {
    let received: unknown
    server.use(
      // NOTE: regex matcher — MSW's path-to-regexp interprets `(` in string
      // templates as parameter syntax, so a string template never matches a
      // URL containing parens (e.g. `Catalog_X(guid'...')`).
      http.patch(/Catalog_X\(guid'g'\)/, async ({ request }) => {
        received = await request.json()
        return HttpResponse.json({
          'odata.metadata': `${baseUrl}/$metadata#Catalog_X/@Element`,
          Ref_Key: 'g',
          DeletionMark: true,
        })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    const r = await c.entity<{ Ref_Key: string; DeletionMark: boolean }>('Catalog_X', 'g').markForDeletion()
    expect(received).toEqual({ DeletionMark: true })
    expect(r.DeletionMark).toBe(true)
  })

  it('unmarkForDeletion sends PATCH { DeletionMark: false }', async () => {
    let received: unknown
    server.use(
      // NOTE: regex matcher — MSW's path-to-regexp interprets `(` in string
      // templates as parameter syntax, so a string template never matches a
      // URL containing parens (e.g. `Catalog_X(guid'...')`).
      http.patch(/Catalog_X\(guid'g'\)/, async ({ request }) => {
        received = await request.json()
        return HttpResponse.json({
          'odata.metadata': `${baseUrl}/$metadata#Catalog_X/@Element`,
          Ref_Key: 'g',
          DeletionMark: false,
        })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    const r = await c.entity<{ Ref_Key: string; DeletionMark: boolean }>('Catalog_X', 'g').unmarkForDeletion()
    expect(received).toEqual({ DeletionMark: false })
    expect(r.DeletionMark).toBe(false)
  })
})

describe('V3EntityHandle.withHeader', () => {
  it('adds custom header to PATCH request', async () => {
    let dataLoadMode: string | null = null
    server.use(
      // NOTE: regex matcher — see CRUD describes above for rationale.
      http.patch(/Catalog_X\(guid'g'\)/, async ({ request }) => {
        dataLoadMode = request.headers.get('1c_odata-dataloadmode')
        return HttpResponse.json({
          'odata.metadata': `${baseUrl}/$metadata#Catalog_X/@Element`,
          Ref_Key: 'g',
          Code: 'A',
        })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await c.entity('Catalog_X', 'g').withHeader('1C_OData-DataLoadMode', 'true').patch({ Code: 'A' })
    expect(dataLoadMode).toBe('true')
  })

  it('multiple withHeader calls accumulate', async () => {
    let h1: string | null = null
    let h2: string | null = null
    server.use(
      http.patch(/Catalog_X\(guid'g'\)/, async ({ request }) => {
        h1 = request.headers.get('x-custom-1')
        h2 = request.headers.get('x-custom-2')
        return HttpResponse.json({
          'odata.metadata': `${baseUrl}/$metadata#Catalog_X/@Element`,
          Ref_Key: 'g',
        })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await c.entity('Catalog_X', 'g').withHeader('X-Custom-1', 'a').withHeader('X-Custom-2', 'b').patch({})
    expect(h1).toBe('a')
    expect(h2).toBe('b')
  })
})
