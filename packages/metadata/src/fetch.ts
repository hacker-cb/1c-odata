import {
  type AuthOptions,
  type Connection,
  connectionAuth,
  MetadataError,
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
  assertEdmxResponse(raw, url)
  return raw.body
}

/**
 * Guard against a non-EDMX 2xx response — the most common dynamic-path failure
 * is an unauthenticated request being redirected to an HTML login/portal page,
 * or a wrong base URL serving `index.html`. Without this the body flows into
 * `parseEdmx` and surfaces as a cryptic "Expected <edmx:Edmx> root element".
 * Fail loudly with the URL, status, content-type, and a body snippet instead.
 */
function assertEdmxResponse(raw: { status: number; headers: Record<string, string>; body: string }, url: string): void {
  const head = raw.body.replace(/^﻿/, '').trimStart().slice(0, 512)
  const lower = head.toLowerCase()
  const looksLikeXml = head.startsWith('<') && !lower.startsWith('<!doctype html') && !lower.startsWith('<html')
  if (looksLikeXml) return // looks like XML/EDMX — let parseEdmx do the precise check
  const contentType = raw.headers['content-type'] ?? '(none)'
  const snippet = head.slice(0, 200).replace(/\s+/g, ' ').trim()
  throw new MetadataError(
    `Expected EDMX ($metadata) XML from ${url}, but the response was not XML (status ${raw.status}, content-type ${contentType}). The base URL is likely wrong, or an unauthenticated request was redirected to an HTML login page. First bytes: ${snippet}`,
    { request: { method: 'GET', url } },
  )
}

/**
 * Options for {@link fetchMetadataIndex}.
 *
 * @public
 */
export interface FetchMetadataIndexOptions {
  /** Download timeout (ms). Default: 120 000. */
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
    timeout: opts.timeout ?? DEFAULT_FETCH_TIMEOUT,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  })
  const model = parseEdmxWithContext(xml, `${normalizeBaseUrl(conn.baseUrl)}/$metadata`)
  return buildMetadataIndex(model, {
    ...(conn.shape !== undefined ? { shape: conn.shape } : {}),
    ...(opts.filter !== undefined ? { filter: opts.filter } : {}),
  })
}

/**
 * Parse fetched EDMX, attaching the source URL to any `MetadataError` that
 * doesn't already carry request context. Without this, a parse failure on a
 * live `$metadata` gives no hint which base produced the bad XML — the first
 * thing you need in a multi-target / multi-tenant setup.
 */
function parseEdmxWithContext(xml: string, url: string): ReturnType<typeof parseEdmx> {
  try {
    return parseEdmx(xml)
  } catch (e) {
    if (e instanceof MetadataError && e.request === undefined) {
      throw new MetadataError(e.message, { request: { method: 'GET', url }, cause: e })
    }
    throw e
  }
}
