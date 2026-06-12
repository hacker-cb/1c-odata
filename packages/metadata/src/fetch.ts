import {
  type AuthOptions,
  type Connection,
  connectionAuth,
  type MetadataIndex,
  normalizeBaseUrl,
} from '@1c-odata/client'
import { request } from '@1c-odata/client/internal'
import { buildMetadataIndex } from './index-builder.js'
import { parseEdmx } from './parser/edmx-parser.js'

/** Default `$metadata` download timeout (ms) — mirrors the CLI's `fetchTimeout` default. */
const DEFAULT_FETCH_TIMEOUT = 120_000

/**
 * Options for {@link fetchMetadataXml}.
 *
 * @public
 */
export interface FetchMetadataXmlOptions {
  baseUrl: string
  /** Materialised auth (use `connectionAuth(conn)` for Connection-driven flows). */
  auth: AuthOptions
  /** Download timeout (ms). Default: 120 000 — `$metadata` is 10+ MB on real bases. */
  timeout?: number
  /** Abort the download externally (combined with the timeout signal). */
  signal?: AbortSignal
}

/**
 * Fetch `$metadata` XML from a 1С OData endpoint via Basic auth.
 *
 * Returns the raw XML body. Non-2xx responses surface as a typed `HTTPError`
 * (or one of its subclasses such as `PermissionError`) thrown from
 * `@1c-odata/client`'s transport pipeline — see `mapResponseToError`. The
 * thrown error's message includes the status code.
 *
 * @public
 */
export async function fetchMetadataXml(opts: FetchMetadataXmlOptions): Promise<string> {
  const trimmedBase = normalizeBaseUrl(opts.baseUrl)
  const url = `${trimmedBase}/$metadata`
  const raw = await request(
    {
      method: 'GET',
      url,
      headers: {
        Authorization: opts.auth.header,
        Accept: 'application/xml',
      },
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    },
    { timeout: opts.timeout ?? DEFAULT_FETCH_TIMEOUT },
  )
  return raw.body
}

/**
 * Options for {@link fetchMetadataIndex}.
 *
 * @public
 */
export interface FetchMetadataIndexOptions {
  /** Download timeout (ms). Default: `conn.fetchTimeout`, then 120 000. */
  timeout?: number
  /** Abort the download externally. */
  signal?: AbortSignal
  /**
   * Entity-type whitelist predicate — see
   * `BuildMetadataIndexOptions.filter`. Default: the full model.
   */
  filter?: (entityTypeName: string) => boolean
}

/**
 * Download `$metadata` from the connection's base and build a runtime
 * {@link MetadataIndex} in one step: `fetchMetadataXml` → `parseEdmx` →
 * `buildMetadataIndex` (with `conn.shape` applied).
 *
 * The result is plain JSON-serializable data — cache it with
 * `JSON.stringify` and revive with `parseMetadataIndex` from
 * `@1c-odata/client` to skip the (~seconds for a 15 MB EDMX) re-download
 * and re-parse on subsequent startups.
 *
 * @public
 */
export async function fetchMetadataIndex(
  conn: Connection,
  opts: FetchMetadataIndexOptions = {},
): Promise<MetadataIndex> {
  const xml = await fetchMetadataXml({
    baseUrl: conn.baseUrl,
    auth: connectionAuth(conn),
    timeout: opts.timeout ?? conn.fetchTimeout ?? DEFAULT_FETCH_TIMEOUT,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  })
  const model = parseEdmx(xml)
  return buildMetadataIndex(model, {
    ...(conn.shape !== undefined ? { shape: conn.shape } : {}),
    ...(opts.filter !== undefined ? { filter: opts.filter } : {}),
  })
}
