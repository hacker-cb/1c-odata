// src/http/auth-mount.ts
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import { toNodeHandler } from 'better-auth/node'
import { type RequestHandler, Router } from 'express'
import type { Auth } from '../auth/better-auth.js'
import type { CanonicalUrls } from '../auth/config.js'
import { consentPage } from '../auth/pages/consent.js'
import { signInPage } from '../auth/pages/sign-in.js'
import { resourceMetadataUrl } from '../auth/resource-metadata.js'
import { createJwtVerifier } from '../auth/verifier.js'

export interface AuthMountOptions {
  auth: Auth
  urls: CanonicalUrls
  /** Scopes every /mcp request must carry. Default ['mcp:read']. */
  requiredScopes?: string[]
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
  authRouter.get('/sign-in', signInPage)
  authRouter.get('/consent', consentPage)
  // Express 5 splat syntax; MUST match better-auth basePath (/api/auth).
  authRouter.all('/api/auth/*splat', toNodeHandler(auth))

  const verifier = createJwtVerifier({
    issuer: urls.issuer,
    audience: urls.mcpResourceUrl,
    algorithms: ['EdDSA', 'RS256', 'ES256'],
  })

  const bearerMiddleware = requireBearerAuth({
    verifier,
    requiredScopes: opts.requiredScopes ?? ['mcp:read'],
    resourceMetadataUrl: resourceMetadataUrl(urls),
  })

  return { authRouter, bearerMiddleware }
}
