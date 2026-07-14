// test/unit/sign-in-page.test.ts
import { describe, expect, it } from 'vitest'
import { RESUME_TARGET_FN } from '../../src/auth/pages/sign-in.js'

// Compile the EXACT source string shipped to the browser and exercise it in Node
// (URLSearchParams is a global in both), so these assert real behavior — one
// source of truth, not brittle substring matching.
const resumeTarget = new Function(`${RESUME_TARGET_FN}\nreturn resumeTarget;`)() as (search: string) => string

describe('resumeTarget (sign-in resume resolver)', () => {
  it('resumes the OAuth authorize flow verbatim when a client_id is present', () => {
    expect(resumeTarget('?client_id=abc&scope=mcp:read')).toBe(
      '/api/auth/oauth2/authorize?client_id=abc&scope=mcp:read',
    )
  })

  it('lands a bare sign-in (no next, no client_id) on /admin, not the param-less authorize endpoint', () => {
    expect(resumeTarget('')).toBe('/admin')
  })

  it('honors a safe same-origin next path', () => {
    expect(resumeTarget('?next=/admin/bases')).toBe('/admin/bases')
  })

  it('rejects a protocol-relative next (open-redirect guard) and falls through to /admin', () => {
    expect(resumeTarget('?next=//evil.example.com')).toBe('/admin')
  })

  it('prefers a safe next over the authorize resume', () => {
    expect(resumeTarget('?next=/admin/users&client_id=abc')).toBe('/admin/users')
  })
})
