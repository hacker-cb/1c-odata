// src/auth/verifier.ts
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { createRemoteJWKSet, type JWTPayload, errors as joseErrors, jwtVerify } from 'jose'

export interface JwtVerifierOptions {
  /** AS issuer (`iss`), e.g. https://mcp.example.com/api/auth. jwks_uri is derived from its metadata. */
  issuer: string
  /** Expected `aud` — our MCP resource id (RFC 8707), e.g. https://mcp.example.com/mcp. */
  audience: string
  /** Restrict accepted signing algorithms. Default: the AS's EdDSA plus common asym algs. */
  algorithms?: string[]
}

/** Fail a hung AS-metadata fetch fast rather than hanging bearer checks (~undici 300s default). */
const AS_METADATA_TIMEOUT_MS = 5_000

interface AsMetadata {
  issuer: string
  jwks_uri: string
}

type JwksResolver = ReturnType<typeof createRemoteJWKSet>

/**
 * Fetch the AS metadata (RFC 8414) once and build a cached remote-JWKS resolver
 * from its `jwks_uri`. We do NOT hardcode `/api/auth/jwks` — the location comes
 * from the AS document, so a config change on the AS side can't silently break us.
 * The cache is cleared on failure so a transient blip can be retried.
 */
function makeJwksProvider(issuer: string): () => Promise<JwksResolver> {
  let cached: Promise<JwksResolver> | undefined
  return () => {
    if (cached === undefined) {
      cached = (async () => {
        const base = issuer.replace(/\/+$/, '')
        const metadataUrl = `${base}/.well-known/oauth-authorization-server`
        // Bound the metadata fetch (jose bounds the JWKS fetch, but this one is
        // ours): a hung AS-metadata endpoint must fail fast — the promise is cached
        // and shared, so without a timeout every concurrent bearer check would hang
        // on it for undici's ~300s default instead of surfacing a prompt 500.
        const res = await fetch(metadataUrl, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(AS_METADATA_TIMEOUT_MS),
        })
        if (!res.ok) {
          throw new Error(`Failed to fetch AS metadata (${res.status} ${res.statusText}) from ${metadataUrl}`)
        }
        const meta = (await res.json()) as AsMetadata
        if (typeof meta.jwks_uri !== 'string' || meta.jwks_uri === '') {
          throw new Error(`AS metadata at ${metadataUrl} has no jwks_uri`)
        }
        // Constrain jwks_uri to the pinned issuer's origin: a misdirected metadata
        // fetch (proxy/DNS misconfig, SSRF, an unexpected redirect) must never be
        // able to point the verifier at attacker-controlled signing keys on
        // another origin — that would let a forged token verify.
        const jwksUrl = new URL(meta.jwks_uri)
        const issuerOrigin = new URL(base).origin
        if (jwksUrl.origin !== issuerOrigin) {
          throw new Error(`AS jwks_uri origin ${jwksUrl.origin} does not match issuer origin ${issuerOrigin}`)
        }
        return createRemoteJWKSet(jwksUrl)
      })().catch((err: unknown) => {
        cached = undefined // don't poison the cache on a transient failure
        throw err
      })
    }
    return cached
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
 * signature against the AS's remote JWKS and pins BOTH `iss` and `aud`. JWT-only:
 * an opaque (resource-less) token has no valid signature here and fails loudly —
 * exactly the guard against the silent-downgrade trap.
 *
 * Note: the AS mints `aud` as an ARRAY (the `openid` scope adds the userinfo
 * endpoint as a second audience). jose's `audience` option accepts array `aud`
 * as long as our resource id is a member — so array `aud` verifies correctly.
 */
export function createJwtVerifier(opts: JwtVerifierOptions): OAuthTokenVerifier {
  const getJwks = makeJwksProvider(opts.issuer)
  const algorithms = opts.algorithms ?? ['EdDSA', 'RS256', 'ES256']

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload: JWTPayload
      try {
        const jwks = await getJwks()
        const result = await jwtVerify(token, jwks, {
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
          // Infra failures (JWKSTimeout, fetch/metadata) are NOT listed here and
          // propagate as 500 — an outage must not read to the client as a bad token.
          throw new InvalidTokenError(
            err instanceof joseErrors.JOSEError ? `${err.code}: ${err.message}` : 'Invalid token',
          )
        }
        // JWKSTimeout / network / metadata-fetch failures: surface as 500, not 401,
        // so an infra blip isn't reported to the client as a bad token.
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
