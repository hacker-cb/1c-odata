// src/auth/pages/sign-in.ts
import type { Request, Response } from 'express'

/**
 * Optional first-run probe. When present and it resolves true (no admin exists
 * yet), the page shows a small static hint that setup is pending — WITHOUT the
 * setup token (the token lives only in the server log; leaking it here would
 * defeat the token gate). Absent (or resolving false) → the plain sign-in page.
 */
export type FirstRunCheck = () => Promise<boolean>

/**
 * Build the /sign-in handler, fulfilling the oauthProvider `loginPage` contract.
 * The plugin redirects the unauthenticated user here with the ENTIRE
 * /oauth2/authorize query string appended verbatim. Per the plugin docs we do NOT
 * handle anything OAuth-specific: once a Better Auth session exists, the plugin
 * resumes the authorize flow. We only (a) perform a normal email/password sign-in
 * against /api/auth/sign-in/email, then (b) send the browser back to
 * /api/auth/oauth2/authorize?<same query> to re-enter the flow.
 *
 * The resume URL is rebuilt CLIENT-SIDE from `window.location.search` — the
 * request query is never interpolated into the server-rendered markup, so a
 * `</script>`-bearing query cannot break out of the inline script (reflected XSS).
 * The page markup is therefore fully static (the only server-side branch is the
 * first-run hint, which is likewise static and token-free).
 *
 * Two arrival paths:
 *   - OAuth login: the plugin appends the authorize query → after sign-in we
 *     resume `/api/auth/oauth2/authorize?<same query>`.
 *   - Admin gate: an anonymous `/admin` visit redirects to `/sign-in?next=/admin`
 *     → after sign-in we go to that `next`. Only a SAFE same-origin relative path
 *     (starts with a single `/`, not `//` — which is a protocol-relative URL to
 *     another host) is honored client-side; anything else falls back to the OAuth
 *     resume. This blocks an open-redirect via a crafted `next`.
 */
export function makeSignInPage(firstRunCheck?: FirstRunCheck) {
  return async (_req: Request, res: Response): Promise<void> => {
    let pending = false
    if (firstRunCheck !== undefined) {
      // A probe failure must never break the sign-in page — fall back to no hint.
      pending = await firstRunCheck().catch(() => false)
    }
    res
      .status(200)
      .type('html')
      .send(pending ? SIGN_IN_HTML_FIRST_RUN : SIGN_IN_HTML)
  }
}

/** Back-compat default handler (no first-run probe). */
export function signInPage(req: Request, res: Response): void {
  void makeSignInPage()(req, res)
}

// The first-run hint is STATIC markup — it names no token and interpolates no
// request data, so it carries no injection risk. It points the operator at the
// server log, which is where the `/setup?token=…` URL was printed at boot.
const FIRST_RUN_HINT = `<p style="padding:.6rem .8rem;background:#fef9c3;border:1px solid #eab308;border-radius:.4rem">
<strong>First-run setup pending.</strong> No administrator exists yet. Open the
one-time setup URL printed in the server logs (<code>…/setup?token=…</code>) to
create the first admin.</p>`

function signInHtml(hint: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sign in — 1C OData MCP</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body>
<h1>Sign in</h1>
${hint}
<form id="f">
  <label>Email <input name="email" type="email" autocomplete="username" required></label><br>
  <label>Password <input name="password" type="password" autocomplete="current-password" required></label><br>
  <button type="submit">Sign in</button>
  <p id="err" style="color:#c00"></p>
</form>
<script>
// Decide where to land after a successful sign-in, client-side so no request data
// is ever interpolated into the server-rendered markup.
//   - a SAFE same-origin ?next (relative path: one leading '/', not '//') → go there
//     (the admin gate sets ?next=/admin);
//   - otherwise resume the OAuth flow by replaying the authorize params the plugin
//     appended to this page's query.
function resumeTarget() {
  const next = new URLSearchParams(window.location.search).get('next');
  if (next && next[0] === '/' && next[1] !== '/') return next;
  return '/api/auth/oauth2/authorize' + window.location.search;
}
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const r = await fetch('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ email: fd.get('email'), password: fd.get('password') }),
  });
  if (r.ok) { window.location.href = resumeTarget(); }
  else { document.getElementById('err').textContent = 'Sign-in failed'; }
});
</script>
</body></html>`
}

const SIGN_IN_HTML = signInHtml('')
const SIGN_IN_HTML_FIRST_RUN = signInHtml(FIRST_RUN_HINT)
