// auth.config.ts
/**
 * THROWAWAY config module for `@better-auth/cli generate` ONLY.
 *
 * The CLI needs a module exporting `auth` to introspect the plugin set and emit
 * the Drizzle schema (auth-schema.ts). This mirrors src/auth/better-auth.ts's
 * plugin set EXACTLY — jwt() + admin() + oauthProvider(...) — so the generated
 * tables match what the runtime expects. It is NOT imported by any runtime code;
 * it exists purely as the schema-generation seam. Keep it in sync with
 * src/auth/better-auth.ts whenever the plugin set changes, then regenerate.
 */
import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { oauthProvider } from '@better-auth/oauth-provider'
import { PGlite } from '@electric-sql/pglite'
import { betterAuth } from 'better-auth'
import { admin, jwt } from 'better-auth/plugins'
import { drizzle } from 'drizzle-orm/pglite'

const db = drizzle(new PGlite())

// Annotated `unknown`: the betterAuth({...}) ARGUMENT is still fully type-checked
// (so a drift in the oauthProvider/jwt/admin option shape fails typecheck here),
// but the inferred instance type — which references zod's internal `$strip` and
// is not declaration-portable (TS2883/TS7056) — is not exposed. @better-auth/cli
// reads the runtime value, so the annotation doesn't affect schema generation.
export const auth: unknown = betterAuth({
  baseURL: 'http://localhost:3000',
  secret: 'schema-generation-only-not-a-real-secret-0123456789',
  // Mirrors the runtime's options verbatim. `disableSignUp` has no effect on schema
  // generation, but keeping the two literally identical is the point of this file —
  // a reader comparing them should find nothing that differs for an unstated reason.
  emailAndPassword: { enabled: true, disableSignUp: true },
  database: drizzleAdapter(db, { provider: 'pg' }),
  plugins: [
    jwt(),
    admin(),
    oauthProvider({
      loginPage: '/sign-in',
      consentPage: '/consent',
      validAudiences: ['http://localhost:3000/mcp'],
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      scopes: ['openid', 'profile', 'email', 'offline_access', 'mcp:read'],
    }),
  ],
})
