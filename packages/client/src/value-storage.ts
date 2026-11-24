import type { TransportClient } from './client/contract.js'
import type { RequestOptions } from './client/options.js'
import { buildV3KeyUrl, type EntityKey, encodeSegment, formatKey } from './url-builder.js'

export interface ReadStreamResult {
  /** `Content-Type` header value, or `null` if the server omitted it. */
  contentType: string | null
  /** Raw body stream (e.g. for piping into a file or further parsing). */
  body: ReadableStream<Uint8Array>
}

/**
 * Build the `<base>/<EntitySet>(<key>)/<prop>/$value` URL.
 *
 * Note: NO `$format=...` query param — this endpoint returns binary, not JSON.
 * (`buildV3KeyUrl` always appends `?$format=...`, which would be wrong here
 * AND would also corrupt the `/<prop>/$value` suffix order.)
 */
function buildValueUrl(base: string, entitySet: string, key: EntityKey, prop: string): string {
  const keyExpr = formatKey(key)
  return `${base}/${encodeSegment(entitySet)}(${keyExpr})/${encodeSegment(prop, 'property')}/$value`
}

/**
 * GET `<entity>/<prop>/$value` — returns binary content + Content-Type.
 *
 * Used for reading `ХранилищеЗначения` properties whose payload doesn't ship
 * inline in JSON responses (see spec §4.8).
 *
 * Uses `client.transportStream` (NOT `transportFetch`) because the standard
 * transport buffers the body via `response.text()`, which corrupts non-UTF-8
 * byte sequences. Goes through `requestStream` from `./http/transport.js`, so
 * timeout/hooks all apply. Errors are mapped to the typed
 * `ODataError` hierarchy (e.g. `PermissionError`, `HTTPError`) by
 * `requestStream` itself.
 *
 * @internal
 */
export async function readStream(
  client: TransportClient,
  entitySet: string,
  key: EntityKey,
  prop: string,
  opts: RequestOptions = {},
): Promise<ReadStreamResult> {
  const url = buildValueUrl(client.baseUrl, entitySet, key, prop)
  const resp = await client.transportStream(url, opts)
  return {
    contentType: resp.headers.get('content-type'),
    body: resp.body ?? new ReadableStream({ start: (controller) => controller.close() }),
  }
}

export interface WriteStreamInput {
  /** `<prop>_Type` value — typically a MIME type like 'image/jpeg' or 'application/xml+xdto'. */
  contentType: string
  /** `<prop>_Base64Data` payload (base64-encoded bytes). */
  base64Data: string
}

/**
 * Write `ХранилищеЗначения` content via PATCH on the entity, setting
 * `<prop>_Type` and `<prop>_Base64Data`. See spec §4.8.
 *
 * Cyrillic property names (e.g. `ФайлХранилище`) are emitted verbatim as JSON
 * keys in the body — `JSON.stringify` produces UTF-8 unescaped, and the 1С
 * server accepts Cyrillic identifiers as-is.
 *
 * @internal
 */
export async function writeStream(
  client: TransportClient,
  entitySet: string,
  key: EntityKey,
  prop: string,
  input: WriteStreamInput,
  opts: RequestOptions = {},
): Promise<void> {
  const url = buildV3KeyUrl(client.baseUrl, entitySet, key)
  const body: Record<string, string> = {
    [`${prop}_Type`]: input.contentType,
    [`${prop}_Base64Data`]: input.base64Data,
  }
  await client.transportPatch(url, body, opts, entitySet)
}
