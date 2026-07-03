// src/auth/better-auth.ts

import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { oauthProvider } from '@better-auth/oauth-provider'
import { type Auth as BetterAuthInstance, betterAuth } from 'better-auth'
import { admin, jwt } from 'better-auth/plugins'
import type { AuthDb } from '../store/db.js'
import type { CanonicalUrls } from './config.js'

export interface BuildAuthOptions {
  urls: CanonicalUrls
  db: AuthDb
  /** BETTER_AUTH_SECRET. REQUIRED in prod — better-auth throws in production if unset. */
  secret: string
  /**
   * Trusted origins the CSRF / cookie machinery accepts. The public origin plus
   * any client origins (Claude connector). Defaults to [publicUrl].
   */
  trustedOrigins?: string[]
  /**
   * Additional RFC 8707 resource ids the token endpoint may mint `aud` for, on
   * top of the MCP resource url. Production leaves this empty; tests use it to
   * mint a token for an alternate, AS-permitted resource and exercise the RS-side
   * `aud` pin in isolation.
   */
  extraAudiences?: string[]
}

/**
 * The better-auth instance type — reused by verifier wiring, discovery, and tests.
 *
 * We cannot use `ReturnType<typeof buildAuth>`: the fully-inferred `betterAuth()`
 * return references zod's internal `$strip` symbol, which TypeScript refuses to
 * serialize into our emitted `.d.ts` (TS2883/TS7056). So we widen to better-auth's
 * exported base `Auth` and intersect it with just the plugin `api` members our
 * consumers structurally need — `getOAuthServerConfig` (required by
 * `oauthProviderAuthServerMetadata`). `handler` / `api` come from the base type;
 * `toNodeHandler` and the middleware need nothing more. Plugin-specific `api.*`
 * endpoints (sign-up, consent, …) are driven over HTTP in tests, so no caller
 * depends on the discarded inferred narrowing.
 */
/**
 * A minimal user shape the admin panel renders — a structural subset of the
 * admin() plugin's `UserWithRole`. Kept local so the admin `api.*` intersection
 * below stays serializable into our emitted `.d.ts` (the fully-inferred plugin
 * types drag in zod's `$strip` symbol — see the note above).
 */
export interface AdminUser {
  id: string
  email: string
  name: string
  role?: string | null
}

/**
 * The admin() plugin's `api` endpoints the admin panel drives. Widened to
 * `(...args: any[]) => …` for the same reason `getOAuthServerConfig` is: the
 * inferred better-call endpoint types are not `.d.ts`-portable, and our call
 * sites only need the argument bag (headers + body/query) and the result shape.
 */
export interface AdminApi {
  // biome-ignore lint/suspicious/noExplicitAny: inferred endpoint types are not .d.ts-portable; only the result shape is load-bearing.
  listUsers: (...args: any[]) => Promise<{ users: AdminUser[] }>
  // biome-ignore lint/suspicious/noExplicitAny: see listUsers.
  createUser: (...args: any[]) => Promise<{ user: AdminUser }>
  // biome-ignore lint/suspicious/noExplicitAny: see listUsers.
  setRole: (...args: any[]) => Promise<{ user: AdminUser }>
}

export type Auth = BetterAuthInstance & {
  api: BetterAuthInstance['api'] &
    AdminApi & {
      // biome-ignore lint/suspicious/noExplicitAny: mirrors the plugin's own (...args: any) => any shape; only presence matters here.
      getOAuthServerConfig: (...args: any[]) => any
    }
}

/**
 * Build the authorization server. Plugin order matters: `jwt()` must be present
 * (and BEFORE oauthProvider is fine) so oauthProvider can sign asymmetric JWT
 * access tokens. There is NO positive "enable JWT" flag — signing is automatic
 * when jwt() is loaded and a `resource` is requested; `disableJwtPlugin` (default
 * false) is the only opt-out and we deliberately leave it off.
 *
 * `validAudiences: [mcpResourceUrl]` is load-bearing: without it the token
 * endpoint rejects our resource (or defaults `aud` to baseURL), and every /mcp
 * call 401s despite a successful login.
 */
export function buildAuth(opts: BuildAuthOptions): Auth {
  const { urls, db, secret } = opts
  // Cast through unknown: the inferred betterAuth() type is structurally a
  // superset of `Auth` but its zod-laden shape can't be checked against the
  // widened alias directly (nor serialized — see the `Auth` note above).
  return betterAuth({
    baseURL: urls.publicUrl, // → mount at /api/auth; `iss` defaults to this base
    secret,
    trustedOrigins: opts.trustedOrigins ?? [urls.publicUrl],
    emailAndPassword: { enabled: true },
    database: drizzleAdapter(db, { provider: 'pg' }), // "pg" for BOTH pglite and node-postgres
    plugins: [
      jwt(), // asymmetric signing + JWKS at /api/auth/jwks (default alg EdDSA/Ed25519)
      admin(), // role scaffolding for later tenancy/admin flows (Slice 3+)
      oauthProvider({
        loginPage: '/sign-in', // required — plain BA login; plugin resumes the flow
        consentPage: '/consent', // required — receives ?client_id&scope&code, POSTs /oauth2/consent
        validAudiences: [urls.mcpResourceUrl, ...(opts.extraAudiences ?? [])], // ← RFC 8707 allowlist == our JWT `aud`
        allowDynamicClientRegistration: true, // MCP connectors self-register (DCR / RFC 7591)
        allowUnauthenticatedClientRegistration: true, // Claude registers before it has a token
        scopes: ['openid', 'profile', 'email', 'offline_access', 'mcp:read'],
        // disableJwtPlugin: false — leave OFF to keep signed-JWT access tokens
      }),
    ],
  }) as unknown as Auth
}
