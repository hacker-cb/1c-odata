import { describe, expect, it } from 'vitest'
import { classifyProbe } from '../../src/http/admin/bases.js'

describe('classifyProbe', () => {
  it('classifies auth-ish errors as auth_failed, including suffixed word forms', () => {
    // The regression this guards: a trailing `\b` used to miss these mid-word forms.
    for (const m of [
      'HTTP 401',
      '403 Forbidden',
      'Unauthorized',
      'Unauthorised',
      'invalid credentials',
      'bad password',
    ]) {
      expect(classifyProbe(new Error(m)).status, m).toBe('auth_failed')
    }
  })

  it('classifies non-auth errors as unreachable', () => {
    for (const m of ['ECONNREFUSED', 'getaddrinfo ENOTFOUND host', 'socket hang up', 'HTTP 500']) {
      expect(classifyProbe(new Error(m)).status, m).toBe('unreachable')
    }
  })

  it('does not match a numeric code embedded in a larger number', () => {
    expect(classifyProbe(new Error('request id 14013 failed')).status).toBe('unreachable')
  })

  it('redacts URLs from the surfaced message', () => {
    const { message } = classifyProbe(new Error('GET https://secret.example/odata/$metadata failed 401'))
    expect(message).not.toContain('secret.example')
    expect(message).toContain('<url>')
  })
})
