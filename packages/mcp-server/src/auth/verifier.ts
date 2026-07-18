// src/auth/verifier.ts
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { createLocalJWKSet, type JSONWebKeySet, type JWTPayload, errors as joseErrors, jwtVerify } from 'jose'

/**
 * Resolves the AS's public signing key for a given JWS header. This is exactly
 * what jose's key-set helpers return, so a remote set is assignable too.
 */
export type KeyResolver = ReturnType<typeof createLocalJWKSet>

export interface JwtVerifierOptions {
  /** AS issuer (`iss`) to pin, e.g. https://mcp.example.com/api/auth. */
  issuer: string
  /** Expected `aud` — our MCP resource id (RFC 8707), e.g. https://mcp.example.com/mcp. */
  audience: string
  /** Public signing keys of the AS. See {@link createLocalJwks} for the in-process source. */
  keys: () => Promise<KeyResolver>
  /** Restrict accepted signing algorithms. Default: the AS's EdDSA plus common asym algs. */
  algorithms?: string[]
}

/** Reads the JWKS straight out of the AS — no HTTP. See {@link createLocalJwks}. */
export type JwksReader = () => Promise<JSONWebKeySet>

/** Minimum spacing between JWKS reloads triggered by an unknown `kid`. */
const JWKS_REFRESH_COOLDOWN_MS = 30_000

/**
 * Build the verifier's key source from an AS that lives in THIS process.
 *
 * The server is both the Authorization Server (better-auth) and the Resource
 * Server, so its signing keys are already local — in the `jwks` table the AS
 * reads through `auth.api.getJwks()`. Fetching them back over the network from
 * our own public origin would make token verification depend on hairpin-NAT /
 * split-horizon DNS, which a single-host deploy behind a reverse proxy often
 * lacks; there, OAuth would break entirely. Reading in-process removes that
 * dependency — and with it the SSRF surface a URL-driven fetch carries.
 *
 * Public discovery is unaffected: `/.well-known/*` still advertises the PUBLIC
 * `jwks_uri`, because external clients do need to reach it over the network.
 *
 * The key set is cached and rebuilt on an unknown `kid` (bounded by a cooldown,
 * mirroring jose's remote-set behaviour) so a rotated AS key is picked up
 * without making every bearer check hit the database.
 */
export function createLocalJwks(
  readJwks: JwksReader,
  cooldownMs = JWKS_REFRESH_COOLDOWN_MS,
): () => Promise<KeyResolver> {
  let cached: Promise<KeyResolver> | undefined
  let lastLoadedAt = Number.NEGATIVE_INFINITY

  const load = (): Promise<KeyResolver> => {
    if (cached === undefined) {
      lastLoadedAt = Date.now()
      cached = readJwks()
        .then((jwks) => createLocalJWKSet(jwks))
        .catch((err: unknown) => {
          cached = undefined // don't poison the cache on a transient failure
          lastLoadedAt = Number.NEGATIVE_INFINITY
          throw err
        })
    }
    return cached
  }

  return async () => {
    const resolver = await load()
    // Wrap so a `kid` miss triggers ONE reload (the AS rotated a key) and retries
    // against the fresh set. The cooldown keeps a stream of bogus-`kid` tokens
    // from turning into a database read per request.
    return async (protectedHeader, token) => {
      try {
        return await resolver(protectedHeader, token)
      } catch (err) {
        if (!(err instanceof joseErrors.JWKSNoMatchingKey) || Date.now() - lastLoadedAt < cooldownMs) throw err
        cached = undefined
        return await (await load())(protectedHeader, token)
      }
    }
  }
}

/** Pull scopes from the standard OAuth JWT claims: `scope` (space-delimited) or `scp` (array/string). */
function extractScopes(payload: JWTPayload): string[] {
  const scope = payload.scope
  if (typeof scope === 'string') return scope.split(' ').filter(Boolean)
  const scp = (payload as { scp?: unknown }).scp
  if (Array.isArray(scp)) return scp.filter((s): s is string => typeof s === 'string')
  if (typeof scp === 'string') return scp.split(' ').filter(Boolean)
  return []
}

/** The confidential client id: `client_id`, else `azp`, else fall back to `sub`. */
function extractClientId(payload: JWTPayload, sub: string): string {
  const clientId = (payload as { client_id?: unknown }).client_id
  if (typeof clientId === 'string') return clientId
  const azp = (payload as { azp?: unknown }).azp
  if (typeof azp === 'string') return azp
  return sub
}

/**
 * jose-6-backed OAuthTokenVerifier for MCP's requireBearerAuth. Verifies the
 * signature against the AS's signing keys and pins BOTH `iss` and `aud`. JWT-only:
 * an opaque (resource-less) token has no valid signature here and fails loudly —
 * exactly the guard against the silent-downgrade trap.
 *
 * Note: the AS mints `aud` as an ARRAY (the `openid` scope adds the userinfo
 * endpoint as a second audience). jose's `audience` option accepts array `aud`
 * as long as our resource id is a member — so array `aud` verifies correctly.
 */
export function createJwtVerifier(opts: JwtVerifierOptions): OAuthTokenVerifier {
  const algorithms = opts.algorithms ?? ['EdDSA', 'RS256', 'ES256']

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload: JWTPayload
      try {
        const keys = await opts.keys()
        const result = await jwtVerify(token, keys, {
          issuer: opts.issuer,
          audience: opts.audience,
          algorithms,
        })
        payload = result.payload
      } catch (err) {
        if (
          err instanceof joseErrors.JWTExpired ||
          err instanceof joseErrors.JWTClaimValidationFailed ||
          err instanceof joseErrors.JWSSignatureVerificationFailed ||
          err instanceof joseErrors.JWTInvalid ||
          err instanceof joseErrors.JWSInvalid ||
          err instanceof joseErrors.JOSENotSupported ||
          err instanceof joseErrors.JWKSNoMatchingKey ||
          err instanceof joseErrors.JWKSMultipleMatchingKeys ||
          err instanceof joseErrors.JOSEAlgNotAllowed
        ) {
          // Token-shape / claim / signature / alg failures → 401 invalid_token.
          // Infra failures (a failed JWKS read) are NOT listed here and propagate
          // as 500 — an outage must not read to the client as a bad token.
          throw new InvalidTokenError(
            err instanceof joseErrors.JOSEError ? `${err.code}: ${err.message}` : 'Invalid token',
          )
        }
        // Database / key-material failures: surface as 500, not 401, so an infra
        // blip isn't reported to the client as a bad token.
        throw err
      }

      // requireBearerAuth REQUIRES a numeric expiresAt (else it 401s "no expiration").
      if (typeof payload.exp !== 'number') {
        throw new InvalidTokenError('Token has no exp claim')
      }

      // A legitimate better-auth token always carries `sub`; without it, tenancy
      // would resolve grants for an `undefined` subject (fail-closed empty pool,
      // but still a malformed token). Reject rather than admit a subject-less JWT.
      const sub = payload.sub
      if (typeof sub !== 'string' || sub === '') {
        throw new InvalidTokenError('Token has no sub claim')
      }

      return {
        token,
        clientId: extractClientId(payload, sub),
        scopes: extractScopes(payload),
        expiresAt: payload.exp, // seconds — the middleware's presence+expiry check reads this
        extra: { sub, iss: payload.iss },
      }
    },
  }
}
