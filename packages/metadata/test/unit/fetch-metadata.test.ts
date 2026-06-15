import { BasicAuth, MetadataError } from '@1c-odata/client'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { fetchMetadataIndex, fetchMetadataXml } from '../../src/fetch.js'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())
beforeEach(() => server.resetHandlers())

describe('fetchMetadataXml', () => {
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
    const xml = await fetchMetadataXml({
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
      fetchMetadataXml({
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
    await fetchMetadataXml({
      baseUrl: 'http://example.test/odata/',
      auth: BasicAuth({ username: 'u', password: 'p' }),
      timeout: 30_000,
    })
    expect(url).toBe('http://example.test/odata/$metadata')
  })

  it('throws a helpful MetadataError when a 200 response is HTML, not EDMX', async () => {
    server.use(
      http.get(
        'http://example.test/odata/$metadata',
        () =>
          new HttpResponse('<!DOCTYPE html><html><body>Please log in</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          }),
      ),
    )
    expect.assertions(3)
    try {
      await fetchMetadataXml({
        baseUrl: 'http://example.test/odata',
        auth: BasicAuth({ username: 'u', password: 'p' }),
        timeout: 30_000,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(MetadataError)
      expect((e as Error).message).toMatch(/not XML/i)
      expect((e as MetadataError).request?.url).toBe('http://example.test/odata/$metadata')
    }
  })
})

describe('fetchMetadataIndex', () => {
  const conn = {
    baseUrl: 'http://example.test/odata',
    auth: { username: 'u', password: 'p' },
    serverTimezone: 'UTC',
  }

  it('attaches request context to a MetadataError from malformed (non-EDMX) XML', async () => {
    server.use(
      http.get('http://example.test/odata/$metadata', () =>
        HttpResponse.text('<NotEdmx/>', { status: 200, headers: { 'Content-Type': 'application/xml' } }),
      ),
    )
    expect.assertions(2)
    try {
      await fetchMetadataIndex(conn)
    } catch (e) {
      expect(e).toBeInstanceOf(MetadataError)
      expect((e as MetadataError).request?.url).toBe('http://example.test/odata/$metadata')
    }
  })
})
