import { describe, expect, it } from 'vitest'
import { parseConnectionUrl } from '../../src/connection.js'
import { InvalidArgumentError } from '../../src/errors.js'

describe('parseConnectionUrl', () => {
  it('splits user:pwd@host into baseUrl + auth', () => {
    const r = parseConnectionUrl('http://u:p@example.test/odata')
    expect(r.baseUrl).toBe('http://example.test/odata')
    expect(r.auth).toEqual({ username: 'u', password: 'p' })
  })

  it('preserves port in baseUrl host', () => {
    const r = parseConnectionUrl('http://u:p@host.example:8080/path')
    expect(r.baseUrl).toBe('http://host.example:8080/path')
  })

  it('preserves query string', () => {
    const r = parseConnectionUrl('http://u:p@host/odata?$format=json')
    expect(r.baseUrl).toBe('http://host/odata?$format=json')
  })

  it('strips trailing slash from pathname', () => {
    const r = parseConnectionUrl('http://u:p@host/odata/')
    expect(r.baseUrl).toBe('http://host/odata')
  })

  it('strips multiple trailing slashes', () => {
    const r = parseConnectionUrl('http://u:p@host/odata///')
    expect(r.baseUrl).toBe('http://host/odata')
  })

  it('drops hash fragment', () => {
    const r = parseConnectionUrl('http://u:p@host/odata#frag')
    expect(r.baseUrl).toBe('http://host/odata')
  })

  it('decodes percent-encoded credentials', () => {
    const r = parseConnectionUrl('http://u:p%40ss%21@host/x')
    expect(r.auth.password).toBe('p@ss!')
  })

  it('decodes percent-encoded username', () => {
    const r = parseConnectionUrl('http://%D0%BF%D0%B0%D0%B2%D0%B5%D0%BB:p@host/x')
    expect(r.auth.username).toBe('павел')
  })

  it('throws when URL has no userinfo', () => {
    expect(() => parseConnectionUrl('http://host/odata')).toThrow(/credentials in user:password@host/)
  })

  it('throws when URL has only username (no password)', () => {
    expect(() => parseConnectionUrl('http://u@host/x')).toThrow(/credentials in user:password@host/)
  })

  it('throws InvalidArgumentError on malformed URL', () => {
    expect(() => parseConnectionUrl('not a url')).toThrow(InvalidArgumentError)
  })

  it('error message does not leak URL contents', () => {
    let caught: unknown
    try {
      parseConnectionUrl('http://leaked-secret@example/x')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    const msg = (caught as Error).message
    expect(msg).not.toContain('leaked-secret')
    expect(msg).not.toContain('example')
  })

  it('error message does not leak URL contents (malformed input)', () => {
    let caught: unknown
    try {
      parseConnectionUrl('http://[leaked-secret-host')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(InvalidArgumentError)
    const msg = (caught as Error).message
    expect(msg).not.toContain('leaked-secret-host')
  })

  it('handles https scheme', () => {
    const r = parseConnectionUrl('https://u:p@host/x')
    expect(r.baseUrl).toBe('https://host/x')
  })
})
