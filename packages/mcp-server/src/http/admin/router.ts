// src/http/admin/router.ts
import type { ReadPool } from '@1c-odata/mcp/internal'
import express, { type ErrorRequestHandler, type Request, type Response, type Router } from 'express'
import type { Auth } from '../../auth/better-auth.js'
import { logger } from '../../logger.js'
import type { Keyring } from '../../store/crypto.js'
import type { AuthDb } from '../../store/db.js'
import { BaseRepo, GrantRepo, HealthRepo, SecretRepo } from '../../store/repos.js'
import { ADMIN_JS } from './admin-js-asset.js'
import { createBase, deleteBase, updateBase, verifyBase } from './bases.js'
import { dashboardPage, healthTable } from './dashboard.js'
import { grantsPage, toggleGrant } from './grants.js'
import { HTMX_JS } from './htmx-asset.js'
import { adminCsp, adminCsrf, adminGate, isHtmx } from './middleware.js'
import {
  banUser,
  createUser,
  deleteUser,
  editUserForm,
  newUserForm,
  passwordForm,
  setUserPassword,
  setUserRole,
  unbanUser,
  updateUser,
  usersPage,
} from './users.js'
import { flash, page, partial } from './views.js'

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
  // Panel helpers (password generator / clipboard). Also pre-gate: /account
  // pages load it for non-admin users. `no-cache` (revalidate), NOT immutable —
  // unlike the pinned htmx vendor this changes with the package.
  router.get('/assets/admin.js', (_req, res) => {
    res.type('application/javascript').setHeader('Cache-Control', 'no-cache').send(ADMIN_JS)
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
      const [bases, health] = await Promise.all([d.baseRepo.list(), d.healthRepo.list()])
      const healthByName = new Map(health.map((h) => [h.baseName, h.status]))
      const rows = await Promise.all(
        // ONE secret existence probe per base (no plaintext read); health from the
        // single list() above — the job seeds a row on save, so a missing entry
        // ('unknown') means "not probed yet", not an error.
        bases.map(async (b) => ({
          ...b,
          hasSecret: await d.secretRepo.has(b.name),
          health: healthByName.get(b.name) ?? 'unknown',
        })),
      )
      page(res, 'bases_list', { bases: rows }, 'Bases', 'bases')
    }, deps),
  )
  router.get('/bases/new', (_req, res) => partial(res, '_base_form', {}))
  router.get(
    '/bases/:name/edit',
    wrap(async (req, res, d) => {
      const name = String(req.params.name)
      const b = await d.baseRepo.get(name)
      if (!b) {
        flash(res, 404, `No such base "${name}" — it may have been deleted; reload the page.`)
        return
      }
      partial(res, '_base_form', { edit: true, name, ...b })
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

  // Users. `/users/new` is a literal path — it precedes the `/users/:id/*` params
  // but wouldn't be shadowed by them anyway (distinct segments).
  router.get('/users', wrap(usersPage, deps))
  router.get('/users/new', (_req, res) => newUserForm(_req, res))
  router.post('/users', wrap(createUser, deps))
  router.get('/users/:id/edit', wrap(editUserForm, deps))
  router.post('/users/:id', wrap(updateUser, deps))
  router.post('/users/:id/role', wrap(setUserRole, deps))
  router.get('/users/:id/password', wrap(passwordForm, deps))
  router.post('/users/:id/password', wrap(setUserPassword, deps))
  router.post('/users/:id/ban', wrap(banUser, deps))
  router.post('/users/:id/unban', wrap(unbanUser, deps))
  router.delete('/users/:id', wrap(deleteUser, deps))

  // Terminal 404 for unmatched /admin/* paths (behind the gate): without it,
  // Express's default "Cannot GET …" page would be the response body — and with
  // 4xx swapping enabled, an htmx caller (e.g. a poll left running across a
  // deploy that renamed a fragment route) would swap that page into its target.
  router.use((req, res) => {
    if (isHtmx(req)) {
      flash(res, 404, 'Not found — reload the page.')
      return
    }
    res.status(404).type('html').send('<h1>404 — Not found</h1>')
  })

  // Error middleware (4-arg): logs and surfaces the failure — as a flash toast
  // for htmx callers (a bare 500 body would not be swapped and the failure would
  // be invisible), a plain fragment otherwise. Placed LAST so it catches every
  // wrapped handler.
  router.use(adminErrorHandler)

  return router
}

/** Terminal error handler for the admin router. Never leaks the raw error to the DOM. */
const adminErrorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  logger.error({ err: err instanceof Error ? err.message : String(err), path: req.originalUrl }, 'admin handler failed')
  if (res.headersSent) return // a partial response already started — nothing safe to add
  if (isHtmx(req)) {
    flash(res, 500, 'Internal error — the operation did not complete.')
    return
  }
  res.status(500).type('html').send('<p class="err">Internal error — the operation did not complete.</p>')
}
