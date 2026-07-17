// src/http/app.ts
import type { ReadPool } from '@1c-odata/mcp/internal'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import express, { type Express, type RequestHandler } from 'express'
import type { Auth } from '../auth/better-auth.js'
import type { CanonicalUrls } from '../auth/config.js'
import type { Keyring } from '../store/crypto.js'
import type { AuthDb } from '../store/db.js'
import { createAccountRouter } from './account/router.js'
import { createAdminRouter } from './admin/router.js'
import { createDiscoveryRouter } from './discovery.js'
import { createMcpRouter } from './mcp-route.js'
import type { SessionRegistry, SessionTuning } from './session-registry.js'
import { createSetupRouter } from './setup/router.js'

/** Optional auth wiring. When present, /mcp is gated and discovery + BA are mounted. */
export interface AppAuthOptions {
  auth: Auth
  urls: CanonicalUrls
  /** better-auth handler + login/consent pages; mounted at root BEFORE express.json(). */
  authRouter: RequestHandler
  /** requireBearerAuth; mounted on /mcp BEFORE the MCP router. */
  bearerMiddleware: RequestHandler
  /**
   * Scopes required on /mcp — forwarded to the discovery router so the PRM's
   * `scopes_supported` matches what `bearerMiddleware` enforces. Omit for the default.
   */
  requiredScopes?: string[]
  /**
   * Tenancy handles carried through app.ts UNTOUCHED (the route never reads them —
   * index.ts owns the db lifecycle and builds the per-session ScopedPool closure
   * directly). Present only on the tenancy path; kept on this type so future admin
   * routes (grant CRUD, secret writes) can read `db`/`keyring` off the mounted auth
   * options without re-plumbing. Both optional (auth-without-tenancy omits them).
   */
  db?: AuthDb
  keyring?: Keyring
  /** Process-global ConnectionPool — admin base edits call refresh() on it. Present with tenancy. */
  sharedPool?: ReadPool
  /** Server version, forwarded to the admin dashboard's DB-aware server_info. */
  version?: string
  /** The health job's guarded runOnce — lets the admin "check now" button share the job's in-flight guard. */
  onDemandHealthCheck?: () => Promise<void>
}

export interface CreateAppOptions {
  /** Builds a fresh McpServer per session, given the authenticated subject (undefined on the no-auth path). */
  buildServer: (ctx: { sub: string | undefined }) => McpServer
  /** Forwarded to the MCP router — `Host` allowlist for DNS-rebinding protection. */
  allowedHosts?: string[]
  /** Forwarded to the MCP router — session cap + idle-sweep tuning. */
  sessions?: SessionTuning
  /** When set, mounts the auth layer (Slice 2). Omit to keep the no-auth server. */
  auth?: AppAuthOptions
}

/** The built Express app plus the {@link SessionRegistry} backing /mcp (caller `stop()`s its sweeper on shutdown). */
export interface BuiltApp {
  app: Express
  sessions: SessionRegistry
}

/**
 * Build the Express app. Mount order is load-bearing:
 *   1. better-auth handler (splat) + login/consent pages — BEFORE express.json()
 *      so better-auth reads the raw body.
 *   2. express.json() — for /mcp and /healthz.
 *   3. root discovery routers (PRM + AS metadata, CORS-open).
 *   4. /mcp: requireBearerAuth THEN the MCP router.
 */
export function createApp(opts: CreateAppOptions): BuiltApp {
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
    app.use(
      createDiscoveryRouter({
        auth: opts.auth.auth,
        urls: opts.auth.urls,
        ...(opts.auth.requiredScopes !== undefined ? { requiredScopes: opts.auth.requiredScopes } : {}),
      }),
    )
  }

  // (3.5) Admin panel + first-run setup wizard — only on the tenancy path (needs
  // db + keyring + shared pool). Both gate on the SAME condition that mounts /admin.
  if (opts.auth?.db !== undefined && opts.auth.keyring !== undefined && opts.auth.sharedPool !== undefined) {
    // /setup: the one-time, token-gated first-admin wizard. It self-closes (404s)
    // once any admin exists, so mounting it unconditionally here is safe.
    app.use(
      '/setup',
      createSetupRouter({
        auth: opts.auth.auth,
        db: opts.auth.db,
        publicUrl: opts.auth.urls.publicUrl,
      }),
    )
    app.use(
      '/admin',
      createAdminRouter({
        auth: opts.auth.auth,
        db: opts.auth.db,
        keyring: opts.auth.keyring,
        sharedPool: opts.auth.sharedPool,
        version: opts.auth.version ?? '0.0.0',
        publicUrl: opts.auth.urls.publicUrl,
        ...(opts.auth.onDemandHealthCheck !== undefined ? { onDemandHealthCheck: opts.auth.onDemandHealthCheck } : {}),
      }),
    )
    // /account: self-service (change own password) + sign-out, for EVERY
    // signed-in role — the admin panel's non-admin sibling.
    app.use(
      '/account',
      createAccountRouter({
        auth: opts.auth.auth,
        publicUrl: opts.auth.urls.publicUrl,
      }),
    )
  }

  // (4) /mcp: bearer gate before the MCP router (when auth is enabled).
  const mcpMiddleware: RequestHandler[] = opts.auth !== undefined ? [opts.auth.bearerMiddleware] : []
  const mcp = createMcpRouter({
    buildServer: opts.buildServer,
    ...(opts.allowedHosts !== undefined ? { allowedHosts: opts.allowedHosts } : {}),
    ...(opts.sessions !== undefined ? { sessions: opts.sessions } : {}),
  })
  app.use('/mcp', ...mcpMiddleware, mcp.router)

  return { app, sessions: mcp.sessions }
}
