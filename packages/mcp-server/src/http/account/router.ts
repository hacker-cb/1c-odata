// src/http/account/router.ts
//
// The self-service surface for EVERY signed-in role — deliberately outside the
// admin gate. A plain user has no other web page: their password is provisioned
// by an admin, so /account is where they rotate it. It also owns sign-out (the
// nav's form posts here from both admin and account pages).
//
// Reuses the admin panel's security kit verbatim: `adminCsp` (locked CSP),
// `adminCsrf` (same-origin check on unsafe methods), the flash/OOB error
// contract, and the app shell (nav sections collapse for non-admins — see
// appShell). Mounted on the tenancy path next to /admin.
import { fromNodeHeaders } from 'better-auth/node'
import express, { type ErrorRequestHandler, type Request, type Response, type Router } from 'express'
import type { Auth } from '../../auth/better-auth.js'
import { logger } from '../../logger.js'
import { hasAdminRole } from '../../store/repos.js'
import { adminCsp, adminCsrf, isHtmx } from '../admin/middleware.js'
import { flash, page } from '../admin/views.js'

export interface CreateAccountRouterOptions {
  auth: Auth
  /** Canonical public origin — the same-origin CSRF target. */
  publicUrl: string
}

/** Same async-handler adapter contract as the admin/setup routers. */
function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: (err?: unknown) => void): void => {
    handler(req, res).catch(next)
  }
}

export function createAccountRouter(opts: CreateAccountRouterOptions): Router {
  const { auth } = opts
  const router = express.Router()
  router.use(adminCsp)
  router.use(express.urlencoded({ extended: false }))
  router.use(adminCsrf(opts.publicUrl))

  // Sign-out is registered BEFORE the session gate: it must work even when the
  // session just expired (the gate would bounce to /sign-in and strand the POST).
  router.post(
    '/sign-out',
    wrap(async (req, res) => {
      try {
        const out = await auth.api.signOut({ headers: fromNodeHeaders(req.headers), returnHeaders: true })
        // Forward better-auth's cookie-clearing headers so the browser drops the session.
        const cookies = out.headers.getSetCookie()
        if (cookies.length > 0) res.setHeader('Set-Cookie', cookies)
      } catch {
        // No/invalid session — nothing to clear; landing on sign-in is right either way.
      }
      res.redirect(303, '/sign-in')
    }),
  )

  // Gate: ANY authenticated user (no role check — this is the self-service page).
  router.use((req, res, next) => {
    auth.api
      .getSession({ headers: fromNodeHeaders(req.headers) })
      .then((result) => {
        if (!result) {
          if (isHtmx(req)) {
            res.status(401).setHeader('HX-Redirect', '/sign-in?next=%2Faccount').type('html').send('')
            return
          }
          res.redirect(`/sign-in?next=${encodeURIComponent(req.originalUrl)}`)
          return
        }
        const u = result.user as { id?: string; email?: string; role?: string | null }
        res.locals.actorId = u.id ?? ''
        res.locals.navUser = { email: u.email ?? '', admin: hasAdminRole(u.role) }
        res.locals.actorRole = u.role ?? 'user'
        next()
      })
      .catch(next)
  })

  router.get('/', (_req, res) => {
    const email = String((res.locals as { navUser?: { email: string } }).navUser?.email ?? '')
    const role = String((res.locals as { actorRole?: string }).actorRole ?? 'user')
    page(res, 'account_page', { email, role }, 'Account', 'account')
  })

  router.post(
    '/password',
    wrap(async (req, res) => {
      const current = req.body.current
      const password = req.body.password
      if (typeof current !== 'string' || current === '' || typeof password !== 'string' || password.length < 8) {
        flash(res, 400, 'Both passwords are required; the new one must be at least 8 characters.')
        return
      }
      try {
        await auth.api.changePassword({
          headers: fromNodeHeaders(req.headers),
          body: { currentPassword: current, newPassword: password, revokeOtherSessions: true },
        })
      } catch (err) {
        // Wrong current password / policy refusal — redacted, never echo details.
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'account password change failed')
        flash(res, 400, 'Password change failed — check the current password.')
        return
      }
      flash(res, 200, 'Password changed. Your other sessions were signed out.', 'ok')
    }),
  )

  router.use(accountErrorHandler)
  return router
}

/** Terminal error handler — same redaction contract as the admin router's. */
const accountErrorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  logger.error({ err: err instanceof Error ? err.message : String(err), path: req.baseUrl }, 'account handler failed')
  if (res.headersSent) return
  if (isHtmx(req)) {
    flash(res, 500, 'Internal error — the operation did not complete.')
    return
  }
  res.status(500).type('html').send('<p class="err">Internal error — the operation did not complete.</p>')
}
