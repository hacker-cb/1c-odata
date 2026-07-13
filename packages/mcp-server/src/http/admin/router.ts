// src/http/admin/router.ts
import type { ReadPool } from '@1c-odata/mcp/internal'
import express, { type ErrorRequestHandler, type Request, type Response, type Router } from 'express'
import type { Auth } from '../../auth/better-auth.js'
import { logger } from '../../logger.js'
import type { Keyring } from '../../store/crypto.js'
import type { AuthDb } from '../../store/db.js'
import { BaseRepo, GrantRepo, HealthRepo, SecretRepo } from '../../store/repos.js'
import { createBase, deleteBase, updateBase, verifyBase } from './bases.js'
import { dashboardPage, healthTable } from './dashboard.js'
import { grantsPage, toggleGrant } from './grants.js'
import { HTMX_JS } from './htmx-asset.js'
import { adminCsp, adminCsrf, adminGate } from './middleware.js'
import { createUser, setUserRole, usersPage } from './users.js'
import { page, partial } from './views.js'

/** Everything the admin handlers close over. Built once in createAdminRouter. */
export interface AdminDeps {
  auth: Auth
  db: AuthDb
  keyring: Keyring
  sharedPool: ReadPool // the process-global ConnectionPool (NOT a ScopedPool) — for refresh()
  version: string
  baseRepo: BaseRepo
  secretRepo: SecretRepo
  grantRepo: GrantRepo
  healthRepo: HealthRepo
}

export interface CreateAdminRouterOptions {
  auth: Auth
  db: AuthDb
  keyring: Keyring
  sharedPool: ReadPool
  version: string
  /** Canonical public origin — the admin CSRF guard's same-origin target. */
  publicUrl: string
}

/**
 * Adapt an async handler to Express: forward ANY rejection to `next` so it hits
 * the router's error middleware instead of becoming an unhandledRejection (which
 * would crash the whole multi-tenant process and hang the request). Express 5
 * awaits a returned promise but NOT a fire-and-forget one, so we must route the
 * rejection ourselves.
 */
function wrap(handler: (req: Request, res: Response, deps: AdminDeps) => Promise<void>, deps: AdminDeps) {
  return (req: Request, res: Response, next: (err?: unknown) => void): void => {
    handler(req, res, deps).catch(next)
  }
}

export function createAdminRouter(opts: CreateAdminRouterOptions): Router {
  const deps: AdminDeps = {
    auth: opts.auth,
    db: opts.db,
    keyring: opts.keyring,
    sharedPool: opts.sharedPool,
    version: opts.version,
    baseRepo: new BaseRepo(opts.db),
    secretRepo: new SecretRepo(opts.db),
    grantRepo: new GrantRepo(opts.db),
    healthRepo: new HealthRepo(opts.db),
  }

  const router = express.Router()
  router.use(adminCsp)

  // Static htmx — served BEFORE the gate (harmless public JS, and the sign-in
  // redirect page must be able to load it even without a session).
  router.get('/assets/htmx.min.js', (_req, res) => {
    res.type('application/javascript').setHeader('Cache-Control', 'public, max-age=31536000, immutable').send(HTMX_JS)
  })

  // Everything past here requires an admin session AND a same-origin unsafe method.
  router.use(adminGate(opts.auth))
  router.use(adminCsrf(opts.publicUrl))
  // htmx posts urlencoded; the global express.json() in app.ts won't parse these.
  router.use(express.urlencoded({ extended: false }))

  // Dashboard + health poll
  router.get('/', wrap(dashboardPage, deps))
  router.get('/health/table', wrap(healthTable, deps))

  // Bases
  router.get(
    '/bases',
    wrap(async (_req, res, d) => {
      const bases = await d.baseRepo.list()
      const withSecret = await Promise.all(
        bases.map(async (b) => ({ ...b, hasSecret: await d.secretRepo.has(b.name) })),
      )
      page(res, 'bases_list', { bases: withSecret }, 'Bases', 'bases')
    }, deps),
  )
  router.get('/bases/new', (_req, res) => partial(res, '_base_form', {}))
  router.get(
    '/bases/:name/edit',
    wrap(async (req, res, d) => {
      const name = String(req.params.name)
      const b = await d.baseRepo.get(name)
      if (!b) {
        res.status(404).type('html').send('<p class="err">No such base</p>')
        return
      }
      partial(res, '_base_form', { name, ...b })
    }, deps),
  )
  router.post('/bases/verify', wrap(verifyBase, deps))
  router.post(
    '/bases',
    wrap((req, res, d) => createBase(d)(req, res), deps),
  )
  router.put(
    '/bases/:name',
    wrap((req, res, d) => updateBase(d)(req, res), deps),
  )
  router.delete('/bases/:name', wrap(deleteBase, deps))

  // Grants
  router.get('/grants', wrap(grantsPage, deps))
  router.post('/grants/toggle', wrap(toggleGrant, deps))

  // Users
  router.get('/users', wrap(usersPage, deps))
  router.post('/users', wrap(createUser, deps))
  router.post('/users/:id/role', wrap(setUserRole, deps))

  // Error middleware (4-arg): logs and renders a 500 fragment. htmx-aware — a
  // short body + a 500 status makes the client surface the failure instead of
  // silently swapping nothing. Placed LAST so it catches every wrapped handler.
  router.use(adminErrorHandler)

  return router
}

/** Terminal error handler for the admin router. Never leaks the raw error to the DOM. */
const adminErrorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  logger.error({ err: err instanceof Error ? err.message : String(err), path: req.originalUrl }, 'admin handler failed')
  if (res.headersSent) return // a partial response already started — nothing safe to add
  res.status(500).type('html').send('<p class="err">Internal error — the operation did not complete.</p>')
}
