import { InvalidArgumentError } from '../errors.js'
import type { EntitySchema, MetadataIndex } from '../validate.js'
import { type CompileContext, type FieldExprMap, type FilterExpression, makeFieldProxy } from './filter-internal.js'

/**
 * Internal accumulated state of a query. Public for inspection by V3 url-builder
 * (which translates this into the wire URL).
 * @public
 */
export interface QueryState {
  filter?: FilterExpression
  select?: string[]
  expand?: string[]
  orderBy?: { field: string; dir: 'asc' | 'desc' }[]
  top?: number
  skip?: number
  inlineCount?: boolean
}

/**
 * Validate a non-negative integer setter argument. Throws `InvalidArgumentError`
 * with a clear message that names the parameter and shows the rejected value.
 *
 * Used by `.top()` and `.skip()` setters.
 *
 * @internal
 */
export function assertNonNegativeInt(value: number, paramName: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new InvalidArgumentError(`Invalid ${paramName}: must be a non-negative integer`, {
      argument: paramName,
      received: value,
    })
  }
}

/**
 * Validate a positive integer (>=1) argument. Same shape as
 * `assertNonNegativeInt` but rejects 0 too.
 *
 * Used by `stream({ pageSize })` to guard against infinite-loop pageSize=0.
 *
 * @internal
 */
export function assertPositiveInt(value: number, paramName: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new InvalidArgumentError(`Invalid ${paramName}: must be a positive integer`, {
      argument: paramName,
      received: value,
    })
  }
}

/**
 * Fluent query builder. Generic `T` is the expected entity shape; field names
 * in `filter` / `select` / `orderBy` autocomplete from `T`. Without `T`, falls
 * back to `Record<string, unknown>` and accepts any string.
 *
 * Terminals (`.get()`, `.raw()`, `.count()`, `.stream()`) live on the V3
 * subclass — this base only accumulates state.
 *
 * @public
 */
export class QueryBuilder<T = Record<string, unknown>> {
  readonly entitySet: string
  readonly state: QueryState = {}
  protected readonly serverTimezone: string

  constructor(entitySet: string, serverTimezone: string) {
    this.entitySet = entitySet
    this.serverTimezone = serverTimezone
  }

  /**
   * Apply a `$filter` expression. Builder receives a typed field-proxy for
   * `T`: write `f.Code.eq('X')` / `f.Сумма.gt(100)` etc. Combinators
   * (`and`/`or`/`not`/`any`/`all`/`raw`) live in the `@1c-odata/client/filter`
   * subpath. Date values are formatted in the server's IANA timezone so filter
   * literals match the server's wall-clock interpretation.
   *
   * **Footgun: field names on the proxy are NOT validated against the entity
   * schema.** A typo such as `f.Кодё.eq('X')` (when the field is actually
   * `Code`) generates `$filter=Кодё eq 'X'` — 1С silently returns an empty
   * result, no runtime error. Provide a precise `<T>` generic (e.g. an entity
   * type emitted by codegen) to get IDE autocomplete and compile-time
   * checks on field names.
   *
   * A string compared with a field holding a GUID is written `guid'…'`, as 1С
   * needs it: an `Edm.Guid` field by the client's `MetadataIndex`, or — without
   * one, or for a field it does not list — a reference named `*_Key`. Such a
   * string must have the GUID form (`InvalidArgumentError` otherwise); for any
   * other GUID field use `guid()` from `@1c-odata/client/filter`.
   */
  filter(fn: (f: FieldExprMap<T>) => FilterExpression): this {
    const schema = this.filterSchema()
    const ctx: CompileContext = {
      serverTimezone: this.serverTimezone,
      lambdaCounter: { value: 0 },
      metadataIndex: schema?.metadataIndex,
    }
    const f = makeFieldProxy<T>('', ctx, schema?.entity)
    this.state.filter = fn(f)
    return this
  }

  /**
   * The schema `filter()` reads field types from — the entity set's in the
   * client's `MetadataIndex`. None here; the V3 builder supplies it.
   *
   * @internal
   */
  protected filterSchema(): { metadataIndex: MetadataIndex; entity: EntitySchema } | undefined {
    return undefined
  }

  /**
   * Comma-separated `$select`. `'**'` excludes tabular parts (1С extension).
   * `'*'` is all properties (incl. tabular — large for documents). No fields
   * (`select(...[])`) sends no `$select` — all properties, as 1С reads an
   * empty `$select=` too.
   */
  select<K extends keyof T & string>(...fields: (K | '*' | '**')[]): this {
    this.state.select = fields as string[]
    return this
  }

  /**
   * Sugar for `.select('**')` — exclude inline tabular parts. Critical for
   * documents (without it, single doc may be 64+ KB; with it, ~5 KB).
   */
  headersOnly(): this {
    this.state.select = ['**']
    return this
  }

  /**
   * `$expand` navigation properties (comma-separated server-side). Stacks
   * across calls; while the list is empty no `$expand` is sent.
   */
  expand<K extends keyof T & string>(...props: K[]): this {
    this.state.expand = (this.state.expand ?? []).concat(props as string[])
    return this
  }

  /**
   * `$orderby` with optional direction. Stacks across calls.
   */
  orderBy<K extends keyof T & string>(field: K, dir: 'asc' | 'desc' = 'asc'): this {
    this.state.orderBy = (this.state.orderBy ?? []).concat({ field, dir })
    return this
  }

  /** `$top=N`. Throws `InvalidArgumentError` if `n` is not a non-negative integer. */
  top(n: number): this {
    assertNonNegativeInt(n, '.top()')
    this.state.top = n
    return this
  }

  /** `$skip=N`. Throws `InvalidArgumentError` if `n` is not a non-negative integer. */
  skip(n: number): this {
    assertNonNegativeInt(n, '.skip()')
    this.state.skip = n
    return this
  }

  /**
   * Add `$inlinecount=allpages` so response includes `odata.count` (string in
   * 1С, library parses to `number`).
   *
   * Caveat: by the 1С 8.3.27 documentation, `$inlinecount` makes 1С ignore
   * `$skip` / `$top`, returning the collection from its start. On the bases
   * checked so far 1С honours the paging; where it must not depend on the
   * platform, page without `withCount()` and take the total from `.count()`
   * (`/$count` with the same `$filter`, `$select` and `$expand`) instead.
   */
  withCount(): this {
    this.state.inlineCount = true
    return this
  }
}
