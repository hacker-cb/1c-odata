// src/http/admin/middleware.ts
import { fromNodeHeaders } from 'better-auth/node'
import type { Request, RequestHandler } from 'express'
import type { Auth } from '../../auth/better-auth.js'
import { flash } from './views.js'

/**
 * True when the request was issued by htmx (an AJAX fragment swap, not a full
 * page load). The ONE definition every error path keys off: with the app shell's
 * responseHandling override making 4xx/5xx bodies swappable, an htmx caller must
 * receive the flash contract (OOB toast + HX-Reswap:none) or an HX-Redirect —
 * a bare fragment would be swapped into the request's own target.
 */
export function isHtmx(req: Request): boolean {
  return req.get('HX-Request') === 'true'
}

/**
 * Gate the admin panel on the better-auth browser session + `admin` role.
 * Reads the session cookie (NOT a Bearer JWT — that is the MCP machine path)
 * via `auth.api.getSession`, which the admin() plugin extends with `user.role`.
 * `getSession` returns null (never throws) when unauthenticated → 401/redirect.
 * Non-admin → 403. Mirrors better-auth's own gate: split `role` on `,`/space,
 * membership-test against the default adminRoles=["admin"].
 *
 * CSRF posture: this gate only proves *who* the caller is (an authenticated
 * admin), not that a state-changing request was *intentional*. The browser
 * session rides on a cookie, so a cross-site POST would carry it implicitly.
 * better-auth's default `SameSite=Lax` cookie blocks the classic form-POST CSRF,
 * but that guarantee evaporates under `crossSubDomainCookies` / `sameSite:'none'`.
 * So we ALSO run {@link adminCsrf} (an explicit same-origin Origin/Referer check)
 * on every unsafe method — defense in depth, independent of cookie config.
 */
export function adminGate(auth: Auth): RequestHandler {
  return async (req, res, next) => {
    const result = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })
    if (!result) {
      // Browsers get redirected to sign-in. htmx callers can't follow a 302 (the
      // fetch would transparently follow it and swap the sign-in PAGE into the
      // fragment target) — send `HX-Redirect` instead, which htmx honors with a
      // full browser navigation regardless of the 401 status. `next` is the
      // DOCUMENT url (HX-Current-URL), not the fragment url — resuming on
      // e.g. /admin/health/table would render a bare <tr> dump. The sign-in page
      // re-validates `next` as same-origin, so the client header can't smuggle an
      // open redirect; we still reduce it to path+query here.
      if (isHtmx(req)) {
        // htmx honors HX-Redirect with a full navigation before any swap logic,
        // so the body is never rendered — keep it empty.
        res
          .status(401)
          .setHeader('HX-Redirect', `/sign-in?next=${encodeURIComponent(docPath(req.get('HX-Current-URL')))}`)
          .type('html')
          .send('')
        return
      }
      res.redirect(`/sign-in?next=${encodeURIComponent(req.originalUrl)}`)
      return
    }
    const sessionUser = result.user as { id?: string; email?: string; role?: string | null }
    const role = sessionUser.role ?? 'user'
    const isAdmin = role.split(/[,\s]+/).some((r) => r === 'admin')
    // Handlers need to know WHO is acting (self-mutation guards, the "(you)"
    // marker) and the shell needs the identity for the nav's account chip —
    // stash both so neither re-reads the session.
    res.locals.actorId = sessionUser.id ?? ''
    res.locals.navUser = { email: sessionUser.email ?? '', admin: isAdmin }
    if (!isAdmin) {
      // htmx callers get the flash contract — a bare <h1> would be swapped into
      // the request's own target (e.g. the health poll's <tbody>) now that the
      // shell config makes 4xx bodies swappable.
      if (isHtmx(req)) {
        flash(res, 403, 'Admin role required.')
        return
      }
      res.status(403).type('html').send('<h1>403 — admin role required</h1>')
      return
    }
    next()
  }
}

/** Path+query of the document URL a client header reports, or /admin when absent/malformed. */
function docPath(currentUrl: string | undefined): string {
  try {
    const u = new URL(currentUrl ?? '')
    return u.pathname + u.search
  } catch {
    return '/admin' // header absent or malformed — the panel home is the safe default
  }
}

/** Methods that never change server state — exempt from the CSRF origin check. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Explicit same-origin CSRF guard for the admin panel's state-changing routes.
 * For any non-safe method (POST/PUT/DELETE/PATCH), the request's `Origin` (or,
 * when absent, `Referer`) origin MUST equal our canonical public origin — else
 * 403. This does not depend on the session cookie's SameSite setting, so it
 * holds even under `crossSubDomainCookies` / `sameSite:'none'`.
 *
 * htmx sends `Origin` on every AJAX request, so legitimate panel traffic is
 * unaffected. A request with neither header on an unsafe method is rejected
 * (a real browser always sends one of them for a cross-context write).
 */
export function adminCsrf(publicUrl: string): RequestHandler {
  let expected: string
  try {
    expected = new URL(publicUrl).origin
  } catch {
    // A malformed publicUrl must fail closed, not open: reject every unsafe write.
    expected = '\0invalid'
  }
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      next()
      return
    }
    const stated = req.get('Origin') ?? req.get('Referer')
    let ok = false
    if (stated !== undefined && stated !== '') {
      try {
        ok = new URL(stated).origin === expected
      } catch {
        ok = false
      }
    }
    if (!ok) {
      // Same flash-vs-fragment split as adminGate's 403: under the swappable-4xx
      // config a bare <p> would replace the request's target (e.g. outerHTML-delete
      // a row whose DELETE was in fact rejected).
      if (isHtmx(req)) {
        flash(res, 403, 'Cross-origin request rejected.')
        return
      }
      res.status(403).type('html').send('<p class="err">Cross-origin request rejected.</p>')
      return
    }
    next()
  }
}

/**
 * CSP for every admin response. `script-src 'self'` (no `unsafe-inline`) — htmx
 * is vendored and served same-origin, so no inline `<script>` is ever needed and
 * a stored-XSS injection cannot execute script. `style-src` DOES allow
 * `'unsafe-inline'` intentionally: the shell inlines a trusted `<style>` block
 * (BASE_CSS in ../../ui/shell.ts, a static constant — never request data), and
 * inline styles carry no script-execution risk. The script vector, which does,
 * stays locked.
 */
export const adminCsp: RequestHandler = (_req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  )
  next()
}
