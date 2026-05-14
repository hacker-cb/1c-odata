import { existsSync, readFileSync } from 'node:fs'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runFetch } from '../../src/commands/fetch.js'
import { createTmpProject } from './helpers.js'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

describe('e2e: fetch via MSW', () => {
  let project: ReturnType<typeof createTmpProject>

  beforeEach(() => {
    project = createTmpProject()
    server.resetHandlers()
  })
  afterEach(() => {
    project.cleanup()
  })

  it('downloads $metadata and writes to metadata/<conn>.xml', async () => {
    server.use(
      http.get('http://example.test/odata/$metadata', ({ request }) => {
        const auth = request.headers.get('authorization')
        if (auth !== `Basic ${Buffer.from('user:secret').toString('base64')}`) {
          return HttpResponse.text('Unauthorized', { status: 401 })
        }
        return HttpResponse.text('<edmx:Edmx>real-edmx</edmx:Edmx>', { status: 200 })
      }),
    )

    await runFetch({
      cwd: project.tmp,
      config: {
        metadataDir: './metadata',
        connections: {
          trade_v11_5: {
            baseUrl: 'http://example.test/odata',
            auth: { username: 'user', password: 'secret' },
            serverTimezone: 'Europe/Moscow',
          },
        },
      },
    })

    expect(existsSync(`${project.tmp}/metadata/trade_v11_5.xml`)).toBe(true)
    expect(readFileSync(`${project.tmp}/metadata/trade_v11_5.xml`, 'utf8')).toBe('<edmx:Edmx>real-edmx</edmx:Edmx>')
  })

  it('throws on HTTP 401 with a helpful message', async () => {
    server.use(http.get('http://example.test/odata/$metadata', () => HttpResponse.text('nope', { status: 401 })))
    await expect(
      runFetch({
        cwd: project.tmp,
        config: {
          connections: {
            trade_v11_5: {
              baseUrl: 'http://example.test/odata',
              auth: { username: 'wrong', password: 'wrong' },
              serverTimezone: 'Europe/Moscow',
            },
          },
        },
      }),
    ).rejects.toThrow(/trade_v11_5/)
  })
})
