// packages/client/src/client/v3-handles.ts

import { assertExpectedVersion } from '../concurrency.js'
import { buildFunctionUrl } from '../functions.js'
import { parseOptsFor, parseV3Single } from '../parser.js'
import { buildV3KeyUrl, type EntityKey } from '../url-builder.js'
import { type ReadStreamResult, readStream, type WriteStreamInput, writeStream } from '../value-storage.js'
import type { MutationOptions, RequestOptions } from './options.js'
import type { ODataV3Client } from './v3-client.js'

/**
 * V3 entity-set-level handle. Currently exposes only `.create(body)` (POST to set).
 * Returned by `client.entity(set)` without a key.
 */
export class V3EntitySetHandle<T> {
  private extraHeaders: Record<string, string> = {}

  constructor(
    private readonly client: ODataV3Client<unknown>,
    private readonly entitySet: string,
  ) {}

  /**
   * Chainable: add a header to subsequent mutations on this handle.
   *
   * Headers merge case-insensitively against `baseHeaders` — for example,
   * `.withHeader('authorization', '...')` overrides the library's `Authorization`
   * basic-auth header regardless of casing. Later `withHeader` calls override
   * earlier ones on the same case-insensitive name.
   *
   * Library-managed headers **cannot** be overridden on write operations:
   * `Content-Type` (always `application/json` when there's a body) and
   * `Content-Length` (computed from body byte length) win against any
   * `withHeader` attempt.
   */
  withHeader(name: string, value: string): this {
    this.extraHeaders[name] = value
    return this
  }

  /** POST a new entity. Returns the full entity (including auto-`Ref_Key` + `DataVersion`). */
  async create(body: Partial<T>, opts: RequestOptions = {}): Promise<T> {
    this.client.validateBeforeWrite(this.entitySet, body)
    const url = `${this.client.baseUrl}/${this.entitySet}`
    const raw = await this.client.transportPost(url, body, opts, this.entitySet, this.extraHeaders)
    return parseV3Single<T>(raw.body, parseOptsFor(this.client, this.entitySet))
  }
}

/**
 * V3-aware entity handle. Supports GET + the full mutation surface
 * (patch / put / delete / markForDeletion / unmarkForDeletion / writeStream).
 *
 * Pass `{ expectVersion: v }` in `MutationOptions` to enable per-mutation
 * optimistic-concurrency: the library issues a GET, compares `DataVersion`,
 * and throws `ConcurrencyError` before the mutation if they differ.
 */
export class V3EntityHandle<T> {
  private extraHeaders: Record<string, string> = {}

  constructor(
    private readonly client: ODataV3Client<unknown>,
    private readonly entitySet: string,
    private readonly key: EntityKey,
  ) {}

  /**
   * Chainable: add a header to subsequent mutations on this handle. Headers
   * persist across mutations on the same handle.
   *
   * Merge semantics match `V3EntitySetHandle.withHeader`: case-insensitive
   * override against `baseHeaders` (e.g. `.withHeader('authorization', ...)`
   * overrides the basic-auth header), later `withHeader` calls win against
   * earlier ones on the same case-insensitive name, and the library-managed
   * `Content-Type` / `Content-Length` headers win against any `withHeader`
   * attempt on write operations.
   */
  withHeader(name: string, value: string): this {
    this.extraHeaders[name] = value
    return this
  }

  async get(opts: RequestOptions = {}): Promise<T> {
    const url = buildV3KeyUrl(this.client.baseUrl, this.entitySet, this.key)
    const raw = await this.client.transportGet(url, opts)
    return parseV3Single<T>(raw.body, parseOptsFor(this.client, this.entitySet))
  }

  /** Partial update via PATCH. Returns the full updated entity. */
  async patch(body: Partial<T>, opts: MutationOptions = {}): Promise<T> {
    this.client.validateBeforeWrite(this.entitySet, body)
    if (opts.expectVersion !== undefined) {
      await assertExpectedVersion(this.client, this.entitySet, this.key, opts.expectVersion, opts)
    }
    const url = buildV3KeyUrl(this.client.baseUrl, this.entitySet, this.key)
    const raw = await this.client.transportPatch(url, body, opts, this.entitySet, this.extraHeaders)
    return parseV3Single<T>(raw.body, parseOptsFor(this.client, this.entitySet))
  }

  /** Full replacement via PUT. Returns the full updated entity. */
  async put(body: T, opts: MutationOptions = {}): Promise<T> {
    this.client.validateBeforeWrite(this.entitySet, body)
    if (opts.expectVersion !== undefined) {
      await assertExpectedVersion(this.client, this.entitySet, this.key, opts.expectVersion, opts)
    }
    const url = buildV3KeyUrl(this.client.baseUrl, this.entitySet, this.key)
    const raw = await this.client.transportPut(url, body, opts, this.entitySet, this.extraHeaders)
    return parseV3Single<T>(raw.body, parseOptsFor(this.client, this.entitySet))
  }

  /** Physical DELETE. Returns void on 204. */
  async delete(opts: MutationOptions = {}): Promise<void> {
    if (opts.expectVersion !== undefined) {
      await assertExpectedVersion(this.client, this.entitySet, this.key, opts.expectVersion, opts)
    }
    const url = buildV3KeyUrl(this.client.baseUrl, this.entitySet, this.key)
    await this.client.transportDelete(url, opts, this.entitySet, this.extraHeaders)
  }

  /** PATCH `DeletionMark: true`. NOT cascading (one-record flag flip). */
  async markForDeletion(opts: MutationOptions = {}): Promise<T> {
    return this.patch({ DeletionMark: true } as unknown as Partial<T>, opts)
  }

  /** PATCH `DeletionMark: false`. */
  async unmarkForDeletion(opts: MutationOptions = {}): Promise<T> {
    return this.patch({ DeletionMark: false } as unknown as Partial<T>, opts)
  }

  /** Read `ХранилищеЗначения` content via GET `<entity>/<prop>/$value`. */
  async readStream(prop: string, opts: RequestOptions = {}): Promise<ReadStreamResult> {
    return readStream(this.client, this.entitySet, this.key, prop, opts)
  }

  /** Write `ХранилищеЗначения` content via PATCH (sets `<prop>_Type` and `<prop>_Base64Data`). */
  async writeStream(prop: string, input: WriteStreamInput, opts: MutationOptions = {}): Promise<void> {
    if (opts.expectVersion !== undefined) {
      await assertExpectedVersion(this.client, this.entitySet, this.key, opts.expectVersion, opts)
    }
    return writeStream(this.client, this.entitySet, this.key, prop, input, opts)
  }
}

/**
 * Typed helper for document operations. Sugar over `client.functions[set].Post`
 * and `Unpost`. Spec §4.5 — instance-bound write FIs that take `ref` as the
 * primary identifier.
 */
export class V3DocumentHandle {
  constructor(
    private readonly client: ODataV3Client<unknown>,
    private readonly entitySet: string,
    private readonly key: string,
  ) {}

  /** Post (provesti) the document. URL: `<set>(<key>)/Post()?args`. */
  async post(args: Record<string, unknown> = {}): Promise<void> {
    const url = buildFunctionUrl(
      this.client.baseUrl,
      this.entitySet,
      'Post',
      { ref: this.key },
      args,
      this.client.serverTimezone,
    )
    await this.client.transportPost(url, undefined, {}, this.entitySet)
  }

  /** Unpost (otmenit' provedenie) the document. URL: `<set>(<key>)/Unpost()`. */
  async unpost(): Promise<void> {
    const url = buildFunctionUrl(
      this.client.baseUrl,
      this.entitySet,
      'Unpost',
      { ref: this.key },
      {},
      this.client.serverTimezone,
    )
    await this.client.transportPost(url, undefined, {}, this.entitySet)
  }
}
