import { describe, expect, it } from 'vitest'
import { publicUrlHostVariants, resolveAllowedHosts } from '../../src/cli.js'

const noEnv = {} as NodeJS.ProcessEnv

describe('resolveAllowedHosts', () => {
  it('derives bind + loopback aliases when no public URL is given', () => {
    const hosts = resolveAllowedHosts(noEnv, '127.0.0.1', 3000)
    expect(hosts).toContain('127.0.0.1:3000')
    expect(hosts).toContain('localhost:3000')
    expect(hosts).toContain('[::1]:3000')
    // Nothing external leaks into the allowlist without a --public-url.
    expect(hosts.some((h) => h.includes('example'))).toBe(false)
  })

  it('auto-allows the public origin Host (default https port dropped, plus the explicit form)', () => {
    const hosts = resolveAllowedHosts(noEnv, '0.0.0.0', 3000, 'https://mcp.example.com')
    // The Host a client actually sends for a default-port origin (443 omitted)...
    expect(hosts).toContain('mcp.example.com')
    // ...and the explicit form in case a proxy keeps the port.
    expect(hosts).toContain('mcp.example.com:443')
  })

  it('keeps a non-default public port', () => {
    const hosts = resolveAllowedHosts(noEnv, '0.0.0.0', 3000, 'https://mcp.example.com:8443')
    expect(hosts).toContain('mcp.example.com:8443')
  })

  it('an explicit ONEC_MCP_ALLOWED_HOSTS override wins verbatim (public host not appended)', () => {
    const env = { ONEC_MCP_ALLOWED_HOSTS: 'gw.internal:443, other:8080' } as unknown as NodeJS.ProcessEnv
    const hosts = resolveAllowedHosts(env, '0.0.0.0', 3000, 'https://mcp.example.com')
    expect(hosts).toEqual(['gw.internal:443', 'other:8080'])
  })
})

describe('publicUrlHostVariants', () => {
  it('returns [] for an unparseable URL', () => {
    expect(publicUrlHostVariants('not a url')).toEqual([])
  })

  it('drops a default port and adds the explicit form', () => {
    expect(publicUrlHostVariants('https://a.example')).toEqual(['a.example', 'a.example:443'])
    expect(publicUrlHostVariants('http://a.example')).toEqual(['a.example', 'a.example:80'])
  })

  it('preserves a non-default port and adds no default variant', () => {
    expect(publicUrlHostVariants('https://a.example:8443')).toEqual(['a.example:8443'])
  })

  it('still emits the portless form when the default port is written explicitly', () => {
    // URL normalizes :443/:80 away, so port === '' and BOTH forms are produced —
    // a client that omits the default port still matches.
    expect(publicUrlHostVariants('https://a.example:443')).toEqual(['a.example', 'a.example:443'])
    expect(publicUrlHostVariants('http://a.example:80')).toEqual(['a.example', 'a.example:80'])
  })

  it('keeps IPv6 hosts bracketed in both the bare and explicit-port forms', () => {
    // URL.hostname returns the bracketed literal, so the Host-header form is exact.
    expect(publicUrlHostVariants('https://[::1]')).toEqual(['[::1]', '[::1]:443'])
    expect(publicUrlHostVariants('https://[::1]:3000')).toEqual(['[::1]:3000'])
  })
})
