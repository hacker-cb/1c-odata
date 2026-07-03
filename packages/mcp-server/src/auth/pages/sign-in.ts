// src/auth/pages/sign-in.ts
import type { Request, Response } from 'express'

/**
 * Minimal /sign-in page fulfilling the oauthProvider `loginPage` contract. The
 * plugin redirects the unauthenticated user here with the ENTIRE /oauth2/authorize
 * query string appended verbatim. Per the plugin docs we do NOT handle anything
 * OAuth-specific: once a Better Auth session exists, the plugin resumes the
 * authorize flow. We only (a) perform a normal email/password sign-in against
 * /api/auth/sign-in/email, then (b) send the browser back to
 * /api/auth/oauth2/authorize?<same query> to re-enter the flow.
 *
 * The resume URL is rebuilt CLIENT-SIDE from `window.location.search` — the
 * request query is never interpolated into the server-rendered markup, so a
 * `</script>`-bearing query cannot break out of the inline script (reflected XSS).
 * The page is therefore fully static.
 */
export function signInPage(_req: Request, res: Response): void {
  res.status(200).type('html').send(SIGN_IN_HTML)
}

const SIGN_IN_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sign in — 1C OData MCP</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body>
<h1>Sign in</h1>
<form id="f">
  <label>Email <input name="email" type="email" autocomplete="username" required></label><br>
  <label>Password <input name="password" type="password" autocomplete="current-password" required></label><br>
  <button type="submit">Sign in</button>
  <p id="err" style="color:#c00"></p>
</form>
<script>
// Resume the OAuth flow after login by replaying THIS page's query (the authorize
// params the plugin appended). Read client-side so no request data is ever
// interpolated into the server-rendered markup.
const RESUME = '/api/auth/oauth2/authorize' + window.location.search;
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const r = await fetch('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ email: fd.get('email'), password: fd.get('password') }),
  });
  if (r.ok) { window.location.href = RESUME; }
  else { document.getElementById('err').textContent = 'Sign-in failed'; }
});
</script>
</body></html>`
