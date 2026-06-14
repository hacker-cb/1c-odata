// packages/client/src/register.ts
import type { RequestOptions } from './client/options.js'
import type { ODataV3Client } from './client/v3-client.js'
import { V3QueryBuilder } from './client/v3-query.js'
import { InvalidArgumentError } from './errors.js'
import { buildFunctionUrl } from './functions.js'
import { parseOptsFor, parseV3Collection } from './parser.js'
import { assertNonNegativeInt } from './query/validate.js'

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
 * and without a bound the whole collection is fetched and parsed.
 */
export interface ReadFiOptions extends RequestOptions {
  /**
   * `$top` — cap the number of rows in the response. Must be a non-negative
   * integer. Distinct from any FI-specific `Top` argument (e.g.
   * {@link RecordsWithExtDimensionsArgs.Top}), which is a virtual-table parameter.
   */
  top?: number
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
 * (`$top` + per-call `signal` / `timeout` / `retry`) — useful for the large
 * collections big registers return.
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
  async balance<R = Record<string, unknown>>(args: BalanceArgs = {}, opts: ReadFiOptions = {}): Promise<R[]> {
    return this.callReadFi<R>('Balance', args as Record<string, unknown>, opts)
  }

  /** Virtual-table FI: turnovers over a `Period` range. Accumulation / Accounting register. */
  async turnovers<R = Record<string, unknown>>(args: TurnoversArgs = {}, opts: ReadFiOptions = {}): Promise<R[]> {
    return this.callReadFi<R>('Turnovers', expandRangeArgs(args as Record<string, unknown>), opts)
  }

  /** Virtual-table FI: balance + turnovers over a `Period` range. Accumulation / Accounting register. */
  async balanceAndTurnovers<R = Record<string, unknown>>(
    args: TurnoversArgs = {},
    opts: ReadFiOptions = {},
  ): Promise<R[]> {
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
  async sliceFirst<R = Record<string, unknown>>(args: SliceArgs = {}, opts: ReadFiOptions = {}): Promise<R[]> {
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
  async sliceLast<R = Record<string, unknown>>(args: SliceArgs = {}, opts: ReadFiOptions = {}): Promise<R[]> {
    return this.callReadFi<R>('SliceLast', args as Record<string, unknown>, opts)
  }

  /** Virtual-table FI: Dr/Cr turnovers over a `Period` range. AccountingRegister. */
  async drCrTurnovers<R = Record<string, unknown>>(
    args: DrCrTurnoversArgs = {},
    opts: ReadFiOptions = {},
  ): Promise<R[]> {
    return this.callReadFi<R>('DrCrTurnovers', expandRangeArgs(args as Record<string, unknown>), opts)
  }

  /** Virtual-table FI: extra-dimension types for the register. Takes no FI arguments. AccountingRegister. */
  async extDimensions<R = Record<string, unknown>>(opts: ReadFiOptions = {}): Promise<R[]> {
    return this.callReadFi<R>('ExtDimensions', {}, opts)
  }

  /** Virtual-table FI: records with extra dimensions over a `Period` range. AccountingRegister. */
  async recordsWithExtDimensions<R = Record<string, unknown>>(
    args: RecordsWithExtDimensionsArgs = {},
    opts: ReadFiOptions = {},
  ): Promise<R[]> {
    return this.callReadFi<R>('RecordsWithExtDimensions', expandRangeArgs(args as Record<string, unknown>), opts)
  }

  /**
   * Shared dispatch for read-style virtual-table FIs. Builds the URL via
   * `buildFunctionUrl` (no `ref` — set-bound), appends `$top` when requested,
   * GETs through the transport (threading the per-call `RequestOptions`), and
   * parses through `parseV3Collection` so `Edm.DateTime` values become `Date`
   * instances and the `0001-01-01T00:00:00` empty-date sentinel becomes `null`
   * (consistent with `client.functions.X.Y` dispatch).
   */
  private async callReadFi<R>(funcName: string, args: Record<string, unknown>, opts: ReadFiOptions): Promise<R[]> {
    const { top, ...reqOpts } = opts
    let url = buildFunctionUrl(this.client.baseUrl, this.entitySet, funcName, {}, args, this.client.serverTimezone)
    if (top !== undefined) {
      assertNonNegativeInt(top, 'ReadFiOptions.top')
      url += (url.includes('?') ? '&' : '?') + `$top=${top}`
    }
    const raw = await this.client.transportGet(url, reqOpts)
    // withTypeHint=false: virtual-table FI results have a different shape than the entity type itself.
    const parsed = parseV3Collection<R>(raw.body, parseOptsFor(this.client, this.entitySet, false))
    return parsed.value
  }
}
