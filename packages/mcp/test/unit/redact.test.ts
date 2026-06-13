import { describe, expect, it } from 'vitest'
import { errorText, redactSecrets, stripUrlUserinfo } from '../../src/redact.js'

describe('redactSecrets', () => {
  it('masks userinfo in a URL', () => {
    expect(redactSecrets('GET http://user:p%40ss@host/odata failed')).toBe('GET http://***@host/odata failed')
  })

  it('leaves credential-free URLs intact', () => {
    expect(redactSecrets('GET http://host/odata 401')).toBe('GET http://host/odata 401')
  })

  it('masks every URL in the string', () => {
    expect(redactSecrets('a https://u:pw@h1 b http://x:y@h2')).toBe('a https://***@h1 b http://***@h2')
  })

  it('masks a password that itself contains @', () => {
    expect(redactSecrets('connect http://user:p@ss@host/odata failed')).toBe('connect http://***@host/odata failed')
  })
})

describe('errorText', () => {
  it('redacts the message of an Error', () => {
    expect(errorText(new Error('connect http://u:pw@h failed'))).toBe('connect http://***@h failed')
  })

  it('stringifies and redacts non-errors', () => {
    expect(errorText('http://u:pw@h')).toBe('http://***@h')
  })
})

describe('stripUrlUserinfo', () => {
  it('removes userinfo from a URL', () => {
    expect(stripUrlUserinfo('http://user:pass@host/odata/standard.odata')).toBe('http://host/odata/standard.odata')
  })

  it('leaves a credential-free URL unchanged', () => {
    expect(stripUrlUserinfo('http://host/odata/')).toBe('http://host/odata/')
  })

  it('returns non-URL input unchanged', () => {
    expect(stripUrlUserinfo('not a url')).toBe('not a url')
  })
})
