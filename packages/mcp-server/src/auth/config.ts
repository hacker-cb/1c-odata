// src/auth/config.ts
/**
 * Canonical-URL module. Every URL the auth layer emits or validates derives from
 * ONE public origin so `iss`, `aud`, PRM, and DNS-rebinding stay consistent.
 *
 * The public URL is the externally reachable origin of THIS server (behind a
 * reverse proxy it differs from the bound address). better-auth uses it as
 * `baseURL` (→ default `iss`), and the MCP resource id (`aud`, RFC 8707) is
 * `${publicUrl}/mcp`. `validAudiences: [mcpResourceUrl]` gates the token endpoint.
 */
export interface CanonicalUrls {
  /** Externally reachable origin, no trailing slash (e.g. https://mcp.example.com). */
  readonly publicUrl: string
  /** better-auth mount base — `${publicUrl}/api/auth`. This is the OAuth issuer origin's mount. */
  readonly authBaseUrl: string
  /** The OAuth 2.0 issuer identifier the RS pins (`iss`). Equals authBaseUrl (better-auth default). */
  readonly issuer: string
  /** The MCP resource id (RFC 8707 `resource`, JWT `aud`) — `${publicUrl}/mcp`. */
  readonly mcpResourceUrl: string
}

/** Strip a single trailing slash so `${base}/x` never double-slashes. */
function trimTrailingSlash(u: string): string {
  return u.replace(/\/+$/, '')
}

/**
 * Derive the canonical URL set from the public origin. `publicUrl` is REQUIRED —
 * a wrong/absent value silently mis-scopes `aud` (every /mcp call then 401s), so
 * there is no default; the caller (cli.ts) resolves it from --public-url / env.
 */
export function resolveCanonicalUrls(publicUrl: string): CanonicalUrls {
  const base = trimTrailingSlash(publicUrl)
  if (base === '' || !/^https?:\/\//.test(base)) {
    throw new Error(
      `Invalid public URL ${JSON.stringify(publicUrl)}: expected an absolute http(s) origin ` +
        `(e.g. https://mcp.example.com). Set --public-url or ONEC_MCP_PUBLIC_URL.`,
    )
  }
  // Must be a BARE origin: every derived URL is origin-rooted (`/api/auth`, `/mcp`,
  // `/.well-known/…`) and the Express routes mount at the root. A path/query/hash
  // (e.g. https://host/mcp) would silently mangle `iss`/`aud` into https://host/mcp/api/auth.
  let parsed: URL
  try {
    parsed = new URL(base)
  } catch {
    throw new Error(`Invalid public URL ${JSON.stringify(publicUrl)}: not a valid URL.`)
  }
  if (
    (parsed.pathname !== '' && parsed.pathname !== '/') ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new Error(
      `Invalid public URL ${JSON.stringify(publicUrl)}: expected a bare origin without a path/query/fragment/userinfo ` +
        `(e.g. https://mcp.example.com) — the server mounts /mcp and /api/auth at the origin root.`,
    )
  }
  // Derive from parsed.origin, NOT the raw `base`: `new URL` normalizes a bare `?`
  // or `#` away from search/hash (so the guard above passes them), yet they survive
  // in the raw string and would mangle `${base}/api/auth` into `…/?/api/auth`.
  // The origin is the canonical scheme://host[:port] with any such tail dropped.
  const origin = parsed.origin
  const authBaseUrl = `${origin}/api/auth`
  return {
    publicUrl: origin,
    authBaseUrl,
    issuer: authBaseUrl,
    mcpResourceUrl: `${origin}/mcp`,
  }
}
