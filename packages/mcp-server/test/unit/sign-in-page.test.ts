// test/unit/sign-in-page.test.ts
import type { Request, Response } from 'express'
import { describe, expect, it } from 'vitest'
import { makeSignInPage } from '../../src/auth/pages/sign-in.js'

/** Render the sign-in page (no first-run probe) to its HTML string. */
async function render(): Promise<string> {
  let html = ''
  const res = {
    status() {
      return this
    },
    type() {
      return this
    },
    send(body: string) {
      html = body
      return this
    },
  } as unknown as Response
  await makeSignInPage()({} as Request, res)
  return html
}

describe('sign-in page resume target', () => {
  it('resumes /oauth2/authorize only when an authorize request is in progress (client_id present)', async () => {
    const html = await render()
    expect(html).toContain("q.get('client_id')")
    expect(html).toContain("'/api/auth/oauth2/authorize' + window.location.search")
  })

  it('lands a bare sign-in (no next, no client_id) on /admin, not the param-less authorize endpoint', async () => {
    const html = await render()
    expect(html).toContain("return '/admin'")
  })

  it('keeps the open-redirect guard on next (single leading slash, not protocol-relative //)', async () => {
    const html = await render()
    expect(html).toContain("next[0] === '/' && next[1] !== '/'")
  })
})
