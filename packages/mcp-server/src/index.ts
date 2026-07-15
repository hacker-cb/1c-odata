import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { ConnectionPool, type ConnectionSource, type Limits, type ReadPool } from '@1c-odata/mcp/internal'
import type { Auth } from './auth/better-auth.js'
import { buildAuth } from './auth/better-auth.js'
import { resolveCanonicalUrls } from './auth/config.js'
import { type HealthJob, startHealthJob } from './http/admin/health-job.js'
import { createApp } from './http/app.js'
import { createAuthMount } from './http/auth-mount.js'
import { logger } from './logger.js'
import { buildMcpServer } from './server-factory.js'
import type { Keyring } from './store/crypto.js'
import type { AuthDb } from './store/db.js'
import { createDb, type Dialect } from './store/db.js'
import { runAuthMigrations } from './store/migrate.js'
import { BaseRepo, countAdmins, HealthRepo, SecretRepo, SetupTokenRepo } from './store/repos.js'
import { DbConnectionSource } from './tenancy/db-connection-source.js'
import { type GrantMap, resolveGrants } from './tenancy/grants.js'
import { ScopedPool } from './tenancy/scoped-pool.js'
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
  /**
   * Keyring for decrypting DB-backed secrets. Present → the auth path uses a
   * DbConnectionSource (multi-tenant) + per-session ScopedPools; the file `source`
   * is ignored. Absent → the auth path keeps the file source (auth without tenancy
   * — Slice-2 behavior).
   */
  keyring?: Keyring
}

export interface CreateHttpServerOptions {
  source: ConnectionSource
  dataDir: string
  version?: string
  limits?: Limits
  allowedHosts?: string[]
  maxSessions?: number
  /** When set, mount the auth layer (Slice 2); supply `auth.keyring` to add tenancy (Slice 3). */
  auth?: AuthServerOptions
}

export interface HttpServerHandle {
  server: Server
  /** Release auth-store resources (pg pool). No-op without auth. Idempotent. */
  close(): Promise<void>
  /**
   * The embedded better-auth instance — present only on the auth path. Exposed so
   * a caller (tests, an admin bootstrap) can drive `auth.api.*` (e.g. provision a
   * user through the admin plugin) against the SAME instance the gate verifies.
   */
  auth?: Auth
}

/**
 * First-run onboarding side effect: while NO admin exists, ensure a one-time
 * setup token and log the ready-to-open `/setup?token=…` URL at WARN level so it
 * stands out in the boot log. Idempotent per boot — the SAME token is kept across
 * restarts (see {@link SetupTokenRepo.ensure}) until the first admin is created.
 *
 * SECURITY: the token is logged ONLY here, and ONLY while no admin exists — once
 * onboarding is done the log line never appears again and `/setup` is 404. The
 * generated token is 32 random bytes (base64url), the same strength as a session
 * secret.
 */
async function announceFirstRunSetup(db: AuthDb, publicUrl: string): Promise<void> {
  if ((await countAdmins(db)) > 0) return // an admin exists → do NOT touch or log the token
  const tokenRepo = new SetupTokenRepo(db)
  const token = await tokenRepo.ensure(randomBytes(32).toString('base64url'))
  const url = `${publicUrl}/setup?token=${token}`
  logger.warn(
    { setupUrl: url },
    `FIRST-RUN SETUP: no administrator exists yet. Open this one-time URL to create the first admin: ${url}`,
  )
}

/**
 * Build the HTTP MCP server. Async because enabling auth provisions the
 * better-auth store (create DB → run migrations → build the AS) before wiring.
 * Returns an unstarted `http.Server` plus a `close()` that also tears down the
 * store. Without `opts.auth` this is the unchanged Slice-1 no-auth server; with
 * `auth.keyring` it adds DB-backed multi-tenancy.
 */
export async function createHttpServer(opts: CreateHttpServerOptions): Promise<HttpServerHandle> {
  const version = opts.version ?? readPackageVersion()

  // ---- No-auth path: unchanged Slice-1/2 behavior. Shared pool, no scoping. ----
  if (opts.auth === undefined) {
    const sharedPool: ReadPool = new ConnectionPool(opts.source)
    const buildServer = (_ctx: { sub: string | undefined }) =>
      buildMcpServer(sharedPool, {
        version,
        dataDir: opts.dataDir,
        ...(opts.limits !== undefined ? { limits: opts.limits } : {}),
      })
    const app = createApp({
      buildServer,
      ...(opts.allowedHosts !== undefined ? { allowedHosts: opts.allowedHosts } : {}),
      ...(opts.maxSessions !== undefined ? { maxSessions: opts.maxSessions } : {}),
    })
    return { server: createServer(app), async close() {} }
  }

  // ---- Auth path. ----
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

    // Tenancy is active only when a keyring is supplied. The shared ConnectionPool
    // (and its $metadata cache) is process-global; per-session ScopedPools front it.
    const keyring = opts.auth.keyring
    const db = dbHandle.db

    // First-run onboarding (tenancy path only — that is where /setup + /admin are
    // mounted). While NO admin exists, ensure a one-time setup token and log the
    // ready-to-open wizard URL PROMINENTLY. This re-runs on every boot so a restart
    // re-surfaces the URL until the first admin is created; the token is NEVER
    // logged once an admin exists.
    if (keyring !== undefined) {
      await announceFirstRunSetup(db, urls.publicUrl)
    }
    // `/sign-in` shows a "setup pending" hint (no token) while no admin exists.
    const firstRunCheck = keyring !== undefined ? async () => (await countAdmins(db)) === 0 : undefined

    const { authRouter, bearerMiddleware } = createAuthMount({
      auth,
      urls,
      ...(opts.auth.requiredScopes !== undefined ? { requiredScopes: opts.auth.requiredScopes } : {}),
      ...(firstRunCheck !== undefined ? { firstRunCheck } : {}),
    })
    const sharedSource: ConnectionSource = keyring !== undefined ? new DbConnectionSource({ db, keyring }) : opts.source
    const sharedPool: ReadPool = new ConnectionPool(sharedSource)

    const buildServer = ({ sub }: { sub: string | undefined }) => {
      let pool: ReadPool = sharedPool
      if (keyring !== undefined) {
        // Fail closed: sub somehow absent → empty-grant pool (user sees NO bases).
        const resolve: () => Promise<GrantMap> =
          sub !== undefined ? () => resolveGrants(db, sub) : async () => new Map()
        pool = new ScopedPool(sharedPool, resolve)
      }
      return buildMcpServer(pool, {
        version,
        dataDir: opts.dataDir,
        ...(opts.limits !== undefined ? { limits: opts.limits } : {}),
        // Tenancy path → REDACTED server_info (no host dataDir leaks to a tenant).
        // Auth-without-tenancy keeps the file variant (single-tenant, host-owned).
        ...(keyring !== undefined ? { serverInfo: 'tenancy' as const } : {}),
      })
    }

    // Health job: only on the tenancy path (needs db-derived repos + keyring). Built
    // BEFORE the app so its guarded `runOnce` can back the admin "check now" button —
    // a manual check then shares the job's single in-flight guard (never stacks on
    // the timer/startup sweep).
    let healthJob: HealthJob | undefined
    if (keyring !== undefined) {
      healthJob = startHealthJob({
        baseRepo: new BaseRepo(db),
        secretRepo: new SecretRepo(db),
        healthRepo: new HealthRepo(db),
        keyring,
        log: { error: (o, m) => process.stderr.write(`${m ?? 'health'}: ${JSON.stringify(o)}\n`) },
      })
    }

    const app = createApp({
      buildServer,
      ...(opts.allowedHosts !== undefined ? { allowedHosts: opts.allowedHosts } : {}),
      ...(opts.maxSessions !== undefined ? { maxSessions: opts.maxSessions } : {}),
      // Carry `db`/`keyring`/`sharedPool`/`version` (+ the health job's guarded
      // runOnce) on the auth options only when tenancy is on — the admin routes read
      // them; the MCP route never does (see app.ts). `sharedPool` MUST be the
      // process-global pool so admin base edits `refresh()` the shared cache.
      auth: {
        auth,
        urls,
        authRouter,
        bearerMiddleware,
        ...(keyring !== undefined ? { db, keyring, sharedPool, version } : {}),
        // Present only on the tenancy path (healthJob is built iff keyring is set).
        ...(healthJob !== undefined ? { onDemandHealthCheck: healthJob.runOnce } : {}),
      },
    })

    void healthJob?.runOnce() // seed the dashboard so it isn't blank for the first interval

    // Guard double-close: cli.ts may call close() twice (the server 'error'
    // handler AND a SIGINT/SIGTERM), and closing the pg pool twice throws.
    let closed = false
    return {
      server: createServer(app),
      auth,
      async close() {
        if (closed) return
        closed = true
        // Stop the timer AND await any in-flight sweep (incl. the runOnce seed)
        // BEFORE the DB handle closes, so a probe/upsert can't race dbHandle.close().
        await healthJob?.stop()
        await dbHandle.close()
      },
    }
  } catch (err) {
    // A mid-boot failure (migration / AS build) must not leak the DB handle.
    await dbHandle.close()
    throw err
  }
}
