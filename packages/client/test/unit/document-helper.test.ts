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
const REF = '11111111-2222-3333-4444-555555555555'

describe('client.document(...).post / .unpost', () => {
  it('post(args) sends POST <set>(<ref>)/Post() with args', async () => {
    let url: string | null = null
    let method: string | null = null
    server.use(
      // URL contains parens — MSW path-to-regexp needs a regex matcher.
      http.post(new RegExp(`Document_%D0%A0%D0%A2%D0%A3\\(guid'${REF}'\\)\\/Post\\(\\)`), ({ request }) => {
        url = request.url
        method = request.method
        return HttpResponse.json({})
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await c.document('Document_РТУ', REF).post({ PostingModeOperational: false })
    expect(method).toBe('POST')
    expect(url).toContain('PostingModeOperational=false')
  })

  it('unpost() sends POST <set>(<ref>)/Unpost() with no args', async () => {
    let url: string | null = null
    server.use(
      http.post(new RegExp(`Document_%D0%A0%D0%A2%D0%A3\\(guid'${REF}'\\)\\/Unpost\\(\\)`), ({ request }) => {
        url = request.url
        return HttpResponse.json({})
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await c.document('Document_РТУ', REF).unpost()
    // undici encodes Cyrillic but leaves `'` unescaped in URL paths.
    expect(url).toContain(`Document_%D0%A0%D0%A2%D0%A3(guid'${REF}')/Unpost()`)
  })
})

describe('functions proxy: BusinessProcess.Start + Task.ExecuteTask (replaces removed BP/Task handles)', () => {
  it('functions.<BP>.Start({ ref }) sends POST <set>(<key>)/Start()', async () => {
    let url: string | null = null
    server.use(
      // URL contains parens — MSW path-to-regexp needs a regex matcher.
      http.post(new RegExp(`BusinessProcess_X\\(guid'${REF}'\\)\\/Start\\(\\)`), ({ request }) => {
        url = request.url
        return HttpResponse.json({})
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await c.functions.BusinessProcess_X.Start({ ref: REF })
    expect(url).toContain(`BusinessProcess_X(guid'${REF}')/Start()`)
  })

  it('functions.<Task>.ExecuteTask({ ref }) sends POST <set>(<key>)/ExecuteTask()', async () => {
    let url: string | null = null
    server.use(
      http.post(new RegExp(`Task_X\\(guid'${REF}'\\)\\/ExecuteTask\\(\\)`), ({ request }) => {
        url = request.url
        return HttpResponse.json({})
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await c.functions.Task_X.ExecuteTask({ ref: REF })
    expect(url).toContain(`Task_X(guid'${REF}')/ExecuteTask()`)
  })
})
