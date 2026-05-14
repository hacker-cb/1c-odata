import { BasicAuth, connectionAuth, InvalidArgumentError, validateConnection } from '@1c-odata/client'
import { describe, expect, it } from 'vitest'

describe('validateConnection', () => {
  const VALID = {
    baseUrl: 'https://example.com/odata/standard.odata/',
    auth: { username: 'u', password: 'p' },
    serverTimezone: 'Europe/Moscow',
  }

  it('passes for a valid connection', () => {
    expect(() => validateConnection(VALID)).not.toThrow()
  })

  it('throws when input is not an object', () => {
    for (const bad of [null, undefined, 'string', 42, true]) {
      expect(() => validateConnection(bad)).toThrow(InvalidArgumentError)
      expect(() => validateConnection(bad)).toThrow(/Connection must be an object/)
    }
  })

  it('throws on missing baseUrl', () => {
    expect(() => validateConnection({ ...VALID, baseUrl: '' })).toThrow(/baseUrl is required/)
  })

  it('throws on non-URL baseUrl without leaking the value into the message', () => {
    const e = expectThrow(() => validateConnection({ ...VALID, baseUrl: 'not a url' }))
    expect(e.message).not.toContain('not a url')
    expect(e.argument).toBe('baseUrl')
  })

  it('throws when baseUrl contains userinfo', () => {
    const e = expectThrow(() =>
      validateConnection({ ...VALID, baseUrl: 'https://leaked-user:leaked-pass@example.com/' }),
    )
    expect(e.message).toContain('must NOT contain credentials')
    expect(e.message).not.toContain('leaked-user')
    expect(e.message).not.toContain('leaked-pass')
  })

  it('throws on missing auth', () => {
    const { auth, ...rest } = VALID
    expect(() => validateConnection(rest)).toThrow(/auth is required/)
  })

  it('throws on empty auth.username', () => {
    expect(() => validateConnection({ ...VALID, auth: { username: '', password: 'p' } })).toThrow(
      /auth\.username must be a non-empty string/,
    )
  })

  it('throws on empty auth.password', () => {
    expect(() => validateConnection({ ...VALID, auth: { username: 'u', password: '' } })).toThrow(
      /auth\.password must be a non-empty string/,
    )
  })

  it('throws on missing serverTimezone', () => {
    const { serverTimezone, ...rest } = VALID
    const e = expectThrow(() => validateConnection(rest))
    expect(e.message).toContain('serverTimezone is required')
    expect(e.argument).toBe('serverTimezone')
  })

  it('throws on invalid IANA serverTimezone', () => {
    const e = expectThrow(() => validateConnection({ ...VALID, serverTimezone: 'FooBar/Baz' }))
    expect(e.message).toContain('not a valid IANA timezone')
    expect(e.received).toBe('FooBar/Baz')
  })

  it('accepts Asian timezones', () => {
    expect(() => validateConnection({ ...VALID, serverTimezone: 'Asia/Yekaterinburg' })).not.toThrow()
  })

  it('accepts optional shape field', () => {
    expect(() => validateConnection({ ...VALID, shape: { int64Mode: 'bigint', dateMode: 'date' } })).not.toThrow()
  })
})

describe('connectionAuth', () => {
  it('returns AuthOptions with proper Basic header', () => {
    const auth = connectionAuth({ auth: { username: 'admin', password: 'secret' } })
    // Basic base64('admin:secret') = 'YWRtaW46c2VjcmV0'
    expect(auth.header).toBe('Basic YWRtaW46c2VjcmV0')
  })

  it('does not mutate the input', () => {
    const input = { auth: { username: 'u', password: 'p' } }
    const before = JSON.stringify(input)
    connectionAuth(input)
    expect(JSON.stringify(input)).toBe(before)
  })

  it('produces the same header that BasicAuth does directly', () => {
    const viaHelper = connectionAuth({ auth: { username: 'u', password: 'p' } })
    const viaDirect = BasicAuth({ username: 'u', password: 'p' })
    expect(viaHelper.header).toBe(viaDirect.header)
  })
})

function expectThrow(fn: () => void): InvalidArgumentError {
  try {
    fn()
    throw new Error('expected throw')
  } catch (e) {
    if (e instanceof InvalidArgumentError) return e
    throw e
  }
}
