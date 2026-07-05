// src/http/setup/router.ts
//
// The first-run onboarding wizard: a public web page, gated by a one-time setup
// token, that seeds the FIRST admin so a deploy needs no crafted console command.
//
// Threat model — this server is designed to be PUBLICLY exposed, so the wizard is
// a bootstrap-hijack target and MUST fail closed:
//   - Reachable ONLY while (no admin exists) AND (the caller presents the exact
//     stored setup token). Miss either and the page is a hard 404 — the same
//     response whether the token is wrong, absent, or an admin already exists, so
//     an attacker learns nothing (no "wrong token" oracle).
//   - The token is generated at boot and printed ONLY to the server log; it never
//     appears in any HTTP response except the hidden field of the wizard form the
//     legitimate operator already opened. The sign-in "first-run pending" hint
//     (see auth-mount/sign-in) deliberately points at the log, never the token.
//   - Once the first admin is created the token is deleted (single-use) and the
//     admin count is ≥ 1, so `/setup` is 404 FOREVER after onboarding.
//
// Reuses the admin panel's security infrastructure: `adminCsp` (locked CSP),
// `adminCsrf(publicUrl)` (same-origin Origin/Referer check on the POST), the
// `wrap()`/error-handler pattern, and the Eta `page` view helper.
import { timingSafeEqual } from 'node:crypto'
import express, { type ErrorRequestHandler, type Request, type Response, type Router } from 'express'
import type { Auth } from '../../auth/better-auth.js'
import { logger } from '../../logger.js'
import type { AuthDb } from '../../store/db.js'
import { countAdmins, SetupTokenRepo } from '../../store/repos.js'
import { adminCsp, adminCsrf } from '../admin/middleware.js'
import { page } from '../admin/views.js'

/** Everything the setup handlers close over. Built once in createSetupRouter. */
interface SetupDeps {
  auth: Auth
  db: AuthDb
  tokenRepo: SetupTokenRepo
}

export interface CreateSetupRouterOptions {
  auth: Auth
  db: AuthDb
  /** Canonical public origin — the same-origin CSRF target for the wizard POST. */
  publicUrl: string
}

/**
 * Adapt an async handler to Express (identical contract to the admin router's
 * `wrap`): forward ANY rejection to `next` so it hits the router error middleware
 * instead of becoming an unhandledRejection that crashes the process.
 */
function wrap(handler: (req: Request, res: Response, deps: SetupDeps) => Promise<void>, deps: SetupDeps) {
  return (req: Request, res: Response, next: (err?: unknown) => void): void => {
    handler(req, res, deps).catch(next)
  }
}

/**
 * Resolve the wizard gate for a request. Returns the validated token when the
 * page is OPEN (no admin yet AND the presented value matches the stored token),
 * or null when it must 404. Constant response either way — no distinct signal for
 * "wrong token" vs "already onboarded".
 */
async function openToken(deps: SetupDeps, presented: unknown): Promise<string | null> {
  try {
    if ((await countAdmins(deps.db)) > 0) return null // onboarding done → closed forever
    const stored = await deps.tokenRepo.get()
    if (stored === null) return null // no token minted → nothing to unlock
    if (typeof presented !== 'string' || presented === '') return null
    // Constant-time compare — a negligible risk for a 256-bit single-use secret
    // behind the countAdmins() gate, but idiomatic for a bootstrap token. timingSafeEqual
    // throws on a length mismatch, so length-check first; the token is fixed-length,
    // so its length leaks nothing an attacker doesn't already know.
    const a = Buffer.from(presented)
    const b = Buffer.from(stored)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null
    return stored
  } catch (err) {
    // Fail CLOSED: a DB error in the gate must NOT bubble to a 500 — that would be a
    // response distinguishable from the uniform 404 (hinting the wizard route exists
    // / errored). Log it for the operator and deny the request like any other miss.
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'setup gate check failed')
    return null
  }
}

/** Uniform 404 for every closed-wizard path (do not reveal the page exists). */
function notFound(res: Response): void {
  res.status(404).type('html').send('<h1>404 — Not found</h1>')
}

export function createSetupRouter(opts: CreateSetupRouterOptions): Router {
  const deps: SetupDeps = {
    auth: opts.auth,
    db: opts.db,
    tokenRepo: new SetupTokenRepo(opts.db),
  }

  const router = express.Router()
  router.use(adminCsp)
  // The GET form embeds the one-time token in a hidden field; never let a browser,
  // proxy, or CDN cache a /setup response and persist the token past its lifecycle.
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    next()
  })
  // The wizard POSTs urlencoded form data; the global express.json() in app.ts
  // won't parse it.
  router.use(express.urlencoded({ extended: false }))
  // Same-origin guard on the POST (no-op for the GET) — identical to the admin panel.
  router.use(adminCsrf(opts.publicUrl))

  router.get(
    '/',
    wrap(async (req, res, d) => {
      const token = await openToken(d, req.query.token)
      if (token === null) {
        notFound(res)
        return
      }
      page(res, 'setup_wizard', { token }, 'Setup')
    }, deps),
  )

  router.post(
    '/',
    wrap(async (req, res, d) => {
      const token = await openToken(d, req.body.token)
      if (token === null) {
        notFound(res)
        return
      }
      // Validate fields BEFORE consuming the token — a field error is retryable
      // without burning the one-time token. Mirror the admin createUser guard: a
      // missing field must never coerce to the literal "undefined" and seed a bogus admin.
      const email = req.body.email
      const password = req.body.password
      const confirm = req.body.confirm
      if (typeof email !== 'string' || email === '' || typeof password !== 'string' || password === '') {
        page(
          res,
          'setup_wizard',
          { token, email: typeof email === 'string' ? email : '', error: 'Email and password are required.' },
          'Setup',
        )
        return
      }
      if (typeof confirm === 'string' && confirm !== password) {
        page(res, 'setup_wizard', { token, email, error: 'Passwords do not match.' }, 'Setup')
        return
      }
      // Atomically consume the token: only the winner of a concurrent race proceeds,
      // so EXACTLY ONE first admin is created even on real Postgres (pglite
      // serializes, a prod pg.Pool does not). A loser sees the token already gone → 404.
      if (!(await d.tokenRepo.consume(token))) {
        notFound(res)
        return
      }
      try {
        // The SAME header-less trusted seed path `admin-create` uses: with no
        // session and no request/headers on the arg bag, the admin() plugin skips
        // its create-check, so this provisions the first admin directly.
        await d.auth.api.createUser({
          body: { email, password, name: 'Admin', role: 'admin' },
        })
      } catch (err) {
        // The token was already consumed — restore it (idempotent on the singleton
        // key) so the operator can fix the input and retry without a restart.
        // Redacted — NEVER echo the password or the raw error (duplicate-email, a
        // too-short password, etc.) into the DOM.
        await d.tokenRepo.ensure(token)
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'setup wizard createUser failed')
        page(
          res,
          'setup_wizard',
          { token, email, error: 'Could not create the admin — check the email and password and try again.' },
          'Setup',
        )
        return
      }
      // Success — the token was already consumed above; send the operator to sign-in.
      res.redirect(302, '/sign-in')
    }, deps),
  )

  router.use(setupErrorHandler)
  return router
}

/** Terminal error handler for the setup router. Never leaks the raw error to the DOM. */
const setupErrorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  // Log req.path, NOT req.originalUrl — the latter carries the `?token=…` query and
  // would spread the one-time bootstrap token into error logs / aggregators.
  logger.error({ err: err instanceof Error ? err.message : String(err), path: req.path }, 'setup handler failed')
  if (res.headersSent) return
  res.status(500).type('html').send('<p class="err">Internal error — setup did not complete.</p>')
}
