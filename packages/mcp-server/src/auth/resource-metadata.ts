// src/auth/resource-metadata.ts
import type { CanonicalUrls } from './config.js'

/**
 * RFC 9728 Protected Resource Metadata document for our MCP resource. Hand-built
 * (not via the SDK's mcpAuthMetadataRouter, which would couple us to a full
 * AS-metadata object) — it only needs to point clients at the AS. The `resource`
 * field is our MCP resource id; `authorization_servers` lists our AS issuer.
 */
export interface ProtectedResourceMetadata {
  resource: string
  authorization_servers: string[]
  scopes_supported: string[]
  bearer_methods_supported: string[]
  resource_name: string
}

export function buildResourceMetadata(urls: CanonicalUrls): ProtectedResourceMetadata {
  return {
    resource: urls.mcpResourceUrl,
    authorization_servers: [urls.issuer],
    scopes_supported: ['mcp:read'],
    bearer_methods_supported: ['header'],
    resource_name: '1C OData MCP server',
  }
}

/**
 * The canonical PRM URL for our resource: RFC 9728 path-suffix form
 * `/.well-known/oauth-protected-resource/mcp`. Matches the MCP SDK's
 * `getOAuthProtectedResourceMetadataUrl(new URL(`${publicUrl}/mcp`))`.
 */
export function resourceMetadataUrl(urls: CanonicalUrls): string {
  return `${urls.publicUrl}/.well-known/oauth-protected-resource/mcp`
}
