import { InvalidArgumentError } from '../errors.js'
import { parseOptsFor, parseV3Collection, parseV3Count } from '../parser.js'
import {
  buildKeyFilter,
  chunkKeyValues,
  DEFAULT_QUERY_BUDGET,
  dedupeKeys,
  type KeyValue,
  mapBounded,
} from '../query/batch.js'
import { QueryBuilder } from '../query/builder.js'
import { assertPositiveInt } from '../query/validate.js'
import { buildV3CollectionUrl, buildV3CountUrl } from '../url-builder.js'
import type { RequestOptions } from './options.js'
import type { ODataV3Client } from './v3-client.js'

/**
 * Smallest per-batch key-filter budget (URL-encoded bytes) that still fits at
 * least one GUID term (`(Ref_Key eq guid'…')` ≈ 63 bytes). If the fixed query
 * parts leave less than this, no key chunking can keep the request under the
 * limit — `getByKeys` throws instead of silently shipping an over-long URL.
 */
const MIN_FILTER_BUDGET = 64
/**
 * Bytes reserved for `$filter=` join syntax that `fixedQueryLen()` does not
 * capture: the `&$filter=` key when no prior filter exists, or the ` and (…)`
 * wrapper (plus possible parens around an `or`-bearing existing filter) when one
 * does. Subtracting it keeps each batch's TOTAL query string within `queryBudget`
 * even with an existing `.filter(...)`.
 */
const FILTER_SYNTAX_OVERHEAD = 32
/** Default number of concurrent batch requests. */
const DEFAULT_CONCURRENCY = 4

/**
 * Options for {@link V3QueryBuilder.getByKeys}. Extends `RequestOptions`
 * (signal / timeout / retry apply to every batch request).
 *
 * @public
 */
export interface GetByKeysOptions extends RequestOptions {
  /**
   * Force a fixed maximum number of keys per batch. Overrides the automatic
   * query-string budget estimation — exactly `ceil(keys / batchSize)` requests.
   */
  batchSize?: number
  /**
   * Total query-string byte budget per request (default 1500). The key OR-chain
   * is packed to keep the whole query string under this, leaving headroom below
   * the IIS `maxQueryString` default of 2048. Ignored when `batchSize` is set.
   */
  queryBudget?: number
  /** Maximum concurrent batch requests (default 4). */
  concurrency?: number
}

/**
 * V3-aware QueryBuilder subclass. Adds terminal methods
 * (get/raw/count/stream/getByKeys).
 */
export class V3QueryBuilder<T> extends QueryBuilder<T> {
  constructor(
    entitySet: string,
    private readonly client: ODataV3Client<unknown>,
  ) {
    super(entitySet, client.serverTimezone)
  }

  /** Execute the query and return parsed `{ value, count?, odataMetadata }`. */
  async get(opts: RequestOptions = {}): Promise<{ odataMetadata: string; value: T[]; count?: number }> {
    const url = buildV3CollectionUrl(this.client.baseUrl, this)
    const raw = await this.client.transportGet(url, opts)
    return parseV3Collection<T>(raw.body, parseOptsFor(this.client, this.entitySet))
  }

  /**
   * Fetch many records by a key field WITHOUT hand-building giant `or` chains
   * or tripping the server's URL/query-string limit.
   *
   * Splits `values` into batches (each sized to keep the query string under
   * `queryBudget`, default 1500 bytes — well below the IIS `maxQueryString`
   * default of 2048), issues them with bounded concurrency, and concatenates
   * every batch's `.value`. 1С OData V3 has no usable `in` operator, so each
   * batch is a chunked `field eq <lit> or …` filter — GUID-shaped values are
   * emitted as `guid'…'` automatically.
   *
   * `$select` / `$expand` / `$orderby` and any prior `.filter(...)` are applied
   * to EVERY batch (the key filter is AND-combined with an existing filter).
   * `.top()` / `.skip()` are ignored — they don't compose with key batching.
   *
   * **Semantics:**
   * - **Dedup** — duplicate `values` are collapsed (first occurrence wins); each
   *   distinct key is queried once.
   * - **Order** — results follow batch order (≈ input order with a fixed
   *   `batchSize`), then server order within each batch. 1С does NOT guarantee
   *   row order without `.orderBy()`; set one, or re-map by key client-side, if
   *   you need a specific order.
   * - **Missing keys** — keys with no matching record are simply absent (no
   *   error, no placeholder), so the result length may be `< values.length`.
   *
   * @throws {InvalidArgumentError} if `batchSize` / `queryBudget` / `concurrency`
   *   is set but not a positive integer, or if `$select`/`$expand`/`$filter` are
   *   so large that fewer than ~64 bytes remain for keys under `queryBudget`
   *   (trim the projection or raise `queryBudget`).
   */
  async getByKeys<K extends keyof T & string>(
    field: K,
    values: readonly KeyValue[],
    opts: GetByKeysOptions = {},
  ): Promise<T[]> {
    if (opts.batchSize !== undefined) assertPositiveInt(opts.batchSize, 'getByKeys({ batchSize })')
    if (opts.queryBudget !== undefined) assertPositiveInt(opts.queryBudget, 'getByKeys({ queryBudget })')
    if (opts.concurrency !== undefined) assertPositiveInt(opts.concurrency, 'getByKeys({ concurrency })')

    const unique = dedupeKeys(values)
    if (unique.length === 0) return []

    // Size the per-batch key filter against the budget the fixed query parts
    // leave. Do NOT clamp UP to a floor — that would ship URLs past the IIS
    // limit (the exact failure this method prevents). If too little remains,
    // chunking keys cannot help, so fail with an actionable error.
    const queryBudget = opts.queryBudget ?? DEFAULT_QUERY_BUDGET
    const fixedLen = this.fixedQueryLen()
    const filterBudget = queryBudget - fixedLen - FILTER_SYNTAX_OVERHEAD
    if (filterBudget < MIN_FILTER_BUDGET) {
      throw new InvalidArgumentError(
        `getByKeys: $select/$expand/$orderby/$filter (~${fixedLen} bytes) leave only ${filterBudget} bytes for keys ` +
          `under queryBudget=${queryBudget}; trim $select/$expand or raise queryBudget (keep it under ~2048)`,
        { argument: 'queryBudget', received: queryBudget },
      )
    }
    const batches = chunkKeyValues(field, unique, this.serverTimezone, {
      ...(opts.batchSize !== undefined ? { batchSize: opts.batchSize } : {}),
      filterBudget,
    })

    const reqOpts: RequestOptions = {
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
      ...(opts.retry !== undefined ? { retry: opts.retry } : {}),
    }
    const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY
    const pages = await mapBounded(batches, concurrency, (batch) => this.fetchKeyBatch(field, batch, reqOpts))
    return pages.flat()
  }

  /** Run one `getByKeys` batch: clone the projection, set the key filter, GET. @internal */
  private async fetchKeyBatch(field: string, batch: readonly KeyValue[], opts: RequestOptions): Promise<T[]> {
    const q = this.cloneProjection()
    q.state.filter = buildKeyFilter(this.state.filter, field, batch, this.serverTimezone)
    const { value } = await q.get(opts)
    return value
  }

  /**
   * Encoded length of the current query string MINUS the key filter — i.e. the
   * fixed cost (`$format` + `$select` + `$expand` + `$orderby` + any existing
   * `$filter`) that every batch carries. Subtracted from `queryBudget` to size
   * the per-batch key filter. @internal
   */
  private fixedQueryLen(): number {
    const url = buildV3CollectionUrl(this.client.baseUrl, this.cloneProjection())
    const q = url.indexOf('?')
    return q >= 0 ? url.length - q - 1 : 0
  }

  /**
   * Build a fresh builder carrying only the projection state — `$select` /
   * `$expand` / `$orderby` (and `filter` when explicitly passed). Deliberately
   * drops `top` / `skip` / `inlineCount`, which don't compose with batching. @internal
   */
  private cloneProjection(filter = this.state.filter): V3QueryBuilder<T> {
    const q = new V3QueryBuilder<T>(this.entitySet, this.client)
    if (this.state.select) q.state.select = this.state.select
    if (this.state.expand) q.state.expand = this.state.expand
    if (this.state.orderBy) q.state.orderBy = this.state.orderBy
    if (filter) q.state.filter = filter
    return q
  }

  /** Escape hatch — return native `Response` without parsing. */
  async raw(opts: RequestOptions = {}): Promise<Response> {
    const url = buildV3CollectionUrl(this.client.baseUrl, this)
    return this.client.transportFetch(url, opts)
  }

  /** Standalone count via `/$count` endpoint. Preserves filter, ignores top/skip. */
  async count(opts: RequestOptions = {}): Promise<number> {
    const url = buildV3CountUrl(this.client.baseUrl, this)
    const raw = await this.client.transportGet(url, opts)
    return parseV3Count(raw.body)
  }

  /**
   * Async iterator paginating through the collection.
   *
   * Honours user-supplied `.top(N)` and `.skip(K)` from the builder state:
   * `.top(N)` caps the total number of yielded items, `.skip(K)` is the starting
   * offset. `pageSize` is the per-request transport detail and is independent.
   *
   * - `.top(N)` with N < pageSize: single request with `$top=N`.
   * - `.top(N)` not multiple of pageSize: last request shrinks to the remaining count.
   * - `.skip(K)`: first request issues `$skip=K`, subsequent requests advance from there.
   * - No `.top()` set: continues until server returns a short or empty page.
   *
   * Per-page timeout via `opts.timeout`; total budget via `opts.signal`.
   *
   * @throws {InvalidArgumentError} on first `.next()` if `opts.pageSize` is not a positive integer.
   */
  async *stream(opts: RequestOptions & { pageSize?: number } = {}): AsyncGenerator<T> {
    const pageSize = opts.pageSize ?? 100
    assertPositiveInt(pageSize, 'stream({ pageSize })')

    const userTop = this.state.top
    const userSkip = this.state.skip ?? 0

    if (userTop === 0) return

    let yielded = 0
    let offset = userSkip

    while (true) {
      const remaining = userTop !== undefined ? userTop - yielded : undefined
      if (remaining !== undefined && remaining <= 0) return

      const thisPageSize = remaining !== undefined ? Math.min(pageSize, remaining) : pageSize

      const page = await new V3QueryBuilder<T>(this.entitySet, this.client)
        ._cloneState(this)
        .top(thisPageSize)
        .skip(offset)
        .get({
          ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
          ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
          ...(opts.retry !== undefined ? { retry: opts.retry } : {}),
        })

      if (page.value.length === 0) return
      for (const item of page.value) {
        // Defensive cap: a server that ignores $top must not let us exceed userTop.
        if (userTop !== undefined && yielded >= userTop) return
        yield item
        yielded++
      }
      if (page.value.length < thisPageSize) return
      offset += page.value.length
    }
  }

  /** @internal */
  _cloneState(other: V3QueryBuilder<T>): this {
    Object.assign(this.state, other.state)
    return this
  }
}
