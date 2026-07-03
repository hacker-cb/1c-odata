// src/auth/pages/consent.ts
import type { Request, Response } from 'express'

/**
 * Minimal /consent page fulfilling the oauthProvider `consentPage` contract. The
 * plugin redirects here with the FULL signed authorize query appended (client_id,
 * scope, code_challenge, exp, sig, …). On accept we POST to
 * /api/auth/oauth2/consent with { accept: true, oauth_query } — where oauth_query
 * is that verbatim query string. The plugin's `before` hook re-verifies the sig
 * and repopulates the pending request from it (without oauth_query the endpoint
 * 400s "missing oauth query"), then completes the authorization ITSELF and
 * returns the redirect back to the client (with the code) — this page does not
 * re-authorize.
 *
 * `accept: false` denies WITHOUT removing any prior consent (to fully revoke,
 * delete the user's oauthConsent via /oauth2/delete-consent — out of scope here).
 */
export function consentPage(req: Request, res: Response): void {
  const clientId = typeof req.query.client_id === 'string' ? req.query.client_id : ''
  const scope = typeof req.query.scope === 'string' ? req.query.scope : ''
  res
    .status(200)
    .type('html')
    .send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Authorize — 1C OData MCP</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body>
<h1>Authorize access</h1>
<p>Client <code>${escapeHtml(clientId)}</code> is requesting:</p>
<ul>${scope
      .split(' ')
      .filter(Boolean)
      .map((s) => `<li><code>${escapeHtml(s)}</code></li>`)
      .join('')}</ul>
<button id="allow">Allow</button>
<button id="deny">Deny</button>
<p id="err" style="color:#c00"></p>
<script>
async function decide(accept) {
  // Forward the verbatim signed query the plugin appended so the endpoint can
  // re-verify the signature and resolve the pending authorization request.
  const oauthQuery = window.location.search.replace(/^\\?/, '');
  const r = await fetch('/api/auth/oauth2/consent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ accept, oauth_query: oauthQuery }),
  });
  // On accept the endpoint answers with a redirect back to the client.
  if (r.redirected) { window.location.href = r.url; return; }
  const data = await r.json().catch(() => ({}));
  const url = data.url || data.redirect_uri || data.redirectURI;
  if (typeof url === 'string') { window.location.href = url; return; }
  if (!accept) { window.location.href = '/'; return; }
  document.getElementById('err').textContent = 'Consent failed';
}
document.getElementById('allow').addEventListener('click', () => decide(true));
document.getElementById('deny').addEventListener('click', () => decide(false));
</script>
</body></html>`)
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}
