import { BasicAuth } from '@1c-odata/client'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { fetchMetadata } from '../../src/fetcher.js'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())
beforeEach(() => server.resetHandlers())

describe('fetchMetadata', () => {
  it('GETs <baseUrl>/$metadata with Basic auth', async () => {
    let receivedAuth: string | null = null
    server.use(
      http.get('http://example.test/odata/$metadata', ({ request }) => {
        receivedAuth = request.headers.get('authorization')
        return new HttpResponse('<edmx:Edmx/>', {
          status: 200,
          headers: { 'Content-Type': 'application/xml' },
        })
      }),
    )
    const xml = await fetchMetadata({
      baseUrl: 'http://example.test/odata',
      auth: BasicAuth({ username: 'u', password: 'p' }),
      timeout: 30_000,
    })
    expect(xml).toBe('<edmx:Edmx/>')
    expect(receivedAuth).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`)
  })

  it('throws on non-2xx with helpful message', async () => {
    server.use(
      http.get('http://example.test/odata/$metadata', () => HttpResponse.text('Unauthorized', { status: 401 })),
    )
    await expect(
      fetchMetadata({
        baseUrl: 'http://example.test/odata',
        auth: BasicAuth({ username: 'u', password: 'p' }),
        timeout: 30_000,
      }),
    ).rejects.toThrow(/401/)
  })

  it('strips trailing slash from baseUrl', async () => {
    let url: string | null = null
    server.use(
      http.get('http://example.test/odata/$metadata', ({ request }) => {
        url = request.url
        return HttpResponse.text('<edmx:Edmx/>', { status: 200 })
      }),
    )
    await fetchMetadata({
      baseUrl: 'http://example.test/odata/',
      auth: BasicAuth({ username: 'u', password: 'p' }),
      timeout: 30_000,
    })
    expect(url).toBe('http://example.test/odata/$metadata')
  })
})
