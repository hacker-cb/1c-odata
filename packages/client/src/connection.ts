import { type AuthOptions, BasicAuth } from './auth/basic.js'
import { InvalidArgumentError } from './errors.js'
import { normalizeBaseUrl } from './url-builder.js'

/**
 * Data-shape contract — how `Edm.*` types and 1С composites map onto JS values.
 * MUST be identical at codegen-time (TS types emitted) and runtime (parser
 * output). Lives in @1c-odata/client because both layers consume it.
 *
 * @public
 */
export interface DataShape {
  /**
   * TS representation for Edm.Int64 (1С wire form is always string).
   * Default: 'number' — JS-natural arithmetic, fits 99.99% of 1С Int64 values
   *          (safe integer range is ±2^53; typical 1С Int64 fields like LineNumber
   *          are small counters well within range).
   * 'bigint' — precision-correct via native bigint. Use when values may exceed 2^53.
   *          NOTE: bigint values cannot be JSON.stringified directly — needs a replacer.
   * 'string' — wire passthrough; no automatic conversion, user-managed.
   */
  int64Mode?: 'number' | 'bigint' | 'string'
  /**
   * TS representation for Edm.DateTime.
   * Default: 'date' — library auto-converts wire ↔ Date using serverTimezone,
   *          sentinel "0001-01-01T00:00:00" ↔ null both directions.
   * 'string' — full passthrough; user manages conversion via parseInZone/formatInZone.
   *          In this mode parser and write path do NOT touch Edm.DateTime fields.
   *          Sentinel visible as literal ONEC_EMPTY_DATE string.
   *          FILTER CAVEAT: DateOps mixin doesn't apply to string-typed DateTime fields —
   *          use raw(`<field> gt datetime'<iso>'`) escape hatch for date comparisons.
   */
  dateMode?: 'date' | 'string'
}

/**
 * Project-level connection config — what `1c-odata.config.ts` exports per
 * connection. `baseUrl` MUST NOT contain userinfo — use `parseConnectionUrl`
 * to split a URL with credentials into `baseUrl` + `auth`.
 *
 * @public
 */
export interface Connection {
  /**
   * Clean URL without userinfo. `parseConnectionUrl` strips trailing slashes
   * during URL split; direct `baseUrl` assignments are passed through as-is.
   */
  baseUrl: string
  /** Basic auth credentials. Use `parseConnectionUrl` to split from a URL with userinfo. */
  auth: {
    username: string
    password: string
  }
  /**
   * IANA timezone of the 1С server (e.g., 'Europe/Moscow',
   * 'Asia/Yekaterinburg'). REQUIRED — no default applied. Wrong timezone
   * produces silent DateTime parse drift, so the library forces an explicit
   * choice rather than guessing.
   */
  serverTimezone: string
  /** Data-shape decisions (must match codegen output for the same connection). */
  shape?: DataShape
  /** Per-connection override of `fetchTimeout` (ms) for `1c-odata fetch`. */
  fetchTimeout?: number
  /** Codegen-only options. */
  codegen?: {
    /** Whitelist of entity-type names. Globs supported (`Catalog_*`). Closure auto-expands. */
    include?: string[]
  }
}

/**
 * Top-level project config — what `1c-odata.config.ts` exports.
 *
 * @public
 */
export interface CliConfig {
  /** Directory for `<connection>.xml` snapshots. Default: `./metadata`. */
  metadataDir?: string
  /** Directory for generated TS files. Default: `./generated`. */
  generatedDir?: string
  /** Default timeout for `1c-odata fetch` (ms). Default: `120_000`. */
  fetchTimeout?: number
  /** Map of connection name → connection config. */
  connections: Record<string, Connection>
}

/**
 * Identity helper for type-safe config files.
 *
 * @example
 * ```ts
 * import { defineConfig, parseConnectionUrl } from '@1c-odata/client'
 *
 * const url = process.env.ONEC_URL
 * if (!url) throw new Error('Set ONEC_URL env var')
 *
 * export default defineConfig({
 *   connections: {
 *     trade: {
 *       ...parseConnectionUrl(url),
 *       serverTimezone: 'Europe/Moscow',
 *     },
 *   },
 * })
 * ```
 *
 * @public
 */
export function defineConfig<const C extends CliConfig>(c: C): C {
  return c
}

/**
 * Split a URL with userinfo into a clean `baseUrl` + `auth`.
 *
 * INVARIANT — pure: no `process.env`, no I/O, no logging, no side effects.
 * Safe to call during config evaluation, in build steps, in tests. Do not
 * introduce env reads, fetch, or fs access here — those belong on the edge
 * (user config file, refresh-snapshots.ts).
 *
 * Throws `InvalidArgumentError` on malformed URL or missing userinfo
 * (`argument: 'url'`). Original URL is NOT included in the error message
 * (credential-leakage guard).
 *
 * @public
 */
export function parseConnectionUrl(url: string): {
  baseUrl: string
  auth: { username: string; password: string }
} {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    // `cause` deliberately omitted: Node's ERR_INVALID_URL carries the raw
    // input on `.input` (surfaced via util.inspect / console.log), which
    // would leak credentials when the URL contains userinfo.
    throw new InvalidArgumentError('Invalid URL — see RFC 3986 syntax', {
      argument: 'url',
    })
  }
  if (parsed.username === '' || parsed.password === '') {
    throw new InvalidArgumentError('URL must contain credentials in user:password@host form', {
      argument: 'url',
    })
  }
  const username = decodeURIComponent(parsed.username)
  const password = decodeURIComponent(parsed.password)
  const pathname = normalizeBaseUrl(parsed.pathname)
  const baseUrl = `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}`
  return { baseUrl, auth: { username, password } }
}

/**
 * Validate a Connection: throws InvalidArgumentError on the first failed
 * check. Use in tests and programmatic flows when constructing Connection
 * manually. CLI `loadConfig` calls this internally.
 *
 * @public
 */
export function validateConnection(c: unknown): asserts c is Connection {
  if (!c || typeof c !== 'object') {
    throw new InvalidArgumentError('Connection must be an object', { received: c })
  }
  const conn = c as Partial<Connection>

  if (!conn.baseUrl || typeof conn.baseUrl !== 'string') {
    throw new InvalidArgumentError('Connection.baseUrl is required (non-empty string)', {
      argument: 'baseUrl',
      received: conn.baseUrl,
    })
  }
  let parsedUrl: URL
  try {
    parsedUrl = new URL(conn.baseUrl)
  } catch {
    // `cause` deliberately omitted: Node's ERR_INVALID_URL carries the raw
    // input on `.input`, which would leak credentials via util.inspect.
    throw new InvalidArgumentError('Connection.baseUrl is not a valid URL', { argument: 'baseUrl' })
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new InvalidArgumentError(
      'Connection.baseUrl must NOT contain credentials — use parseConnectionUrl() or set auth explicitly',
      { argument: 'baseUrl' },
    )
  }

  if (!conn.auth || typeof conn.auth !== 'object') {
    throw new InvalidArgumentError('Connection.auth is required', { argument: 'auth' })
  }
  if (!conn.auth.username || typeof conn.auth.username !== 'string') {
    throw new InvalidArgumentError('Connection.auth.username must be a non-empty string', {
      argument: 'auth.username',
    })
  }
  if (!conn.auth.password || typeof conn.auth.password !== 'string') {
    throw new InvalidArgumentError('Connection.auth.password must be a non-empty string', {
      argument: 'auth.password',
    })
  }

  if (!conn.serverTimezone || typeof conn.serverTimezone !== 'string') {
    throw new InvalidArgumentError('Connection.serverTimezone is required (IANA timezone, e.g. "Europe/Moscow")', {
      argument: 'serverTimezone',
      received: conn.serverTimezone,
    })
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: conn.serverTimezone })
  } catch {
    throw new InvalidArgumentError('Connection.serverTimezone is not a valid IANA timezone', {
      argument: 'serverTimezone',
      received: conn.serverTimezone,
    })
  }
}

/**
 * Build the materialised BasicAuth from a Connection's auth pair. The single
 * source of truth for connection-driven auth construction.
 *
 * @public
 */
export function connectionAuth(conn: Pick<Connection, 'auth'>): AuthOptions {
  return BasicAuth({ username: conn.auth.username, password: conn.auth.password })
}
