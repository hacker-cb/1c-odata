import { describe, expect, it } from 'vitest'
import { normalizeBaseUrl } from '../../../src/url-builder.js'

describe('normalizeBaseUrl', () => {
  it('returns input unchanged when no trailing slash', () => {
    expect(normalizeBaseUrl('http://x/p')).toBe('http://x/p')
  })

  it('strips a single trailing slash', () => {
    expect(normalizeBaseUrl('http://x/p/')).toBe('http://x/p')
  })

  it('strips multiple trailing slashes', () => {
    expect(normalizeBaseUrl('http://x/p///')).toBe('http://x/p')
  })

  it('handles empty string', () => {
    expect(normalizeBaseUrl('')).toBe('')
  })

  it('handles a string of only slashes', () => {
    expect(normalizeBaseUrl('////')).toBe('')
  })

  it('preserves query strings', () => {
    expect(normalizeBaseUrl('http://x/p?q=1')).toBe('http://x/p?q=1')
  })
})
