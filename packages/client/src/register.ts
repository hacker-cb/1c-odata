// packages/client/src/register.ts
import type { RequestOptions } from './client/options.js'
import type { ODataV3Client } from './client/v3-client.js'
import { V3QueryBuilder } from './client/v3-query.js'
import { InvalidArgumentError, ParseError } from './errors.js'
import { buildFunctionUrl } from './functions.js'
import { parseOptsFor, parseV3Collection, parseV3Count } from './parser.js'
import { assertNonNegativeInt } from './query/builder.js'
import { formatOrderBy, qp } from './url-builder.js'

/**
 * Args for `balance()` — single point in time. Both AccumulationRegister and
 * AccountingRegister expose `Balance(Period)`; the `AccountCondition` /
 * `ExtraDimensions` filters are AccountingRegister-only — 1С rejects them
 * (HTTP 501) when passed on an AccumulationRegister, so omit them there.
 */
export interface BalanceArgs {
  Period?: Date
  Condition?: string
  Dimensions?: string
  /** AccountingRegister only — condition on the account (`AccountCondition`). */
  AccountCondition?: string
  /** AccountingRegister only — ext-dimension condition (`ExtraDimensions`). */
  ExtraDimensions?: string
}

/**
 * Args for `turnovers()` / `balanceAndTurnovers()`. Turnovers are always
 * computed over an interval, so `Period` is a `{ from?, to? }` range that maps
 * to the `StartPeriod` / `EndPeriod` virtual-table parameters. Both bounds are
 * optional (both are nullable in the 1С EDMX schema): pass only `from` for an
 * open-ended-forward range, only `to` for everything up to a date, or omit
 * `Period` entirely for all turnovers.
 *
 * Unlike `balance()` there is no single-point form — 1С exposes no `Period`
 * (point) parameter on the `Turnovers` / `BalanceAndTurnovers` virtual tables
 * (verified live against УТ 11.1 / 11.5 and БП 3.0), so a bare `Date` is
 * rejected: the type forbids it, and an untyped (JS) caller gets an
 * `InvalidArgumentError` rather than a silent all-periods query.
 *
 * `AccountCondition` / `ExtraDimensions` are AccountingRegister-only — 1С
 * rejects them (HTTP 501) when passed on an AccumulationRegister, so omit them there.
 */
export interface TurnoversArgs {
  Period?: { from?: Date; to?: Date }
  Condition?: string
  Dimensions?: string
  /** AccountingRegister only — condition on the account (`AccountCondition`). */
  AccountCondition?: string
  /** AccountingRegister only — ext-dimension condition (`ExtraDimensions`). */
  ExtraDimensions?: string
}

/**
 * Args for InformationRegister `sliceFirst()` / `sliceLast()` — single point
 * in time.
 */
export interface SliceArgs {
  Period?: Date
  Condition?: string
}

/**
 * Args for AccountingRegister `drCrTurnovers()` — debit/credit turnovers over a
 * `Period` range (mapped to `StartPeriod` / `EndPeriod`). Accounts are filtered
 * through the string condition parameters, e.g.
 * `AccountCondition: "Account_Key eq guid'…'"` — 1С exposes no `@odata.bind`
 * account parameters on this virtual table (confirmed against БП 3.0).
 */
export interface DrCrTurnoversArgs {
  Period?: { from?: Date; to?: Date }
  Condition?: string
  /** Condition on the main account (`AccountCondition`). */
  AccountCondition?: string
  /** Condition on the corresponding / balanced account (`BalancedAccountCondition`). */
  BalancedAccountCondition?: string
  Dimensions?: string
  /** Ext-dimension condition for the main account (`ExtraDimensions`). */
  ExtraDimensions?: string
  /** Ext-dimension condition for the corresponding account (`BalancedExtraDimensions`). */
  BalancedExtraDimensions?: string
}

/**
 * Args for AccountingRegister `recordsWithExtDimensions()` — records together
 * with their extra dimensions over a `Period` range (mapped to `StartPeriod` /
 * `EndPeriod`).
 */
export interface RecordsWithExtDimensionsArgs {
  Period?: { from?: Date; to?: Date }
  Condition?: string
  /** 1С ordering expression (`Order` parameter). */
  Order?: string
  /**
   * The virtual table's own `Top` parameter — caps the records the FI computes
   * server-side. Distinct from {@link ReadFiOptions.top} (`$top`), which caps the
   * rows in the OData response; both may be set independently.
   */
  Top?: number
}

/**
 * System query options applied to a virtual-table FI call, plus the per-call
 * {@link RequestOptions} (`signal` / `timeout` / `retry`) honoured by every read
 * path. `$top` bounds the response — register FIs can return very large
 * collections (e.g. `Balance` / `ExtDimensions` over a big AccountingRegister),
 * and without a bound the whole collection is fetched and parsed. `$skip` with
 * `$top` reads one page of it, and {@link ReadFiCountOptions} adds the total
 * row count — so a large table is paged by the server instead of read whole.
 */
export interface ReadFiOptions extends RequestOptions {
  /**
   * `$top` — cap the number of rows in the response. Must be a non-negative
   * integer. Distinct from any FI-specific `Top` argument (e.g.
   * {@link RecordsWithExtDimensionsArgs.Top}), which is a virtual-table parameter.
   */
  top?: number
  /**
   * `$skip` — skip this many rows of the result. Must be a non-negative
   * integer. 1С computes the whole virtual table for every call and skips on
   * the server, so a page deep into a big table costs more than the first —
   * but only the page travels. Without {@link ReadFiOptions.orderBy} the rows
   * come in 1С's own order, which live bases returned identically on every
   * call carrying `$top` (no 1С guarantee).
   */
  skip?: number
  /**
   * `$orderby` — sort the result rows on the server, applied in order, e.g.
   * `[{ field: 'СуммаTurnoverDr', dir: 'desc' }]` with `top: 10` for the ten
   * largest. `field` is one property name — no spaces or commas; `dir`
   * defaults to `asc`. Sorting costs 1С time on a big table. An empty list
   * sends no `$orderby`.
   */
  orderBy?: { field: string; dir?: 'asc' | 'desc' | undefined }[]
  /**
   * `$select` — the fields to return. On the aggregating tables (`Balance`,
   * `Turnovers`, `BalanceAndTurnovers`, `DrCrTurnovers`) this also sets the
   * **grouping**: 1С sums the resources over the selected dimensions, so
   * selecting fewer dimensions returns fewer, coarser rows (a server-side
   * roll-up). E.g. `['Account_Key', 'СуммаTurnoverDr', 'СуммаTurnoverCr']`
   * collapses `Turnovers` to one row per account. On the per-record and slice
   * tables (`RecordsWithExtDimensions`, `SliceFirst` / `SliceLast`,
   * `ExtDimensions`) it only picks the fields — nothing is summed. Blank
   * entries are ignored; an empty list sends no `$select`.
   */
  select?: string[]
  /**
   * `$filter` — a raw OData filter expression applied to the virtual table's
   * result rows, e.g. `"СуммаTurnoverDr gt 100000"`. Distinct from the FI's own
   * `Condition` (and `AccountCondition`, …) parameters, which restrict the
   * records the table is computed from. A blank string sends no `$filter`.
   */
  filter?: string
  /**
   * The total row count is asked for through {@link ReadFiCountOptions}
   * (`count: true`), which changes what the method resolves to; here it can
   * only be left out or `false`.
   */
  count?: false
}

/**
 * {@link ReadFiOptions} plus `count: true` — also return the total row count of
 * the result (after `$filter`, before `$skip` / `$top`). A virtual-table method
 * called with it resolves to a {@link ReadFiPage} `{ value, count }` instead of
 * the bare row array.
 *
 * The count is a second request, `…/Func()/$count` with the same table
 * parameters, `$filter` and `$select` (the grouping), sent alongside the page — not `$inlinecount`, which
 * the 1С documentation says makes `$skip` / `$top` ignored. On a big table 1С
 * spends about as long counting as computing the page, in parallel. The two
 * requests see the data a moment apart, so on data changing meanwhile the
 * count and the page can briefly disagree. Some 1С publications count a
 * `$select` as grouped while returning its rows ungrouped, so the count can
 * fall short of the rows the pages hold. If either request fails, the call
 * fails.
 */
export interface ReadFiCountOptions extends Omit<ReadFiOptions, 'count'> {
  count: true
}

/**
 * One page of a virtual-table call made with `count: true`: the rows and the
 * total row count of the result (`/$count`).
 */
export interface ReadFiPage<R> {
  value: R[]
  count: number
}

/**
 * The system query options of a virtual-table call, encoded by the collection
 * URL builder's own `qp` — those of the page, and those of its `/$count`
 * (`$filter` and `$select`). `$top` and `$skip` keep the bare `$top=N` form. An
 * untyped (JS) caller passing a non-string `filter`, a `select` that is not an
 * array of strings (a sparse array's holes included), an `orderBy` that is not
 * an array of `{ field, dir? }` or a non-boolean `count` fails with
 * `InvalidArgumentError` before any request.
 */
function readFiQueryParams(opts: ReadFiOptions | ReadFiCountOptions): { page: string[]; count: string[] } {
  const params = filterParams(opts.filter)
  if (opts.select !== undefined) {
    if (!Array.isArray(opts.select) || !Array.from(opts.select).every((f) => typeof f === 'string')) {
      throw new InvalidArgumentError('ReadFiOptions.select must be an array of field-name strings', {
        argument: 'ReadFiOptions.select',
        received: opts.select,
      })
    }
    const fields = opts.select.map((f) => f.trim()).filter((f) => f !== '')
    if (fields.length > 0) params.push(qp('$select', fields.join(',')))
  }
  // The count takes what shapes the rows — `$filter`, and `$select`, which on
  // the aggregating tables is the grouping — and nothing that pages them.
  const count = [...params]
  if (opts.orderBy !== undefined) {
    const orderBy = orderByParam(opts.orderBy)
    if (orderBy !== '') params.push(qp('$orderby', orderBy))
  }
  if (opts.top !== undefined) {
    assertNonNegativeInt(opts.top, 'ReadFiOptions.top')
    params.push(`$top=${opts.top}`)
  }
  if (opts.skip !== undefined) {
    assertNonNegativeInt(opts.skip, 'ReadFiOptions.skip')
    params.push(`$skip=${opts.skip}`)
  }
  if (opts.count !== undefined && typeof (opts.count as unknown) !== 'boolean') {
    throw new InvalidArgumentError('ReadFiOptions.count must be a boolean', {
      argument: 'ReadFiOptions.count',
      received: opts.count,
    })
  }
  return { page: params, count }
}

/** The `$filter` of a virtual-table call — `[]` when absent or blank; a non-string fails with `InvalidArgumentError`. */
function filterParams(filter: unknown): string[] {
  if (filter === undefined) return []
  if (typeof filter !== 'string') {
    throw new InvalidArgumentError('ReadFiOptions.filter must be a string (a raw OData $filter expression)', {
      argument: 'ReadFiOptions.filter',
      received: filter,
    })
  }
  const trimmed = filter.trim()
  return trimmed !== '' ? [qp('$filter', trimmed)] : []
}

/** Append encoded system options to a function-import URL that may already carry its parameters. */
function withParams(url: string, params: string[]): string {
  return params.length > 0 ? `${url}${url.includes('?') ? '&' : '?'}${params.join('&')}` : url
}

/**
 * The `/$count` URL of a virtual-table call: `…/Set/Func()/$count`, the FI's
 * own parameters kept in the query string. The set and function names reach
 * the path encoded and validated (`buildFunctionUrl`), so the first `?` ends it.
 */
function countUrl(fiUrl: string): string {
  const q = fiUrl.indexOf('?')
  return q < 0 ? `${fiUrl}/$count` : `${fiUrl.slice(0, q)}/$count${fiUrl.slice(q)}`
}

/** A single OData property name or `Nav/Field` path — no whitespace, no commas, no empty segment. */
const ORDER_BY_FIELD = /^[^\s,/]+(?:\/[^\s,/]+)*$/

/**
 * The `$orderby` value of `ReadFiOptions.orderBy` — `field dir` pairs joined by
 * commas (`formatOrderBy`, shared with collection queries); `''` for an empty
 * list. A field carrying its own direction (`'Сумма desc'`) or a second key
 * (`'A,B'`) is rejected rather than sent as a malformed `$orderby`.
 */
function orderByParam(orderBy: unknown): string {
  const bad = (): never => {
    throw new InvalidArgumentError(
      "ReadFiOptions.orderBy must be an array of { field, dir?: 'asc' | 'desc' } where field is one property name (no spaces or commas)",
      { argument: 'ReadFiOptions.orderBy', received: orderBy },
    )
  }
  if (!Array.isArray(orderBy)) return bad()
  const keys = Array.from(orderBy as unknown[]).map((o) => {
    if (typeof o !== 'object' || o === null) return bad()
    const { field, dir } = o as { field?: unknown; dir?: unknown }
    if (typeof field !== 'string' || !ORDER_BY_FIELD.test(field.trim())) return bad()
    if (dir !== undefined && dir !== 'asc' && dir !== 'desc') return bad()
    return { field: field.trim(), dir: dir as 'asc' | 'desc' | undefined }
  })
  return formatOrderBy(keys)
}

/**
 * Map a `{ from?, to? }` range to the `StartPeriod` / `EndPeriod` virtual-table
 * parameters — only the bounds that are defined are emitted (both are optional
 * in the schema).
 *
 * Guards against a bare `Date`: turnovers-style tables have no single-point form
 * in 1С, so the type forbids it and an untyped (JS) caller passing a `Date`
 * fails loudly with `InvalidArgumentError` instead of having it match neither
 * `from` nor `to` — which would emit no period and silently widen the call to
 * an unintended all-periods query.
 */
function periodRange(period: { from?: Date; to?: Date } | undefined): Record<string, unknown> {
  if (period instanceof Date) {
    throw new InvalidArgumentError(
      'Period must be a { from?, to? } range, not a point Date — these register turnover/record virtual tables have no single-point form in 1С; use { from } or { from, to }',
      { argument: 'Period', received: period },
    )
  }
  const out: Record<string, unknown> = {}
  if (period?.from !== undefined) out.StartPeriod = period.from
  if (period?.to !== undefined) out.EndPeriod = period.to
  return out
}

/**
 * Expand a range-based FI args object: `Period` → `StartPeriod` / `EndPeriod`,
 * every other defined field forwarded verbatim as an FI parameter. Forwarding by
 * presence (rather than a hand-maintained whitelist) means a new arg field is
 * never silently dropped from the request — the args interface is the single
 * source of which parameters exist. Shared by `turnovers()` /
 * `balanceAndTurnovers()` / `drCrTurnovers()` / `recordsWithExtDimensions()`.
 */
function expandRangeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out = periodRange(args.Period as { from?: Date; to?: Date } | undefined)
  for (const [k, v] of Object.entries(args)) {
    if (k !== 'Period' && v !== undefined) out[k] = v
  }
  return out
}

/**
 * Facade over the V3 client for register-style entity sets. Provides:
 *   - `recordsets()` — query the parent register EntitySet (RecordSet rows)
 *   - `records()` — query `<set>_RecordType` (flat per-record movements)
 *   - AccumulationRegister: `balance()` / `turnovers()` / `balanceAndTurnovers()`
 *   - InformationRegister: `sliceFirst()` / `sliceLast()`
 *   - AccountingRegister: `drCrTurnovers()` / `extDimensions()` / `recordsWithExtDimensions()`
 *     (also `balance()` / `turnovers()` / `balanceAndTurnovers()`)
 *
 * Every virtual-table method takes an optional trailing {@link ReadFiOptions}
 * (`$top` / `$skip` / `$orderby` / `$select` / `$filter` + per-call `signal` /
 * `timeout` / `retry`) — `select` doubles as the server-side grouping, `top`
 * bounds the large collections big registers return, and `top` + `skip` page
 * through them. With `count: true` a method resolves to a {@link ReadFiPage}
 * `{ value, count }` instead of the bare rows.
 *
 * See spec §4.7.
 */
export class RegisterHelper<T> {
  constructor(
    private readonly client: ODataV3Client<unknown>,
    private readonly entitySet: string,
  ) {}

  /** Query the parent register EntitySet. Returns `V3QueryBuilder<T>` for chaining. */
  recordsets(): V3QueryBuilder<T> {
    return new V3QueryBuilder<T>(this.entitySet, this.client)
  }

  /** Query `<set>_RecordType`. Used for flat per-record server-side filtering. */
  records<R = Record<string, unknown>>(): V3QueryBuilder<R> {
    return new V3QueryBuilder<R>(`${this.entitySet}_RecordType`, this.client)
  }

  /** Virtual-table FI: balance at `Period`. Accumulation / Accounting register. */
  async balance<R = Record<string, unknown>>(
    args: BalanceArgs | undefined,
    opts: ReadFiCountOptions,
  ): Promise<ReadFiPage<R>>
  async balance<R = Record<string, unknown>>(args?: BalanceArgs, opts?: ReadFiOptions): Promise<R[]>
  async balance<R = Record<string, unknown>>(
    args: BalanceArgs = {},
    opts: ReadFiOptions | ReadFiCountOptions = {},
  ): Promise<R[] | ReadFiPage<R>> {
    return this.callReadFi<R>('Balance', args as Record<string, unknown>, opts)
  }

  /** Virtual-table FI: turnovers over a `Period` range. Accumulation / Accounting register. */
  async turnovers<R = Record<string, unknown>>(
    args: TurnoversArgs | undefined,
    opts: ReadFiCountOptions,
  ): Promise<ReadFiPage<R>>
  async turnovers<R = Record<string, unknown>>(args?: TurnoversArgs, opts?: ReadFiOptions): Promise<R[]>
  async turnovers<R = Record<string, unknown>>(
    args: TurnoversArgs = {},
    opts: ReadFiOptions | ReadFiCountOptions = {},
  ): Promise<R[] | ReadFiPage<R>> {
    return this.callReadFi<R>('Turnovers', expandRangeArgs(args as Record<string, unknown>), opts)
  }

  /** Virtual-table FI: balance + turnovers over a `Period` range. Accumulation / Accounting register. */
  async balanceAndTurnovers<R = Record<string, unknown>>(
    args: TurnoversArgs | undefined,
    opts: ReadFiCountOptions,
  ): Promise<ReadFiPage<R>>
  async balanceAndTurnovers<R = Record<string, unknown>>(args?: TurnoversArgs, opts?: ReadFiOptions): Promise<R[]>
  async balanceAndTurnovers<R = Record<string, unknown>>(
    args: TurnoversArgs = {},
    opts: ReadFiOptions | ReadFiCountOptions = {},
  ): Promise<R[] | ReadFiPage<R>> {
    return this.callReadFi<R>('BalanceAndTurnovers', expandRangeArgs(args as Record<string, unknown>), opts)
  }

  /**
   * Virtual-table FI: slice at the first row at/before `Period`. InformationRegister.
   *
   * Invoked on the registered entity set. Most InformationRegister slices bind
   * to the bare set — `register('InformationRegister_X')`; for the minority
   * bound to the record type, register the `_RecordType` set instead —
   * `register('InformationRegister_X_RecordType')`.
   */
  async sliceFirst<R = Record<string, unknown>>(
    args: SliceArgs | undefined,
    opts: ReadFiCountOptions,
  ): Promise<ReadFiPage<R>>
  async sliceFirst<R = Record<string, unknown>>(args?: SliceArgs, opts?: ReadFiOptions): Promise<R[]>
  async sliceFirst<R = Record<string, unknown>>(
    args: SliceArgs = {},
    opts: ReadFiOptions | ReadFiCountOptions = {},
  ): Promise<R[] | ReadFiPage<R>> {
    return this.callReadFi<R>('SliceFirst', args as Record<string, unknown>, opts)
  }

  /**
   * Virtual-table FI: slice at the last row at/before `Period`. InformationRegister.
   *
   * Invoked on the registered entity set. Most InformationRegister slices bind
   * to the bare set — `register('InformationRegister_X')`; for the minority
   * bound to the record type, register the `_RecordType` set instead —
   * `register('InformationRegister_X_RecordType')`.
   */
  async sliceLast<R = Record<string, unknown>>(
    args: SliceArgs | undefined,
    opts: ReadFiCountOptions,
  ): Promise<ReadFiPage<R>>
  async sliceLast<R = Record<string, unknown>>(args?: SliceArgs, opts?: ReadFiOptions): Promise<R[]>
  async sliceLast<R = Record<string, unknown>>(
    args: SliceArgs = {},
    opts: ReadFiOptions | ReadFiCountOptions = {},
  ): Promise<R[] | ReadFiPage<R>> {
    return this.callReadFi<R>('SliceLast', args as Record<string, unknown>, opts)
  }

  /** Virtual-table FI: Dr/Cr turnovers over a `Period` range. AccountingRegister. */
  async drCrTurnovers<R = Record<string, unknown>>(
    args: DrCrTurnoversArgs | undefined,
    opts: ReadFiCountOptions,
  ): Promise<ReadFiPage<R>>
  async drCrTurnovers<R = Record<string, unknown>>(args?: DrCrTurnoversArgs, opts?: ReadFiOptions): Promise<R[]>
  async drCrTurnovers<R = Record<string, unknown>>(
    args: DrCrTurnoversArgs = {},
    opts: ReadFiOptions | ReadFiCountOptions = {},
  ): Promise<R[] | ReadFiPage<R>> {
    return this.callReadFi<R>('DrCrTurnovers', expandRangeArgs(args as Record<string, unknown>), opts)
  }

  /** Virtual-table FI: extra-dimension types for the register. Takes no FI arguments. AccountingRegister. */
  async extDimensions<R = Record<string, unknown>>(opts: ReadFiCountOptions): Promise<ReadFiPage<R>>
  async extDimensions<R = Record<string, unknown>>(opts?: ReadFiOptions): Promise<R[]>
  async extDimensions<R = Record<string, unknown>>(
    opts: ReadFiOptions | ReadFiCountOptions = {},
  ): Promise<R[] | ReadFiPage<R>> {
    return this.callReadFi<R>('ExtDimensions', {}, opts)
  }

  /** Virtual-table FI: records with extra dimensions over a `Period` range. AccountingRegister. */
  async recordsWithExtDimensions<R = Record<string, unknown>>(
    args: RecordsWithExtDimensionsArgs | undefined,
    opts: ReadFiCountOptions,
  ): Promise<ReadFiPage<R>>
  async recordsWithExtDimensions<R = Record<string, unknown>>(
    args?: RecordsWithExtDimensionsArgs,
    opts?: ReadFiOptions,
  ): Promise<R[]>
  async recordsWithExtDimensions<R = Record<string, unknown>>(
    args: RecordsWithExtDimensionsArgs = {},
    opts: ReadFiOptions | ReadFiCountOptions = {},
  ): Promise<R[] | ReadFiPage<R>> {
    return this.callReadFi<R>('RecordsWithExtDimensions', expandRangeArgs(args as Record<string, unknown>), opts)
  }

  /**
   * Shared dispatch for read-style virtual-table FIs. Builds the URL via
   * `buildFunctionUrl` (no `ref` — set-bound), appends `$filter` / `$select` /
   * `$orderby` / `$top` / `$skip` when requested, GETs through the transport
   * (threading the per-call `RequestOptions`), and parses through
   * `parseV3Collection` so `Edm.DateTime` values become `Date` instances and the
   * `0001-01-01T00:00:00` empty-date sentinel becomes `null` (consistent with
   * `client.functions.X.Y` dispatch). With `count: true` it also GETs the
   * table's `/$count` (same parameters, `$filter` and `$select`) in parallel and
   * resolves to both; a failure of either fails the call and aborts the other.
   */
  private async callReadFi<R>(
    funcName: string,
    args: Record<string, unknown>,
    opts: ReadFiOptions | ReadFiCountOptions,
  ): Promise<R[] | ReadFiPage<R>> {
    const { top, skip, orderBy, count, select, filter, ...reqOpts } = opts
    const fiUrl = buildFunctionUrl(this.client.baseUrl, this.entitySet, funcName, {}, args, this.client.serverTimezone)
    const params = readFiQueryParams(opts)
    // withTypeHint=false: virtual-table FI results have a different shape than the entity type itself.
    const rows = async (call: RequestOptions): Promise<R[]> =>
      parseV3Collection<R>(
        (await this.client.transportGet(withParams(fiUrl, params.page), call)).body,
        parseOptsFor(this.client, this.entitySet, false),
      ).value
    if (count !== true) return rows(reqOpts)
    const total = async (call: RequestOptions): Promise<number> => {
      const n = parseV3Count((await this.client.transportGet(withParams(countUrl(fiUrl), params.count), call)).body)
      if (!Number.isSafeInteger(n) || n < 0)
        throw new ParseError(`Expected a non-negative row count from /$count, got ${n}`)
      return n
    }
    // One failing aborts the other rather than leave it loading a page no one reads.
    const sibling = new AbortController()
    const signal = reqOpts.signal !== undefined ? AbortSignal.any([reqOpts.signal, sibling.signal]) : sibling.signal
    const call = { ...reqOpts, signal }
    try {
      const [value, n] = await Promise.all([rows(call), total(call)])
      return { value, count: n }
    } catch (err) {
      sibling.abort()
      throw err
    }
  }
}
