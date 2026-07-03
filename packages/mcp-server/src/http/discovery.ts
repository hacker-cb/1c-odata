// src/http/discovery.ts
import { oauthProviderAuthServerMetadata } from '@better-auth/oauth-provider'
import { type Request, type Response, Router } from 'express'
import type { Auth } from '../auth/better-auth.js'
import type { CanonicalUrls } from '../auth/config.js'
import { buildResourceMetadata } from '../auth/resource-metadata.js'

export interface DiscoveryOptions {
  auth: Auth
  urls: CanonicalUrls
}

/**
 * Root-mounted discovery + CORS. Two well-known endpoints, both GET, both
 * CORS-open (public, unauthenticated — MCP clients fetch them cross-origin
 * before they have any token):
 *
 *   GET /.well-known/oauth-protected-resource/mcp  → RFC 9728 PRM (our resource)
 *   GET /.well-known/oauth-authorization-server    → RFC 8414 AS metadata
 *
 * The AS-metadata route delegates to better-auth's own handler
 * (oauthProviderAuthServerMetadata → a `(Request)=>Promise<Response>`), so the
 * jwks_uri / endpoints it advertises always match the live plugin config. We
 * mount it manually at the root because better-auth serves it under /api/auth,
 * but clients look for it at the origin root.
 */
export function createDiscoveryRouter(opts: DiscoveryOptions): Router {
  const router = Router()
  const prm = buildResourceMetadata(opts.urls)
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

  router.options('/.well-known/oauth-authorization-server', cors, (_req, res) => res.sendStatus(204))
  router.get('/.well-known/oauth-authorization-server', cors, async (req: Request, res: Response) => {
    // Reconstruct a WHATWG Request for better-auth's fetch-style handler.
    const url = `${opts.urls.publicUrl}${req.originalUrl}`
    const response = await asMetadataHandler(new Request(url, { method: 'GET' }))
    res.status(response.status)
    response.headers.forEach((v, k) => {
      res.setHeader(k, v)
    })
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.send(response.body ? Buffer.from(await response.arrayBuffer()) : undefined)
  })

  return router
}
