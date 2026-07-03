// src/http/app.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import express, { type Express, type RequestHandler } from 'express'
import type { Auth } from '../auth/better-auth.js'
import type { CanonicalUrls } from '../auth/config.js'
import { createDiscoveryRouter } from './discovery.js'
import { createMcpRouter } from './mcp-route.js'

/** Optional auth wiring. When present, /mcp is gated and discovery + BA are mounted. */
export interface AppAuthOptions {
  auth: Auth
  urls: CanonicalUrls
  /** better-auth handler + login/consent pages; mounted at root BEFORE express.json(). */
  authRouter: RequestHandler
  /** requireBearerAuth; mounted on /mcp BEFORE the MCP router. */
  bearerMiddleware: RequestHandler
}

export interface CreateAppOptions {
  /** Builds a fresh McpServer per session (captures the shared pool + version). */
  buildServer: () => McpServer
  /** Forwarded to the MCP router — `Host` allowlist for DNS-rebinding protection. */
  allowedHosts?: string[]
  /** Forwarded to the MCP router — max concurrent sessions. */
  maxSessions?: number
  /** When set, mounts the auth layer (Slice 2). Omit to keep the no-auth server. */
  auth?: AppAuthOptions
}

/**
 * Build the Express app. Mount order is load-bearing:
 *   1. better-auth handler (splat) + login/consent pages — BEFORE express.json()
 *      so better-auth reads the raw body.
 *   2. express.json() — for /mcp and /healthz.
 *   3. root discovery routers (PRM + AS metadata, CORS-open).
 *   4. /mcp: requireBearerAuth THEN the MCP router.
 */
export function createApp(opts: CreateAppOptions): Express {
  const app = express()

  // (1) Raw-body auth handler must precede the JSON parser.
  if (opts.auth !== undefined) {
    app.use(opts.auth.authRouter)
  }

  // (2) JSON body parser for the rest.
  app.use(express.json())

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok' })
  })

  // (3) Discovery at root (public, CORS-open).
  if (opts.auth !== undefined) {
    app.use(createDiscoveryRouter({ auth: opts.auth.auth, urls: opts.auth.urls }))
  }

  // (4) /mcp: bearer gate before the MCP router (when auth is enabled).
  const mcpMiddleware: RequestHandler[] = opts.auth !== undefined ? [opts.auth.bearerMiddleware] : []
  app.use(
    '/mcp',
    ...mcpMiddleware,
    createMcpRouter({
      buildServer: opts.buildServer,
      ...(opts.allowedHosts !== undefined ? { allowedHosts: opts.allowedHosts } : {}),
      ...(opts.maxSessions !== undefined ? { maxSessions: opts.maxSessions } : {}),
    }),
  )

  return app
}
