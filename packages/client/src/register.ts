// packages/client/src/register.ts
import type { ODataV3Client } from './client/v3-client.js'
import { V3QueryBuilder } from './client/v3-query.js'
import { buildFunctionUrl } from './functions.js'
import { parseOptsFor, parseV3Collection } from './parser.js'

/**
 * Args for `balance()` — single point in time.
 */
export interface BalanceArgs {
  Period?: Date
  Condition?: string
  Dimensions?: string
}

/**
 * Args for `turnovers()` / `balanceAndTurnovers()`. `Period` may be either a
 * single `Date` (point) or `{from, to}` (range). The latter flattens to two
 * args (`StartDate`/`EndDate`) per spec §4.7.
 */
export interface TurnoversArgs {
  Period?: Date | { from: Date; to: Date }
  Condition?: string
  Dimensions?: string
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
 * Args for AccountingRegister `drCrTurnovers()` — debit/credit turnovers in a
 * date range, optionally filtered by Dr/Cr account refs (`@odata.bind`).
 */
export interface DrCrTurnoversArgs {
  StartDate?: Date
  EndDate?: Date
  AccountDr?: { '@odata.bind': string }
  AccountCr?: { '@odata.bind': string }
}

/**
 * Args for AccountingRegister `extDimensions()` — extra dimensions for a
 * given account.
 */
export interface ExtDimensionsArgs {
  Account_Key?: string
}

/**
 * Args for AccountingRegister `recordsWithExtDimensions()` — records together
 * with extra dimensions in a date range.
 */
export interface RecordsWithExtDimensionsArgs {
  StartDate?: Date
  EndDate?: Date
}

/**
 * Expand a `TurnoversArgs.Period` range to `StartDate`/`EndDate`. A `Date`
 * value passes through under the original key. Other args (`Condition`,
 * `Dimensions`) are forwarded only when defined.
 */
function expandPeriod(args: TurnoversArgs): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (args.Period instanceof Date) {
    out.Period = args.Period
  } else if (args.Period !== undefined) {
    out.StartDate = args.Period.from
    out.EndDate = args.Period.to
  }
  if (args.Condition !== undefined) out.Condition = args.Condition
  if (args.Dimensions !== undefined) out.Dimensions = args.Dimensions
  return out
}

/**
 * Facade over the V3 client for register-style entity sets. Provides:
 *   - `recordsets()` — query against the parent register EntitySet (RecordSet rows)
 *   - `records()` — query against `<set>_RecordType` (flat per-record movements)
 *   - `balance()` / `turnovers()` / `balanceAndTurnovers()` — virtual-table FI wrappers
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

  /** Virtual-table FI: balance at `Period`. AccumulationRegister. */
  async balance<R = Record<string, unknown>>(args: BalanceArgs = {}): Promise<R[]> {
    return this.callReadFi<R>('Balance', args as Record<string, unknown>)
  }

  /** Virtual-table FI: turnovers in `Period` (point or range). AccumulationRegister. */
  async turnovers<R = Record<string, unknown>>(args: TurnoversArgs = {}): Promise<R[]> {
    return this.callReadFi<R>('Turnovers', expandPeriod(args))
  }

  /** Virtual-table FI: balance + turnovers in `Period`. AccumulationRegister. */
  async balanceAndTurnovers<R = Record<string, unknown>>(args: TurnoversArgs = {}): Promise<R[]> {
    return this.callReadFi<R>('BalanceAndTurnovers', expandPeriod(args))
  }

  /** Virtual-table FI: slice at the first row before/at `Period`. InformationRegister. */
  async sliceFirst<R = Record<string, unknown>>(args: SliceArgs = {}): Promise<R[]> {
    return this.callReadFi<R>('SliceFirst', args as Record<string, unknown>)
  }

  /** Virtual-table FI: slice at the last row before/at `Period`. InformationRegister. */
  async sliceLast<R = Record<string, unknown>>(args: SliceArgs = {}): Promise<R[]> {
    return this.callReadFi<R>('SliceLast', args as Record<string, unknown>)
  }

  /** Virtual-table FI: Dr/Cr turnovers in `[StartDate, EndDate]`. AccountingRegister. */
  async drCrTurnovers<R = Record<string, unknown>>(args: DrCrTurnoversArgs = {}): Promise<R[]> {
    return this.callReadFi<R>('DrCrTurnovers', args as Record<string, unknown>)
  }

  /** Virtual-table FI: extra dimensions for a given account. AccountingRegister. */
  async extDimensions<R = Record<string, unknown>>(args: ExtDimensionsArgs = {}): Promise<R[]> {
    return this.callReadFi<R>('ExtDimensions', args as Record<string, unknown>)
  }

  /** Virtual-table FI: records with extra dimensions in `[StartDate, EndDate]`. AccountingRegister. */
  async recordsWithExtDimensions<R = Record<string, unknown>>(args: RecordsWithExtDimensionsArgs = {}): Promise<R[]> {
    return this.callReadFi<R>('RecordsWithExtDimensions', args as Record<string, unknown>)
  }

  /**
   * Shared dispatch for read-style virtual-table FIs. Builds the URL via
   * `buildFunctionUrl` (no `ref` — set-bound), GETs through the transport,
   * and parses through `parseV3Collection` so `Edm.DateTime` values become
   * `Date` instances and the `0001-01-01T00:00:00` empty-date sentinel
   * becomes `null` (consistent with `client.functions.X.Y` dispatch).
   */
  private async callReadFi<R>(funcName: string, args: Record<string, unknown>): Promise<R[]> {
    const url = buildFunctionUrl(this.client.baseUrl, this.entitySet, funcName, {}, args, this.client.serverTimezone)
    const raw = await this.client.transportGet(url, {})
    // withTypeHint=false: virtual-table FI results have a different shape than the entity type itself.
    const parsed = parseV3Collection<R>(raw.body, parseOptsFor(this.client, this.entitySet, false))
    return parsed.value
  }
}
