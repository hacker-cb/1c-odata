import { parseOptsFor, parseV3Collection, parseV3Count } from '../parser.js'
import { assertPositiveInt, QueryBuilder } from '../query/builder.js'
import { buildV3CollectionUrl, buildV3CountUrl } from '../url-builder.js'
import type { RequestOptions } from './options.js'
import type { ODataV3Client } from './v3-client.js'

/**
 * V3-aware QueryBuilder subclass. Adds terminal methods (get/raw/count/stream).
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
