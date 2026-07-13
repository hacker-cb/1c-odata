// src/auth/pages/consent.ts
import type { Request, Response } from 'express'
import { authShell, esc } from '../../ui/shell.js'

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
  const scopes = scope
    .split(' ')
    .filter(Boolean)
    .map((s) => `<li><code>${esc(s)}</code></li>`)
    .join('')
  const body = `<h1>Authorize access</h1>
<p class="hint"><span class="clientid">${esc(clientId)}</span> is requesting access to:</p>
<ul class="scopes">${scopes}</ul>
<div class="btn-row">
  <button id="deny">Deny</button>
  <button id="allow" class="btn-primary">Allow</button>
</div>
<p id="err" class="err"></p>`
  res
    .status(200)
    .type('html')
    .send(authShell({ title: 'Authorize', body, scripts: CONSENT_SCRIPT }))
}

// Client-side accept/deny. Reads the verbatim signed query from window.location at
// runtime (never interpolated into markup), so a crafted query cannot inject.
const CONSENT_SCRIPT = `
async function decide(accept) {
  const oauthQuery = window.location.search.replace(/^\\?/, '');
  const r = await fetch('/api/auth/oauth2/consent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ accept, oauth_query: oauthQuery }),
  });
  if (r.redirected) { window.location.href = r.url; return; }
  const data = await r.json().catch(() => ({}));
  const url = data.url || data.redirect_uri || data.redirectURI;
  if (typeof url === 'string') { window.location.href = url; return; }
  if (!accept) { window.location.href = '/'; return; }
  document.getElementById('err').textContent = 'Consent failed';
}
document.getElementById('allow').addEventListener('click', () => decide(true));
document.getElementById('deny').addEventListener('click', () => decide(false));`
