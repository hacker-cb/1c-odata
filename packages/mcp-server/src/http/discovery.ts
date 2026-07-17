// src/http/discovery.ts
import { oauthProviderAuthServerMetadata } from '@better-auth/oauth-provider'
import { type Request, type Response, Router } from 'express'
import type { Auth } from '../auth/better-auth.js'
import type { CanonicalUrls } from '../auth/config.js'
import { buildResourceMetadata } from '../auth/resource-metadata.js'

export interface DiscoveryOptions {
  auth: Auth
  urls: CanonicalUrls
  /**
   * Scopes required on `/mcp` — advertised verbatim in the PRM's `scopes_supported`.
   * MUST match what the bearer gate enforces (createAuthMount). Omit for the default.
   */
  requiredScopes?: string[]
}

/**
 * Root-mounted discovery + CORS. Well-known endpoints, all GET, all CORS-open
 * (public, unauthenticated — MCP clients fetch them cross-origin before they have
 * any token):
 *
 *   GET /.well-known/oauth-protected-resource/mcp            → RFC 9728 PRM (our resource)
 *   GET /.well-known/oauth-authorization-server              → RFC 8414 AS metadata (root)
 *   GET /.well-known/oauth-authorization-server/api/auth     → RFC 8414 AS metadata (issuer path-suffix)
 *
 * The AS-metadata route delegates to better-auth's own handler
 * (oauthProviderAuthServerMetadata → a `(Request)=>Promise<Response>`), so the
 * jwks_uri / endpoints it advertises always match the live plugin config. We
 * mount it at the root AND at the issuer path-suffix: our PRM advertises the
 * issuer as `${publicUrl}/api/auth`, so an RFC 8414 client that appends its
 * suffix looks for `/.well-known/oauth-authorization-server/api/auth`. Serving
 * both makes discovery work for clients without a root/OIDC fallback.
 */
export function createDiscoveryRouter(opts: DiscoveryOptions): Router {
  const router = Router()
  const prm = buildResourceMetadata(opts.urls, opts.requiredScopes)
  const asMetadataHandler = oauthProviderAuthServerMetadata(opts.auth)

  // Permissive CORS for the well-known docs only.
  const cors = (_req: Request, res: Response, next: () => void): void => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    next()
  }

  router.options('/.well-known/oauth-protected-resource/mcp', cors, (_req, res) => res.sendStatus(204))
  router.get('/.well-known/oauth-protected-resource/mcp', cors, (_req, res) => {
    res.status(200).json(prm)
  })

  // Serve the AS metadata via better-auth's handler. The handler ignores the
  // request path (it always emits the same document), so the same closure backs
  // both the root and the issuer-path-suffix mounts.
  const serveAsMetadata = async (req: Request, res: Response): Promise<void> => {
    // Reconstruct a WHATWG Request for better-auth's fetch-style handler.
    const url = `${opts.urls.publicUrl}${req.originalUrl}`
    const response = await asMetadataHandler(new Request(url, { method: 'GET' }))
    res.status(response.status)
    response.headers.forEach((v, k) => {
      res.setHeader(k, v)
    })
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.send(response.body ? Buffer.from(await response.arrayBuffer()) : undefined)
  }

  for (const path of [
    '/.well-known/oauth-authorization-server',
    // Issuer path-suffix form (issuer === `${publicUrl}/api/auth`) per RFC 8414 §3.
    '/.well-known/oauth-authorization-server/api/auth',
  ]) {
    router.options(path, cors, (_req, res) => res.sendStatus(204))
    router.get(path, cors, serveAsMetadata)
  }

  return router
}
