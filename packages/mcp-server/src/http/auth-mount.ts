// src/http/auth-mount.ts
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import { toNodeHandler } from 'better-auth/node'
import { type RequestHandler, Router } from 'express'
import type { Auth } from '../auth/better-auth.js'
import type { CanonicalUrls } from '../auth/config.js'
import { consentPage } from '../auth/pages/consent.js'
import { type FirstRunCheck, makeSignInPage } from '../auth/pages/sign-in.js'
import { DEFAULT_REQUIRED_SCOPES, resourceMetadataUrl } from '../auth/resource-metadata.js'
import { createJwtVerifier, createLocalJwks } from '../auth/verifier.js'

/**
 * Anti-clickjacking + CSP for the first-party sign-in / consent pages. The consent
 * page authorizes an OAuth grant, so it must never be framed for a clickjacking
 * attack (`frame-ancestors 'none'` + the legacy `X-Frame-Options: DENY`). These
 * two pages carry a small trusted inline `<script>` (never request data — see the
 * page modules), so `script-src 'unsafe-inline'` is acceptable; the pages only
 * talk to their own origin (`connect-src`/`form-action 'self'`).
 */
const authPageSecurityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; " +
      "connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  )
  res.setHeader('X-Frame-Options', 'DENY')
  next()
}

export interface AuthMountOptions {
  auth: Auth
  urls: CanonicalUrls
  /** Scopes every /mcp request must carry. Default ['mcp:read']. */
  requiredScopes?: string[]
  /**
   * First-run probe (tenancy path only). When it resolves true (no admin yet),
   * `/sign-in` shows a "setup pending" hint pointing at the server log. It never
   * receives or renders the setup token.
   */
  firstRunCheck?: FirstRunCheck
}

export interface AuthMount {
  /** Mounted at the app root, BEFORE express.json(): better-auth handler + login/consent pages. */
  authRouter: Router
  /** Mounted on /mcp, BEFORE the MCP router: 401s any request without a valid Bearer JWT. */
  bearerMiddleware: RequestHandler
}

/**
 * Wire better-auth into Express. The better-auth handler must see the RAW body,
 * so its splat mount goes on before express.json() — the caller enforces the
 * ordering (see app.ts). The login/consent pages are plain GET routes.
 *
 * The bearer middleware pins issuer+audience (JWT-only via createJwtVerifier) and
 * advertises our PRM URL in the WWW-Authenticate `resource_metadata=` hint on 401/403.
 */
export function createAuthMount(opts: AuthMountOptions): AuthMount {
  const { auth, urls } = opts

  const authRouter = Router()
  // Pages first (plain GET, before the catch-all splat so they aren't swallowed).
  // Each carries anti-clickjacking + CSP headers (the consent page authorizes an
  // OAuth grant and must never be framed).
  authRouter.get('/sign-in', authPageSecurityHeaders, makeSignInPage(opts.firstRunCheck))
  authRouter.get('/consent', authPageSecurityHeaders, consentPage)
  // Express 5 splat syntax; MUST match better-auth basePath (/api/auth).
  authRouter.all('/api/auth/*splat', toNodeHandler(auth))

  const verifier = createJwtVerifier({
    issuer: urls.issuer,
    audience: urls.mcpResourceUrl,
    // The AS is THIS process, so its public keys come straight from the jwt()
    // plugin's in-process endpoint rather than a fetch of our own public origin
    // (which a deploy behind a reverse proxy without hairpin-NAT cannot make).
    keys: createLocalJwks(() => auth.api.getJwks()),
    algorithms: ['EdDSA', 'RS256', 'ES256'],
  })

  const bearerMiddleware = requireBearerAuth({
    verifier,
    // Copy the frozen default into a fresh mutable array — requireBearerAuth types
    // `requiredScopes` as `string[]`, and the const is readonly/frozen.
    requiredScopes: opts.requiredScopes ?? [...DEFAULT_REQUIRED_SCOPES],
    resourceMetadataUrl: resourceMetadataUrl(urls),
  })

  return { authRouter, bearerMiddleware }
}
