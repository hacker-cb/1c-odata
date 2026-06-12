// packages/client/src/client/v3-client.ts

import type { DataShape } from '../connection.js'
import { InvalidArgumentError } from '../errors.js'
import type { ODataV3FunctionsBase, WithInstanceRef } from '../functions.js'
import { requestWithRetry } from '../http/retry.js'
import { request, requestStream } from '../http/transport.js'
import { RegisterHelper } from '../register.js'
import { type EntityKey, normalizeBaseUrl } from '../url-builder.js'
import { type MetadataIndex, ValidationError, validateEntity } from '../validate.js'
import { bigintToStringReplacer, transformDatesToWire, transformDateValuesUntyped } from '../write-transform.js'
import type { ClientOptions, RequestOptions } from './options.js'
import { createFunctionsProxy } from './v3-functions-proxy.js'
import { V3DocumentHandle, V3EntityHandle, V3EntitySetHandle } from './v3-handles.js'
import { V3QueryBuilder } from './v3-query.js'

/**
 * V3-specific client options. Extends core's `ClientOptions` with optional
 * schema-driven behaviors powered by a runtime `MetadataIndex`.
 *
 * @public
 */
export interface ODataV3ClientOptions extends ClientOptions {
  /**
   * Runtime schema index. Any source conforming to the `MetadataIndex`
   * contract works: the codegen-emitted `__metadata.json` (via
   * `loadMetadataIndex`), an index built from a live `$metadata` at runtime
   * (`fetchMetadataIndex` / `buildMetadataIndex` from `@1c-odata/metadata`),
   * or a revived cache entry (`parseMetadataIndex`). Required when
   * `validateOnWrite` is `true`.
   */
  metadataIndex?: MetadataIndex
  /**
   * Opt-in: when `true`, every `.create()` / `.patch()` / `.put()` runs
   * `validateEntity` against the corresponding schema BEFORE issuing the
   * HTTP request. Defaults to `false` (no behaviour change).
   */
  validateOnWrite?: boolean
  /**
   * Override `metadataIndex?.shape` at runtime. Useful when running without
   * any schema (no `metadataIndex`) but still wanting a non-default
   * `dateMode` or `int64Mode` applied. Precedence: `shape` wins over
   * `metadataIndex.shape`.
   *
   * @example
   * ```ts
   * // schema-less client that leaves DateTime wire strings untouched:
   * const client = new ODataV3Client({
   *   baseUrl, auth, serverTimezone: 'Europe/Moscow',
   *   shape: { dateMode: 'string' },
   * })
   * ```
   *
   * @public
   */
  shape?: DataShape
}

const V3_BASE_HEADERS = {
  Accept: 'application/json;odata=nometadata',
  DataServiceVersion: '3.0',
  MaxDataServiceVersion: '3.0',
}

/**
 * Concrete V3 OData client.
 *
 * Generic over `TFunctions` — the codegen-emitted `Functions` interface that
 * shapes `client.functions.<EntitySet>.<Func>(args)` access. Defaults to
 * `ODataV3FunctionsBase`, an open-ended index signature; with a real type from
 * `@1c-odata/cli/codegen` the call sites become fully typed.
 *
 * Works without codegen: construct with just `baseUrl` / `auth` /
 * `serverTimezone` and query entity sets by name with
 * `query<UntypedEntity>(...)`. Add a `metadataIndex` (file, runtime fetch, or
 * cache — see `ODataV3ClientOptions.metadataIndex`) to enable schema-driven
 * Int64 / ValueStorage handling and write validation.
 *
 * @example
 * ```ts
 * // schema-less (no codegen, no metadata):
 * const client = new ODataV3Client({
 *   baseUrl: 'http://1c.example.com/base/odata/standard.odata',
 *   auth: BasicAuth({ username: 'user', password: 'pass' }),
 *   serverTimezone: 'Europe/Moscow',
 * })
 * const { value } = await client.query<UntypedEntity>('Catalog_Валюты').top(5).get()
 * ```
 *
 * @public
 */
export class ODataV3Client<TFunctions = ODataV3FunctionsBase> {
  /**
   * Two-level Proxy: `client.functions.<EntitySet>.<Func>(args)`.
   *
   * Heuristic: if `args.ref` is present → POST `<set>(<ref>)/<func>()` (write FI,
   * returns void). Otherwise → GET `<set>/<func>()` (read FI, returns
   * `parsed.value` array or the parsed body). This matches the 12 canonical FIs:
   * Post / Unpost / Start / ExecuteTask are instance-bound writes (need `ref`),
   * Balance / Turnovers / SliceLast / etc. are set-bound reads (no `ref`).
   */
  readonly functions: WithInstanceRef<TFunctions>

  /** Stored v3-specific options (superset of `ClientOptions`). */
  private readonly v3Opts: ODataV3ClientOptions

  /** @internal */
  protected readonly opts: ClientOptions

  constructor(opts: ODataV3ClientOptions) {
    if (!opts.baseUrl) {
      throw new InvalidArgumentError('ClientOptions.baseUrl is required', { argument: 'opts.baseUrl' })
    }
    if (!opts.auth) {
      throw new InvalidArgumentError('ClientOptions.auth is required', { argument: 'opts.auth' })
    }
    if (!opts.serverTimezone) {
      throw new InvalidArgumentError('ClientOptions.serverTimezone is required (IANA timezone, e.g. "Europe/Moscow")', {
        argument: 'opts.serverTimezone',
      })
    }
    if (opts.validateOnWrite && opts.metadataIndex === undefined) {
      throw new InvalidArgumentError(
        'validateOnWrite requires metadataIndex (loadMetadataIndex from generated __metadata.json, or fetchMetadataIndex from @1c-odata/metadata)',
        {
          argument: 'opts.metadataIndex',
        },
      )
    }
    this.opts = { ...opts, baseUrl: normalizeBaseUrl(opts.baseUrl) }
    this.v3Opts = opts
    this.functions = createFunctionsProxy(this) as WithInstanceRef<TFunctions>
  }

  /** Service root, normalized (no trailing slash). */
  get baseUrl(): string {
    return this.opts.baseUrl
  }

  /** IANA timezone of the 1С server (used for date round-tripping). */
  get serverTimezone(): string {
    return this.opts.serverTimezone
  }

  /** Runtime schema index (loaded from generated `__metadata.json`). */
  get metadataIndex(): MetadataIndex | undefined {
    return this.v3Opts.metadataIndex
  }

  /**
   * Effective DataShape — `opts.shape` (Connection-level override) or
   * `opts.metadataIndex?.shape` (codegen-emitted). Read by parser/write-
   * transform to apply `dateMode` / `int64Mode` transformations.
   *
   * @internal
   */
  get shape(): DataShape | undefined {
    return this.v3Opts.shape ?? this.v3Opts.metadataIndex?.shape
  }

  /**
   * Internal: validate a write payload against the codegen schema. No-op when
   * `validateOnWrite` is off. Forward-compat: silently skips entity sets that
   * are not in the loaded `entitySetToType` map (e.g. newer server schema).
   *
   * @internal
   */
  validateBeforeWrite(entitySet: string, body: unknown): void {
    if (!this.v3Opts.validateOnWrite) return
    const idx = this.v3Opts.metadataIndex
    if (idx === undefined) return // construction-time guard already enforced
    const typeName = idx.entitySetToType[entitySet]
    if (typeName === undefined) return // forward-compat: unknown set, skip
    const schema = idx.schemas[typeName]
    if (schema === undefined) return
    const r = validateEntity(body as Record<string, unknown>, schema)
    if (!r.ok) {
      throw new ValidationError(`Validation failed for ${entitySet}: ${r.errors.length} issue(s)`, { issues: r.errors })
    }
  }

  /**
   * Internal: transform a write body into wire form. Three-level rule:
   *
   * 1. Effective `dateMode: 'string'` → full passthrough (the `DataShape`
   *    contract promises the write path does not touch Edm.DateTime fields).
   * 2. Schema available (metadataIndex + known entity set) → schema-driven
   *    `transformDatesToWire`: `Date` → naive ISO in `serverTimezone`,
   *    `null` → `ONEC_EMPTY_DATE` sentinel, recursion into tabular parts;
   *    fields missing from the schema fall back to the value heuristic.
   * 3. No schema (no metadataIndex, or unknown entity set — forward-compat
   *    with newer server schemas) → value heuristic
   *    `transformDateValuesUntyped`: every `Date` instance → naive ISO in
   *    `serverTimezone`; `null` left as-is (no sentinel without a schema —
   *    pass `ONEC_EMPTY_DATE` explicitly to clear a date).
   *
   * `body === undefined` (DELETE) and non-object bodies pass through.
   *
   * @internal
   */
  private transformWriteBody(body: unknown, entitySet: string): unknown {
    if (body === undefined) return undefined
    if (typeof body !== 'object' || body === null) return body
    if ((this.shape?.dateMode ?? 'date') === 'string') return body
    const idx = this.v3Opts.metadataIndex
    const typeName = idx?.entitySetToType[entitySet]
    const schema = typeName !== undefined ? idx?.schemas[typeName] : undefined
    if (idx === undefined || schema === undefined) {
      return transformDateValuesUntyped(body, this.opts.serverTimezone)
    }
    return transformDatesToWire(body as Record<string, unknown>, schema, this.opts.serverTimezone, idx, 'date')
  }

  query<T = Record<string, unknown>>(entitySet: string): V3QueryBuilder<T> {
    return new V3QueryBuilder<T>(entitySet, this)
  }

  entity<T = Record<string, unknown>>(entitySet: string): V3EntitySetHandle<T>
  entity<T = Record<string, unknown>>(entitySet: string, key: EntityKey): V3EntityHandle<T>
  entity<T = Record<string, unknown>>(entitySet: string, key?: EntityKey): V3EntitySetHandle<T> | V3EntityHandle<T> {
    if (key === undefined) return new V3EntitySetHandle<T>(this, entitySet)
    return new V3EntityHandle<T>(this, entitySet, key)
  }

  /** Typed handle for document operations on a specific record. Spec §4.5. */
  document(entitySet: string, key: string): V3DocumentHandle {
    return new V3DocumentHandle(this, entitySet, key)
  }

  /**
   * Typed handle for register-style entity sets (Accumulation / Information /
   * Accounting / Calculation registers). Spec §4.7. Provides:
   *   - `recordsets()` — query the parent register EntitySet
   *   - `records()` — query `<set>_RecordType` (per-record movements)
   *   - `balance()` / `turnovers()` / `sliceLast()` / etc. — virtual-table FI wrappers
   */
  register<T = Record<string, unknown>>(entitySet: string): RegisterHelper<T> {
    return new RegisterHelper<T>(this, entitySet)
  }

  /**
   * Raw GET via transport. Used by V3QueryBuilder/V3EntityHandle.
   *
   * @internal
   */
  async transportGet(url: string, callOpts: RequestOptions) {
    return requestWithRetry(
      {
        method: 'GET',
        url,
        headers: this.baseHeaders(),
        ...(callOpts.signal !== undefined ? { signal: callOpts.signal } : {}),
      },
      { ...this.transportOpts(), ...callOpts },
    )
  }

  /**
   * Internal: serialize JSON body and run a write request through retry pipeline.
   *
   * `extraHeaders` (from `.withHeader(...)`) are merged case-insensitively;
   * library-managed `Content-Length` / `Content-Type` go LAST in the merge
   * so they win against any user override attempt.
   */
  private async transportWrite(
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    body: unknown,
    callOpts: RequestOptions,
    entitySet: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; statusText: string; body: string; headers: Record<string, string> }> {
    const transformed = this.transformWriteBody(body, entitySet)
    // bigint → wire string via replacer (Date can't be fixed here — toJSON
    // runs before the replacer; dates are handled in transformWriteBody).
    const serialized = transformed !== undefined ? JSON.stringify(transformed, bigintToStringReplacer) : ''
    const contentLength = String(Buffer.byteLength(serialized, 'utf8'))
    // Library-managed headers go LAST so they win the case-insensitive merge,
    // overriding any user attempt to set Content-Type / Content-Length via
    // withHeader().
    const libraryManaged: Record<string, string> =
      transformed !== undefined
        ? { 'Content-Length': contentLength, 'Content-Type': 'application/json' }
        : { 'Content-Length': contentLength }
    const headers = mergeHeadersCaseInsensitive(this.baseHeaders(), extraHeaders, libraryManaged)
    return requestWithRetry(
      {
        method,
        url,
        headers,
        ...(transformed !== undefined ? { body: serialized } : {}),
        ...(callOpts.signal !== undefined ? { signal: callOpts.signal } : {}),
      },
      { ...this.transportOpts(), ...callOpts },
    )
  }

  /** POST with JSON body. @internal */
  async transportPost(
    url: string,
    body: unknown,
    callOpts: RequestOptions,
    entitySet: string,
    extraHeaders: Record<string, string> = {},
  ) {
    return this.transportWrite('POST', url, body, callOpts, entitySet, extraHeaders)
  }

  /** PATCH with JSON body. @internal */
  async transportPatch(
    url: string,
    body: unknown,
    callOpts: RequestOptions,
    entitySet: string,
    extraHeaders: Record<string, string> = {},
  ) {
    return this.transportWrite('PATCH', url, body, callOpts, entitySet, extraHeaders)
  }

  /** PUT with JSON body. @internal */
  async transportPut(
    url: string,
    body: unknown,
    callOpts: RequestOptions,
    entitySet: string,
    extraHeaders: Record<string, string> = {},
  ) {
    return this.transportWrite('PUT', url, body, callOpts, entitySet, extraHeaders)
  }

  /** DELETE without body — explicit `Content-Length: 0` for IIS. @internal */
  async transportDelete(
    url: string,
    callOpts: RequestOptions,
    entitySet: string,
    extraHeaders: Record<string, string> = {},
  ) {
    return this.transportWrite('DELETE', url, undefined, callOpts, entitySet, extraHeaders)
  }

  /**
   * GET via transport (used by `.raw()`). Honors timeout, client signal, and
   * hooks but skips retry by design — `.raw()` is single-attempt. Returns a
   * synthesized `Response` from the parsed body so consumers retain the native
   * Response API.
   *
   * @internal
   */
  async transportFetch(url: string, callOpts: RequestOptions): Promise<Response> {
    const raw = await request(
      {
        method: 'GET',
        url,
        headers: this.baseHeaders(),
        ...(callOpts.signal !== undefined ? { signal: callOpts.signal } : {}),
      },
      { ...this.transportOpts(), ...callOpts },
    )
    return new Response(raw.body, {
      status: raw.status,
      statusText: raw.statusText,
      headers: raw.headers,
    })
  }

  /**
   * GET that returns the native `Response` with `body` left as an unread
   * `ReadableStream` — used by `readStream` for binary content
   * (`ХранилищеЗначения`).
   *
   * The standard `transportFetch`/`request` path buffers via `response.text()`,
   * which corrupts non-UTF-8 byte sequences (JPEG, PDF, XDTO, etc.). This
   * method goes through core's `requestStream`, which honours the same
   * per-call timeout, signal-combine, and hooks as `request()` — only the
   * body-consumption strategy differs.
   *
   * NOT integrated with retry by design — streaming + retry has body-replay
   * semantics that don't apply to V3's read-only stream endpoints.
   *
   * @internal
   */
  async transportStream(url: string, callOpts: RequestOptions): Promise<Response> {
    const result = await requestStream(
      {
        method: 'GET',
        url,
        headers: this.baseHeaders(),
        ...(callOpts.signal !== undefined ? { signal: callOpts.signal } : {}),
      },
      { ...this.transportOpts(), ...callOpts },
    )
    return result.response
  }

  protected baseHeaders(): Record<string, string> {
    return {
      ...V3_BASE_HEADERS,
      Authorization: this.opts.auth.header,
    }
  }

  protected transportOpts() {
    const { signal, timeout, retry, hooks } = this.opts
    return {
      ...(signal !== undefined ? { signal } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
      ...(retry !== undefined ? { retry } : {}),
      ...(hooks !== undefined ? { hooks } : {}),
    }
  }
}

/**
 * Merge header objects with case-insensitive deduplication: keys that
 * differ only in case are treated as the same header, and the later
 * occurrence wins (both name-case and value). Preserves the casing of
 * whichever override came last.
 *
 * The default JS spread `{ ...a, ...b }` is case-sensitive — `Authorization`
 * and `authorization` would both end up in the final object and the HTTP
 * transport would send two distinct headers, with server-side resolution
 * undefined. This helper guards against that.
 *
 * @internal
 */
export function mergeHeadersCaseInsensitive(...sources: readonly Record<string, string>[]): Record<string, string> {
  const out: Record<string, string> = {}
  const lowerToActual = new Map<string, string>()
  for (const source of sources) {
    for (const [k, v] of Object.entries(source)) {
      const lower = k.toLowerCase()
      const existing = lowerToActual.get(lower)
      if (existing !== undefined) delete out[existing]
      out[k] = v
      lowerToActual.set(lower, k)
    }
  }
  return out
}
