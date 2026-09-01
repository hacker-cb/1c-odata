// test/unit/auth-canonical-urls.test.ts
import { describe, expect, it } from 'vitest'
import { resolveCanonicalUrls } from '../../src/auth/config.js'

describe('resolveCanonicalUrls', () => {
  it('derives the origin-rooted URL set from a bare origin', () => {
    const u = resolveCanonicalUrls('https://mcp.example.com')
    expect(u.publicUrl).toBe('https://mcp.example.com')
    expect(u.authBaseUrl).toBe('https://mcp.example.com/api/auth')
    expect(u.issuer).toBe('https://mcp.example.com/api/auth')
    expect(u.mcpResourceUrl).toBe('https://mcp.example.com/mcp')
  })

  it('tolerates a single trailing slash (origin form)', () => {
    expect(resolveCanonicalUrls('https://mcp.example.com/').authBaseUrl).toBe('https://mcp.example.com/api/auth')
  })

  it('keeps an explicit non-default port', () => {
    expect(resolveCanonicalUrls('https://mcp.example.com:8443').mcpResourceUrl).toBe('https://mcp.example.com:8443/mcp')
  })

  it('rejects a non-empty path (codex-2: would mangle iss/aud into …/mcp/api/auth)', () => {
    expect(() => resolveCanonicalUrls('https://mcp.example.com/mcp')).toThrow(/bare origin/)
  })

  it('rejects a query string', () => {
    expect(() => resolveCanonicalUrls('https://mcp.example.com/?x=1')).toThrow(/bare origin/)
  })

  it('rejects embedded userinfo', () => {
    expect(() => resolveCanonicalUrls('https://user:pass@mcp.example.com')).toThrow(/bare origin/)
  })

  it('does not mangle a bare ?/# tail that URL normalizes away (derives from origin)', () => {
    // `new URL` empties search/hash for a bare `?`/`#`, so the reject guard passes —
    // deriving from parsed.origin (not the raw string) keeps auth URLs clean.
    for (const input of ['https://mcp.example.com/?', 'https://mcp.example.com/#']) {
      const u = resolveCanonicalUrls(input)
      expect(u.authBaseUrl).toBe('https://mcp.example.com/api/auth')
      expect(u.mcpResourceUrl).toBe('https://mcp.example.com/mcp')
    }
  })

  it('rejects a non-http(s) or empty value', () => {
    expect(() => resolveCanonicalUrls('ftp://mcp.example.com')).toThrow(/absolute http/)
    expect(() => resolveCanonicalUrls('')).toThrow(/absolute http/)
  })
})
