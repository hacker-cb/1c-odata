// test/unit/resource-metadata.test.ts
//
// The PRM's advertised scopes must equal what the bearer gate enforces. If they
// drift, a spec-compliant client reads discovery, requests the advertised scope,
// and its token then fails the gate — so this pins the two to one source.
import { describe, expect, it } from 'vitest'
import { resolveCanonicalUrls } from '../../src/auth/config.js'
import { buildResourceMetadata, DEFAULT_REQUIRED_SCOPES } from '../../src/auth/resource-metadata.js'

const urls = resolveCanonicalUrls('https://mcp.example.com')

describe('buildResourceMetadata', () => {
  it('advertises the default scope when none is configured', () => {
    expect(buildResourceMetadata(urls).scopes_supported).toEqual(['mcp:read'])
    expect(DEFAULT_REQUIRED_SCOPES).toEqual(['mcp:read'])
  })

  it('the default is frozen — a stray mutation cannot silently change auth behavior', () => {
    expect(Object.isFrozen(DEFAULT_REQUIRED_SCOPES)).toBe(true)
  })

  it('advertises the CONFIGURED scopes verbatim, not the hard-coded default', () => {
    // An operator requiring a non-default scope: the PRM must reflect it, or a
    // client would ask for `mcp:read` and be rejected by the gate.
    expect(buildResourceMetadata(urls, ['mcp:admin']).scopes_supported).toEqual(['mcp:admin'])
    expect(buildResourceMetadata(urls, ['mcp:read', 'mcp:write']).scopes_supported).toEqual(['mcp:read', 'mcp:write'])
  })

  it('copies the scopes (a later mutation of the arg cannot rewrite a served document)', () => {
    const scopes = ['mcp:read']
    const prm = buildResourceMetadata(urls, scopes)
    scopes.push('mcp:admin')
    expect(prm.scopes_supported).toEqual(['mcp:read'])
  })

  it('points clients at our resource + AS issuer', () => {
    const prm = buildResourceMetadata(urls)
    expect(prm.resource).toBe(urls.mcpResourceUrl)
    expect(prm.authorization_servers).toEqual([urls.issuer])
    expect(prm.bearer_methods_supported).toEqual(['header'])
  })
})
