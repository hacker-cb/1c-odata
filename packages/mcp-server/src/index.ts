import { createServer, type Server } from 'node:http'
import { ConnectionPool, type ConnectionSource, type Limits, type ReadPool } from '@1c-odata/mcp/internal'
import { buildAuth } from './auth/better-auth.js'
import { resolveCanonicalUrls } from './auth/config.js'
import { createApp } from './http/app.js'
import { createAuthMount } from './http/auth-mount.js'
import { buildMcpServer } from './server-factory.js'
import { createDb, type Dialect } from './store/db.js'
import { runAuthMigrations } from './store/migrate.js'
import { readPackageVersion } from './version.js'

/** Auth configuration for the HTTP server. Absent → the no-auth Slice-1 server. */
export interface AuthServerOptions {
  /** External public origin (https). Derives `iss`, `aud`, PRM, discovery. */
  publicUrl: string
  /** better-auth store dialect: embedded pglite (dev) or node-postgres (prod). */
  dialect: Dialect
  /** BETTER_AUTH_SECRET; required in prod (better-auth throws in production if unset). */
  secret: string
  /** Extra trusted origins (e.g. the Claude connector). publicUrl is always trusted. */
  trustedOrigins?: string[]
  /** Scopes required on /mcp. Default ['mcp:read']. */
  requiredScopes?: string[]
}

export interface CreateHttpServerOptions {
  source: ConnectionSource
  dataDir: string
  version?: string
  limits?: Limits
  allowedHosts?: string[]
  maxSessions?: number
  /** When set, mount the auth layer (Slice 2). */
  auth?: AuthServerOptions
}

export interface HttpServerHandle {
  server: Server
  /** Release auth-store resources (pg pool). No-op without auth. */
  close(): Promise<void>
}

/**
 * Build the HTTP MCP server. Async because enabling auth provisions the
 * better-auth store (create DB → run migrations → build the AS) before wiring.
 * Returns an unstarted `http.Server` plus a `close()` that also tears down the
 * store. Without `opts.auth` this is the unchanged Slice-1 no-auth server.
 */
export async function createHttpServer(opts: CreateHttpServerOptions): Promise<HttpServerHandle> {
  const version = opts.version ?? readPackageVersion()
  const pool: ReadPool = new ConnectionPool(opts.source)
  const buildServer = () =>
    buildMcpServer(pool, {
      version,
      dataDir: opts.dataDir,
      ...(opts.limits !== undefined ? { limits: opts.limits } : {}),
    })

  if (opts.auth === undefined) {
    const app = createApp({
      buildServer,
      ...(opts.allowedHosts !== undefined ? { allowedHosts: opts.allowedHosts } : {}),
      ...(opts.maxSessions !== undefined ? { maxSessions: opts.maxSessions } : {}),
    })
    return { server: createServer(app), async close() {} }
  }

  const urls = resolveCanonicalUrls(opts.auth.publicUrl)
  const dbHandle = createDb(opts.auth.dialect)
  try {
    await runAuthMigrations(dbHandle)
    const auth = buildAuth({
      urls,
      db: dbHandle.db,
      secret: opts.auth.secret,
      ...(opts.auth.trustedOrigins !== undefined ? { trustedOrigins: opts.auth.trustedOrigins } : {}),
    })
    const { authRouter, bearerMiddleware } = createAuthMount({
      auth,
      urls,
      ...(opts.auth.requiredScopes !== undefined ? { requiredScopes: opts.auth.requiredScopes } : {}),
    })

    const app = createApp({
      buildServer,
      ...(opts.allowedHosts !== undefined ? { allowedHosts: opts.allowedHosts } : {}),
      ...(opts.maxSessions !== undefined ? { maxSessions: opts.maxSessions } : {}),
      auth: { auth, urls, authRouter, bearerMiddleware },
    })

    return {
      server: createServer(app),
      async close() {
        await dbHandle.close()
      },
    }
  } catch (err) {
    // A mid-boot failure (migration / AS build) must not leak the DB handle.
    await dbHandle.close()
    throw err
  }
}
