// src/auth/resource-metadata.ts
import type { CanonicalUrls } from './config.js'

/**
 * The scope set required on `/mcp` when the operator configures none. SINGLE source
 * of truth for the default: the bearer gate (auth-mount.ts) enforces it and the PRM
 * below advertises it, so the two can never drift — a client reading discovery asks
 * for exactly the scope the gate will check.
 */
export const DEFAULT_REQUIRED_SCOPES = ['mcp:read']

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

/**
 * `requiredScopes` MUST be the same set the bearer gate enforces — advertising a
 * scope the gate does not check (or omitting one it does) would make a
 * spec-compliant client request the wrong scope and then fail authorization.
 */
export function buildResourceMetadata(
  urls: CanonicalUrls,
  requiredScopes: string[] = DEFAULT_REQUIRED_SCOPES,
): ProtectedResourceMetadata {
  return {
    resource: urls.mcpResourceUrl,
    authorization_servers: [urls.issuer],
    scopes_supported: [...requiredScopes],
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
