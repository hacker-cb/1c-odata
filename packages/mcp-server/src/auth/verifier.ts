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
 * How long a loaded key set is used before it is refreshed. This is what bounds
 * how long a key the operator REMOVED from the AS keeps verifying tokens (an
 * unknown-`kid` reload only ever picks keys UP). Matches jose's remote-set default.
 */
const JWKS_MAX_AGE_MS = 600_000

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
 * The set is cached, so a bearer check does not hit the database. Staleness is
 * handled the way jose's `RemoteJWKSet` handles it: a set older than `maxAgeMs`
 * is refreshed before use, and an unknown `kid` — the AS rotated a key in —
 * forces one extra reload, rate-limited by `cooldownMs` so a stream of bogus
 * `kid`s cannot turn into a read per request. Reloads are DEDUPED: concurrent
 * misses share one read and all retry against the set it installs, so the
 * requests in flight when a rotation lands are not spuriously rejected.
 *
 * Unlike jose we degrade gracefully on a stale refresh: this read is a local
 * database query, and failing auth over a blip when a perfectly good (merely
 * aging) key set is already in hand would trade the availability this whole
 * change is about. A failed refresh keeps the last good set; only the very first
 * load has no fallback and propagates.
 */
export function createLocalJwks(
  readJwks: JwksReader,
  cooldownMs = JWKS_REFRESH_COOLDOWN_MS,
  maxAgeMs = JWKS_MAX_AGE_MS,
): () => Promise<KeyResolver> {
  let keys: KeyResolver | undefined
  let pending: Promise<void> | undefined
  let loadedAt = Number.NEGATIVE_INFINITY

  // One shared read per reload (jose's `#pendingFetch`). `loadedAt` is stamped on
  // COMPLETION, not on entry: stamping it up front would close the cooldown window
  // on every concurrent miss the moment one of them started a reload, so all the
  // others would 401 on a valid, freshly-rotated token instead of retrying.
  const reload = (): Promise<void> => {
    pending ??= readJwks()
      .then((jwks) => {
        keys = createLocalJWKSet(jwks)
        loadedAt = Date.now()
        pending = undefined
      })
      .catch((err: unknown) => {
        pending = undefined // don't poison the cache — a transient failure can be retried
        throw err
      })
    return pending
  }

  const loadedWithin = (windowMs: number): boolean => Date.now() - loadedAt < windowMs

  /** The set to verify against: loaded if absent, refreshed if past `maxAgeMs`. */
  const currentKeys = async (): Promise<KeyResolver> => {
    if (keys === undefined) {
      await reload() // nothing to fall back on — a failure here must surface
    } else if (!loadedWithin(maxAgeMs)) {
      await reload().catch(() => {}) // best-effort: keep the aging set if the read fails
    }
    const current = keys
    if (current === undefined) throw new Error('JWKS unavailable') // unreachable once reload resolves
    return current
  }

  return async () => async (protectedHeader, token) => {
    const current = await currentKeys()
    try {
      return await current(protectedHeader, token)
    } catch (err) {
      if (!(err instanceof joseErrors.JWKSNoMatchingKey) || loadedWithin(cooldownMs)) throw err
      await reload()
      const refreshed = keys
      if (refreshed === undefined) throw err
      return await refreshed(protectedHeader, token)
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
