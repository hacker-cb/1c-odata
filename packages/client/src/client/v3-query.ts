import { InvalidArgumentError } from '../errors.js'
import { parseOptsFor, parseV3Collection, parseV3Count } from '../parser.js'
import {
  buildKeyFilter,
  chunkKeyValues,
  dedupeKeys,
  type KeyValue,
  type KeyValueFor,
  mapBounded,
} from '../query/batch.js'
import { QueryBuilder } from '../query/builder.js'
import { assertPositiveInt } from '../query/validate.js'
import { buildV3CollectionUrl, buildV3CountUrl } from '../url-builder.js'
import type { RequestOptions } from './options.js'
import type { ODataV3Client } from './v3-client.js'

/**
 * Default total query-string byte budget for one `getByKeys` batch. Conservative:
 * well under the IIS `maxQueryString` default of 2048 bytes. Each batch's ACTUAL
 * rendered query string is measured against this, so the limit is enforced
 * exactly (no byte estimation). Callers can raise it via `opts.queryBudget`.
 */
const DEFAULT_QUERY_BUDGET = 1500
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
   * Force a fixed maximum number of keys per batch — exactly
   * `ceil(keys / batchSize)` requests. Bypasses the measured query-string budget,
   * so the caller takes responsibility for staying under the server's URL limit.
   */
  batchSize?: number
  /**
   * Total query-string byte budget per request (default 1500). Keys are packed
   * so each batch's ACTUAL rendered query string stays at or under this, leaving
   * headroom below the IIS `maxQueryString` default of 2048. Ignored when
   * `batchSize` is set.
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
   * Splits `values` into batches whose ACTUAL rendered query string stays within
   * `queryBudget` (default 1500 bytes — well below the IIS `maxQueryString`
   * default of 2048; the length is measured, not estimated), issues them with
   * bounded concurrency, and concatenates every batch's `.value`. 1С OData V3 has
   * no usable `in` operator, so each batch is a chunked `field eq <lit> or …`
   * filter — GUID-shaped values are emitted as `guid'…'` automatically.
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
   *   is set but not a positive integer, or if a single key's rendered query
   *   string already exceeds `queryBudget` (a `$select`/`$expand` so large that
   *   chunking cannot help — trim the projection or raise `queryBudget`).
   */
  async getByKeys<K extends keyof T & string>(
    field: K,
    values: readonly KeyValueFor<T, K>[],
    opts: GetByKeysOptions = {},
  ): Promise<T[]> {
    if (opts.batchSize !== undefined) assertPositiveInt(opts.batchSize, 'getByKeys({ batchSize })')
    if (opts.queryBudget !== undefined) assertPositiveInt(opts.queryBudget, 'getByKeys({ queryBudget })')
    if (opts.concurrency !== undefined) assertPositiveInt(opts.concurrency, 'getByKeys({ concurrency })')

    const unique = dedupeKeys(values as readonly KeyValue[])
    if (unique.length === 0) return []

    const batches =
      opts.batchSize !== undefined
        ? this.fixedBatches(unique, opts.batchSize)
        : this.measuredBatches(field, unique, opts.queryBudget ?? DEFAULT_QUERY_BUDGET)

    const reqOpts: RequestOptions = {
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
      ...(opts.retry !== undefined ? { retry: opts.retry } : {}),
    }
    const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY
    const pages = await mapBounded(batches, concurrency, (batch) => this.fetchKeyBatch(field, batch, reqOpts))
    return pages.flat()
  }

  /** Fixed-size batches (caller-controlled, no budget guarantee). @internal */
  private fixedBatches(keys: readonly KeyValue[], batchSize: number): KeyValue[][] {
    return chunkKeyValues(keys, { batchSize })
  }

  /**
   * Budget-driven batches: pack keys until a batch's ACTUAL rendered query
   * string would exceed `budget`. The url-builder is the single source of truth,
   * so the limit is enforced exactly — no byte/encoding/parenthesisation
   * estimation. A lone key whose own query string is over budget can't be
   * chunked away, so surface it as an actionable error. @internal
   */
  private measuredBatches(field: string, keys: readonly KeyValue[], budget: number): KeyValue[][] {
    const fits = (batch: readonly KeyValue[]): boolean => this.keyBatchQueryLen(field, batch) <= budget
    const batches = chunkKeyValues(keys, { fits })
    const overBudget = batches.find((b) => b.length === 1 && !fits(b))
    if (overBudget) {
      const got = this.keyBatchQueryLen(field, overBudget)
      throw new InvalidArgumentError(
        `getByKeys: a single key's query string (~${got} bytes) exceeds queryBudget=${budget}; ` +
          `trim $select/$expand or raise queryBudget (keep it under ~2048)`,
        { argument: 'queryBudget', received: budget },
      )
    }
    return batches
  }

  /** A projection clone with the batch's key filter set — used to measure and to fetch. @internal */
  private batchQuery(field: string, batch: readonly KeyValue[]): V3QueryBuilder<T> {
    const q = this.cloneProjection()
    q.state.filter = buildKeyFilter(this.state.filter, field, batch, this.serverTimezone)
    return q
  }

  /**
   * Length of one batch's query string AS THE WIRE SEES IT (excluding the leading
   * `?`). Measured through `new URL(...)`, the same normalization `fetch` applies
   * before sending — crucially, for an `http(s)` URL it percent-encodes `'` →
   * `%27`, so the apostrophes in `guid'…'` literals count at their true sent
   * length. Measuring the raw builder string instead would under-count. @internal
   */
  private keyBatchQueryLen(field: string, batch: readonly KeyValue[]): number {
    const url = buildV3CollectionUrl(this.client.baseUrl, this.batchQuery(field, batch))
    const search = new URL(url).search
    return search.length > 0 ? search.length - 1 : 0
  }

  /** Run one `getByKeys` batch: build the batch query and GET its `.value`. @internal */
  private async fetchKeyBatch(field: string, batch: readonly KeyValue[], opts: RequestOptions): Promise<T[]> {
    const { value } = await this.batchQuery(field, batch).get(opts)
    return value
  }

  /**
   * Build a fresh builder carrying only the projection state — `$select` /
   * `$expand` / `$orderby`. Deliberately drops `top` / `skip` / `inlineCount`,
   * which don't compose with batching; the key `filter` is set by the caller. @internal
   */
  private cloneProjection(): V3QueryBuilder<T> {
    const q = new V3QueryBuilder<T>(this.entitySet, this.client)
    if (this.state.select) q.state.select = this.state.select
    if (this.state.expand) q.state.expand = this.state.expand
    if (this.state.orderBy) q.state.orderBy = this.state.orderBy
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
