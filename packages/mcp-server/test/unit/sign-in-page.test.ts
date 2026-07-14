// test/unit/sign-in-page.test.ts
import { describe, expect, it } from 'vitest'
import { RESUME_TARGET_FN } from '../../src/auth/pages/sign-in.js'

// Compile the EXACT source string shipped to the browser and exercise it in Node
// (URLSearchParams + URL are globals in both), so these assert real behavior — one
// source of truth, not brittle substring matching.
const resumeTarget = new Function(`${RESUME_TARGET_FN}\nreturn resumeTarget;`)() as (
  search: string,
  origin: string,
) => string

const ORIGIN = 'https://mcp.example.com'

describe('resumeTarget (sign-in resume resolver)', () => {
  it('resumes the OAuth authorize flow verbatim when a client_id is present', () => {
    expect(resumeTarget('?client_id=abc&scope=mcp:read', ORIGIN)).toBe(
      '/api/auth/oauth2/authorize?client_id=abc&scope=mcp:read',
    )
  })

  it('lands a bare sign-in (no next, no client_id) on /admin, not the param-less authorize endpoint', () => {
    expect(resumeTarget('', ORIGIN)).toBe('/admin')
  })

  it('honors a safe same-origin next path (with query + hash preserved)', () => {
    expect(resumeTarget('?next=/admin/bases', ORIGIN)).toBe('/admin/bases')
    expect(resumeTarget('?next=/admin?tab=1', ORIGIN)).toBe('/admin?tab=1')
  })

  it('prefers a safe next over the authorize resume', () => {
    expect(resumeTarget('?next=/admin/users&client_id=abc', ORIGIN)).toBe('/admin/users')
  })

  // Open-redirect guard: every cross-origin smuggling form must fall through to /admin.
  it('rejects a protocol-relative next (//host)', () => {
    expect(resumeTarget('?next=//evil.example.com', ORIGIN)).toBe('/admin')
  })

  it('rejects the backslash protocol-relative form (/\\host) — browsers normalize \\ to /', () => {
    expect(resumeTarget('?next=/\\evil.example.com', ORIGIN)).toBe('/admin')
  })

  it('rejects a tab-smuggled protocol-relative next (/<TAB>/host)', () => {
    expect(resumeTarget('?next=/%09/evil.example.com', ORIGIN)).toBe('/admin')
  })

  it('rejects a scheme URI in next (javascript:, https://other-host)', () => {
    expect(resumeTarget('?next=javascript:alert(1)', ORIGIN)).toBe('/admin')
    expect(resumeTarget('?next=https://evil.example.com/x', ORIGIN)).toBe('/admin')
  })
})
