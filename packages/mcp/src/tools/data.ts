import type {
  BalanceArgs,
  DrCrTurnoversArgs,
  ReadFiOptions,
  RecordsWithExtDimensionsArgs,
  RegisterHelper,
  SliceArgs,
  TurnoversArgs,
  UntypedEntity,
  V3QueryBuilder,
} from '@1c-odata/client'
import { formatInZone, parseInZone } from '@1c-odata/client'
import { raw } from '@1c-odata/client/filter'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { ReadPool } from '../connection-pool.js'
import { clampTop, type Limits } from '../limits.js'
import { capLongStrings, type FitResult, fitRows, stripNoise, toJsonSafe } from '../rows.js'
import { toolResult } from './_result.js'

/** Register virtual tables, keyed by RegisterHelper method name. */
const REGISTER_TABLES = [
  'balance',
  'turnovers',
  'balanceAndTurnovers',
  'sliceFirst',
  'sliceLast',
  'drCrTurnovers',
  'extDimensions',
  'recordsWithExtDimensions',
] as const

interface RegisterQueryArgs {
  table: (typeof REGISTER_TABLES)[number]
  // `| undefined` mirrors the zod-inferred argument shape (optional + undefined)
  // under exactOptionalPropertyTypes.
  period?: string | undefined
  periodFrom?: string | undefined
  periodTo?: string | undefined
  condition?: string | undefined
  dimensions?: string | undefined
  accountCondition?: string | undefined
  balancedAccountCondition?: string | undefined
  extraDimensions?: string | undefined
  balancedExtraDimensions?: string | undefined
}

interface QueryOptions {
  filter?: string | undefined
  select?: string[] | undefined
  expand?: string[] | undefined
  orderBy?: { field: string; dir?: 'asc' | 'desc' | undefined }[] | undefined
  count?: boolean | undefined
}

/** Apply the non-paging query options ($filter/$select/$expand/$orderby/$inlinecount) to a builder. */
function applyQueryOptions(builder: V3QueryBuilder<UntypedEntity>, opts: QueryOptions): V3QueryBuilder<UntypedEntity> {
  let q = builder
  const filter = opts.filter
  if (filter !== undefined && filter.trim() !== '') q = q.filter(() => raw(filter))
  if (opts.select !== undefined && opts.select.length > 0) q = q.select(...opts.select)
  if (opts.expand !== undefined && opts.expand.length > 0) q = q.expand(...opts.expand)
  if (opts.orderBy !== undefined) for (const o of opts.orderBy) q = q.orderBy(o.field, o.dir ?? 'asc')
  if (opts.count === true) q = q.withCount()
  return q
}

/**
 * Shape rows for return: optionally strip annotation noise (`compact`), cap any
 * oversized string field so a single fat row (e.g. a base64 ValueStorage) can't
 * blow the budget, then truncate the array to the byte budget.
 */
function shapeRows<T>(rows: T[], compact: boolean | undefined, limits: Limits): FitResult<T> {
  const cleaned = compact === true ? rows.map((r) => stripNoise(r)) : rows
  const capped = cleaned.map((r) => capLongStrings(r, limits.maxBytes)) as T[]
  return fitRows(capped, limits.maxBytes)
}

/** A `… of N fetched rows; narrow with …` note for the summary, or '' when nothing was dropped. */
function truncationNote(truncated: boolean, shown: number, fetched: number, limits: Limits, narrow: string): string {
  if (!truncated) return ''
  return ` ⚠ Output truncated to ${shown} of ${fetched} fetched rows (~${limits.maxBytes}-byte budget); ${narrow}.`
}

/** Entity-set paths that are really register virtual tables / flat record sets — nudge toward register_query. */
const REGISTER_VT =
  /\/(Balance|Turnovers|BalanceAndTurnovers|SliceFirst|SliceLast|DrCrTurnovers|ExtDimensions|RecordsWithExtDimensions)\b/

/** A virtual table with its parameters in the path — `…/Turnovers(StartPeriod=…)` — one segment for all of them. */
const PARAMS_IN_PATH = /\/\w+\([^)]*=/

function registerHint(entitySet: string): string {
  if (REGISTER_VT.test(entitySet)) {
    const segment = PARAMS_IN_PATH.test(entitySet)
      ? ' Here its parameters share one URL path segment, which IIS caps at 260 characters by default (about two GUIDs in a condition); register_query sends them in the query string.'
      : ''
    return ` Tip: this is a register virtual table — register_query aggregates it server-side.${segment}`
  }
  if (entitySet.endsWith('_RecordType'))
    return ' Tip: for totals/balances prefer register_query (server-side aggregation by dimensions) over raw _RecordType rows.'
  return ''
}

/** Register the read-only data tools (queries, lookups, register virtual tables). */
export function registerDataTools(server: McpServer, pool: ReadPool, limits: Limits): void {
  server.registerTool(
    'query',
    {
      title: 'Query data',
      description:
        'Read-only OData query against an entity set ($filter, $select, $expand, $orderby, $top/$skip, optional count). Large results are truncated to a byte budget — use select to keep them small. With expand, also include the navigation property in select (e.g. "Партнер/Description") or the expanded data is dropped. To look up records by key use get_entity (once per id) — do NOT build long "Ref_Key eq … or …" filters; 1С rejects over-long URLs with HTTP 404 (keep any OR-batch ≤ ~10). For register balances/turnovers/totals use register_query, not raw "*_RecordType" rows. Do not pass a register virtual table with its parameters in the path as entitySet ("AccountingRegister_X/Turnovers(StartPeriod=…,AccountCondition=\'…\')"): they all share ONE URL path segment, which IIS caps at 260 characters by default — about two GUIDs in a condition — and rejects with HTTP 400 "Invalid URL"; register_query sends them in the query string, with no such limit.',
      inputSchema: {
        connection: z.string().describe('Connection name'),
        entitySet: z.string().describe('Entity set, e.g. Catalog_Валюты'),
        filter: z.string().optional().describe('Raw OData $filter, e.g. "DeletionMark eq false"'),
        select: z
          .array(z.string())
          .optional()
          .describe(
            'Properties to return ("*" = all, "**" = all minus tabular parts). With expand, include the nav prop or "Nav/Field" too.',
          ),
        expand: z.array(z.string()).optional().describe('Navigation properties to expand'),
        orderBy: z
          .array(z.object({ field: z.string(), dir: z.enum(['asc', 'desc']).optional() }))
          .optional()
          .describe('Sort specification (applied in order)'),
        top: z.number().int().optional().describe('Max rows to return this page (server-capped; omit for the default)'),
        skip: z.number().int().min(0).optional().describe('Offset for pagination (default 0)'),
        count: z.boolean().optional().describe('Include the total row count (OData $inlinecount)'),
        compact: z
          .boolean()
          .optional()
          .describe(
            'Drop 1С "*_Type" annotation companions and @odata noise to save space. Caveat: also removes composite-type discriminators like Value_Type/Ref_Type, so omit it when you need to know which entity a "*_Key" points to.',
          ),
      },
    },
    async ({ connection, entitySet, filter, select, expand, orderBy, top, skip, count, compact }) =>
      toolResult(async () => {
        const { client } = await pool.get(connection)
        const limit = clampTop(top, limits)
        const offset = skip ?? 0
        let q = applyQueryOptions(client.query<UntypedEntity>(entitySet), {
          filter,
          select,
          expand,
          orderBy,
          count,
        }).top(limit)
        if (offset > 0) q = q.skip(offset)

        const result = await q.get()
        const fetched = result.value.length
        const { rows, truncated } = shapeRows(result.value, compact, limits)
        const note = truncationNote(
          truncated,
          rows.length,
          fetched,
          limits,
          'narrow with select, set compact:true, or page with skip',
        )
        return {
          summary: `${rows.length} row(s)${result.count !== undefined ? ` of ${result.count} total` : ''} from ${entitySet}.${note}${registerHint(entitySet)}`,
          data: {
            connection,
            entitySet,
            ...(result.count !== undefined ? { count: result.count } : {}),
            pagination: {
              skip: offset,
              top: limit,
              fetched,
              returned: rows.length,
              truncated,
              // More rows exist if we dropped some for size, or — by count when
              // present, else by a full page — the server has a next page.
              hasMore: truncated || (result.count !== undefined ? offset + fetched < result.count : fetched === limit),
            },
            value: rows,
          },
        }
      }),
  )

  server.registerTool(
    'get_entity',
    {
      title: 'Get entity',
      description:
        'Fetch one entity by key (Ref_Key GUID) — the right way to look up a record by id. For several ids, call this once per id rather than one query with a long "Ref_Key eq … or …" filter (1С rejects over-long URLs with HTTP 404). For a projection or $expand of a single record, use query with filter "Ref_Key eq guid\'…\'".',
      inputSchema: {
        connection: z.string().describe('Connection name'),
        entitySet: z.string().describe('Entity set, e.g. Catalog_Валюты'),
        key: z.string().describe('Entity key — usually the Ref_Key GUID'),
        compact: z
          .boolean()
          .optional()
          .describe(
            'Drop 1С "*_Type" annotation companions and @odata noise to save space. Caveat: also removes composite-type discriminators like Value_Type/Ref_Type.',
          ),
      },
    },
    async ({ connection, entitySet, key, compact }) =>
      toolResult(async () => {
        const { client } = await pool.get(connection)
        const entity = await client.entity<UntypedEntity>(entitySet, key).get()
        const cleaned = compact === true ? stripNoise(entity) : entity
        // Cap oversized string fields (e.g. a base64 ValueStorage) first.
        const shaped = capLongStrings(cleaned, limits.maxBytes)
        // A wide entity (many fields / large tabular parts) can still exceed the
        // budget, and there are no rows to drop — refuse rather than overflow.
        const bytes = Buffer.byteLength(JSON.stringify(toJsonSafe(shaped)), 'utf8')
        if (bytes > limits.maxBytes) {
          return {
            summary: `${entitySet}(${key}) is ~${bytes} bytes — over the ~${limits.maxBytes}-byte budget. Use query with filter "Ref_Key eq guid'${key}'" and a narrow select (or select "**" to drop tabular parts).`,
            data: { connection, entitySet, key, truncated: true, bytes },
          }
        }
        return { summary: `Fetched ${entitySet}(${key}).`, data: { connection, entitySet, key, entity: shaped } }
      }),
  )

  server.registerTool(
    'count',
    {
      title: 'Count rows',
      description: 'Count rows in an entity set matching an optional raw OData $filter.',
      inputSchema: {
        connection: z.string().describe('Connection name'),
        entitySet: z.string().describe('Entity set, e.g. Document_РеализацияТоваровУслуг'),
        filter: z.string().optional().describe('Raw OData $filter expression'),
      },
    },
    async ({ connection, entitySet, filter }) =>
      toolResult(async () => {
        const { client } = await pool.get(connection)
        const q = applyQueryOptions(client.query<UntypedEntity>(entitySet), { filter })
        const total = await q.count()
        return { summary: `${total} row(s) in ${entitySet}.`, data: { connection, entitySet, count: total } }
      }),
  )

  server.registerTool(
    'register_query',
    {
      title: 'Query register virtual table',
      description:
        'Server-side analytics on a 1С register — stock balances, period turnovers/sales totals, slices. 1С aggregates by the register dimensions and returns compact pre-summed rows; prefer this over query on raw "*_RecordType" records for totals/by-dimension breakdowns. Control grouping with select: on balance/turnovers/balanceAndTurnovers/drCrTurnovers 1С sums the resources over the selected dimensions only, so fewer dimensions return fewer, coarser rows (e.g. on an AccountingRegister turnovers, select ["Account_Key","СуммаTurnoverDr","СуммаTurnoverCr"] gives one row per account); on slices and recordsWithExtDimensions select only picks fields. dimensions (the Dimensions parameter of the virtual table) limits which dimensions the table is built over — select can only group by those. condition/accountCondition restrict the records the table is computed from (extDimensions takes neither); filter restricts the resulting rows. Tables: balance/turnovers/balanceAndTurnovers (accumulation), sliceFirst/sliceLast (information), drCrTurnovers/extDimensions/recordsWithExtDimensions (accounting). Dates are ISO 8601 in the 1С server time unless they carry Z or an offset. Paginated via top/skip.',
      inputSchema: {
        connection: z.string().describe('Connection name'),
        register: z.string().describe('Register entity set, e.g. AccumulationRegister_ТоварыНаСкладах'),
        table: z.enum(REGISTER_TABLES).describe('Virtual table to query'),
        period: z
          .string()
          .optional()
          .describe(
            'ISO date or date-time — point in time for balance/slice (range tables: taken as range start). Without Z/offset it is the 1С server time (the connection serverTimezone); a bare date is server midnight.',
          ),
        periodFrom: z
          .string()
          .optional()
          .describe(
            'ISO date or date-time — range start (StartPeriod) for turnovers/accounting tables. Without Z/offset it is the 1С server time; a bare date is server midnight.',
          ),
        periodTo: z
          .string()
          .optional()
          .describe(
            'ISO date or date-time — range end (EndPeriod) for turnovers/accounting tables. Without Z/offset it is the 1С server time; a bare date is server MIDNIGHT, so to include a whole last day pass e.g. 2026-01-31T23:59:59.',
          ),
        condition: z.string().optional().describe('Raw OData condition expression on the register records'),
        dimensions: z.string().optional().describe('Comma-separated dimension names'),
        accountCondition: z
          .string()
          .optional()
          .describe('AccountingRegister: condition on the (main) account, e.g. "Account_Key eq guid\'…\'"'),
        balancedAccountCondition: z
          .string()
          .optional()
          .describe('drCrTurnovers: condition on the corresponding/balanced account'),
        extraDimensions: z.string().optional().describe('AccountingRegister: ext-dimension condition'),
        balancedExtraDimensions: z
          .string()
          .optional()
          .describe('drCrTurnovers: ext-dimension condition for the corresponding account'),
        select: z
          .array(z.string())
          .optional()
          .describe(
            'Fields to return ($select). On balance/turnovers/balanceAndTurnovers/drCrTurnovers also the GROUPING: resources are summed over the selected dimensions only, so fewer dimensions = fewer, pre-rolled-up rows. Include the resources you need (e.g. "КоличествоBalance", "СуммаTurnoverDr").',
          ),
        filter: z
          .string()
          .optional()
          .describe(
            'Raw OData $filter on the resulting rows, e.g. "СуммаTurnoverDr gt 100000". Use condition/accountCondition to restrict the records the table is computed from.',
          ),
        top: z.number().int().optional().describe('Max rows to return this page (server-capped; omit for the default)'),
        skip: z.number().int().min(0).optional().describe('Offset for pagination (default 0)'),
        compact: z
          .boolean()
          .optional()
          .describe(
            'Drop 1С "*_Type" annotation companions and @odata noise to save space. Caveat: also removes composite-type discriminators like Value_Type/Ref_Type, so omit it when you need to know which entity a "*_Key" points to.',
          ),
      },
    },
    async (args) =>
      toolResult(async () => {
        const { client } = await pool.get(args.connection)
        // Register FIs return the whole virtual table; bound the server-side fetch
        // ($top = cap + 1) so a huge register can't OOM us, then paginate
        // client-side. `total` is exact below the cap; above it we degrade to a
        // floor with `totalCapped` and a nudge to narrow.
        const cap = limits.maxRegisterRows
        const fetched = await runRegisterTable(
          client.register(args.register),
          cleanRegisterArgs(args),
          { top: cap + 1, ...readOptions(args) },
          client.serverTimezone,
        )
        const totalCapped = fetched.length > cap
        const allRows = totalCapped ? fetched.slice(0, cap) : fetched
        const total = allRows.length
        const offset = args.skip ?? 0
        const limit = clampTop(args.top, limits)
        const page = allRows.slice(offset, offset + limit)
        const { rows, truncated } = shapeRows(page, args.compact, limits)
        const note = truncationNote(
          truncated,
          rows.length,
          page.length,
          limits,
          'narrow with select/condition/filter, set compact:true, or page with skip',
        )
        const capNote = totalCapped
          ? ` ⚠ register result capped at ${cap} rows — narrow with condition/filter/period (or group coarser with select on an aggregating table) for the full set.`
          : ''
        return {
          summary: `${rows.length} row(s) of ${total}${totalCapped ? '+' : ''} total from ${args.register}.${args.table}.${note}${capNote}`,
          data: {
            connection: args.connection,
            register: args.register,
            table: args.table,
            total,
            ...(totalCapped ? { totalCapped: true } : {}),
            pagination: {
              skip: offset,
              top: limit,
              returned: rows.length,
              truncated,
              hasMore: truncated || totalCapped || offset + page.length < total,
            },
            rows,
          },
        }
      }),
  )
}

/**
 * Strict ISO-8601: a date `2024-01-01`, or a date-time
 * `2024-01-01T00:00(:00(.sss))` with an optional zone `Z` / `±hh:mm`. A space
 * may stand for the `T`.
 */
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/

/**
 * Parse a register period. A value WITH a zone (`Z` / `±hh:mm`) is that
 * instant. A value without one — a bare date or a naive date-time — is wall
 * time on the 1С server: read in the connection's `serverTimezone`, the same
 * conversion the client applies to naive date-times in 1С responses, so a bare
 * date is the server's midnight. (`new Date()` would read a naive date-time in
 * the MCP host's zone and a bare date as UTC midnight — both shift the period
 * off the server's day.) Impossible calendar values (`2026-02-30`, `25:00`) are
 * rejected rather than rolled over.
 */
function toDate(iso: string | undefined, serverTimezone: string): Date | undefined {
  if (iso === undefined) return undefined
  const trimmed = iso.trim()
  const m = ISO_DATE_RE.exec(trimmed)
  if (m === null || !isRealDateTime(m)) {
    throw new Error(
      `Invalid ISO date: "${iso}" (expected YYYY-MM-DD or YYYY-MM-DDTHH:mm[:ss], optionally with Z or an offset like +03:00; ` +
        `without one it is read as the 1С server's time, ${serverTimezone})`,
    )
  }
  const [, y, mo, d, hh = '00', mi = '00', ss = '00', frac = '', zone] = m
  const local = `${y}-${mo}-${d}T${hh}:${mi}:${ss}`
  const date = zone !== undefined ? new Date(`${local}${frac}${zone}`) : parseInZone(`${local}${frac}`, serverTimezone)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ISO date: "${iso}" (not a representable instant — check the offset and the year)`)
  }
  // A wall time the zone skips (the spring-forward gap) has no instant: parseInZone
  // would shift it silently, moving the period boundary.
  if (zone === undefined && formatInZone(date, serverTimezone).slice(0, 19) !== local) {
    throw new Error(`Invalid ISO date: "${iso}" (no such local time in ${serverTimezone} — a daylight-saving gap)`)
  }
  return date
}

/** Whether the matched fields name a real calendar day and clock time (no `Date` rollover). */
function isRealDateTime(m: RegExpExecArray): boolean {
  const [, y, mo, d, hh = '0', mi = '0', ss = '0'] = m
  const [year, month, day] = [Number(y), Number(mo), Number(d)]
  // setUTCFullYear, not Date.UTC: the latter maps years 0–99 to 1900–1999.
  const probe = new Date(0)
  probe.setUTCFullYear(year, month - 1, day)
  const dayOk = probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
  return dayOk && Number(hh) <= 23 && Number(mi) <= 59 && Number(ss) <= 59
}

/** Build a { from?, to? } range from periodFrom/periodTo; a lone `period` is the start. */
function rangeFromArgs(args: RegisterQueryArgs, tz: string): { from?: Date; to?: Date } | undefined {
  const from = toDate(args.periodFrom, tz) ?? toDate(args.period, tz)
  const to = toDate(args.periodTo, tz)
  if (from === undefined && to === undefined) return undefined
  const range: { from?: Date; to?: Date } = {}
  if (from !== undefined) range.from = from
  if (to !== undefined) range.to = to
  return range
}

function balanceArgs(args: RegisterQueryArgs, tz: string): BalanceArgs {
  const a: BalanceArgs = {}
  const period = toDate(args.period, tz)
  if (period !== undefined) a.Period = period
  if (args.condition !== undefined) a.Condition = args.condition
  if (args.dimensions !== undefined) a.Dimensions = args.dimensions
  if (args.accountCondition !== undefined) a.AccountCondition = args.accountCondition
  if (args.extraDimensions !== undefined) a.ExtraDimensions = args.extraDimensions
  return a
}

function turnoversArgs(args: RegisterQueryArgs, tz: string): TurnoversArgs {
  // Turnovers/balanceAndTurnovers are intervals (StartPeriod/EndPeriod), no point form.
  const a: TurnoversArgs = {}
  const range = rangeFromArgs(args, tz)
  if (range !== undefined) a.Period = range
  if (args.condition !== undefined) a.Condition = args.condition
  if (args.dimensions !== undefined) a.Dimensions = args.dimensions
  if (args.accountCondition !== undefined) a.AccountCondition = args.accountCondition
  if (args.extraDimensions !== undefined) a.ExtraDimensions = args.extraDimensions
  return a
}

function sliceArgs(args: RegisterQueryArgs, tz: string): SliceArgs {
  const a: SliceArgs = {}
  const period = toDate(args.period, tz)
  if (period !== undefined) a.Period = period
  if (args.condition !== undefined) a.Condition = args.condition
  return a
}

function drCrTurnoversArgs(args: RegisterQueryArgs, tz: string): DrCrTurnoversArgs {
  const a: DrCrTurnoversArgs = {}
  const range = rangeFromArgs(args, tz)
  if (range !== undefined) a.Period = range
  if (args.condition !== undefined) a.Condition = args.condition
  if (args.accountCondition !== undefined) a.AccountCondition = args.accountCondition
  if (args.balancedAccountCondition !== undefined) a.BalancedAccountCondition = args.balancedAccountCondition
  if (args.dimensions !== undefined) a.Dimensions = args.dimensions
  if (args.extraDimensions !== undefined) a.ExtraDimensions = args.extraDimensions
  if (args.balancedExtraDimensions !== undefined) a.BalancedExtraDimensions = args.balancedExtraDimensions
  return a
}

function recordsWithExtDimensionsArgs(args: RegisterQueryArgs, tz: string): RecordsWithExtDimensionsArgs {
  const a: RecordsWithExtDimensionsArgs = {}
  const range = rangeFromArgs(args, tz)
  if (range !== undefined) a.Period = range
  if (args.condition !== undefined) a.Condition = args.condition
  return a
}

/**
 * Trim the optional string FI params and drop blank ones, so a whitespace-only
 * value (e.g. `condition: "   "`) is treated as "not provided" rather than
 * dispatched as an empty `Condition=` the register would reject. Date params go
 * through {@link toDate} (which trims, validates and reads them in the server's
 * zone) and need no cleaning here.
 */
function cleanRegisterArgs(args: RegisterQueryArgs): RegisterQueryArgs {
  const {
    condition,
    dimensions,
    accountCondition,
    balancedAccountCondition,
    extraDimensions,
    balancedExtraDimensions,
    ...rest
  } = args
  const opt = (key: string, value: string | undefined): Record<string, string> => {
    const trimmed = value?.trim()
    return trimmed !== undefined && trimmed !== '' ? { [key]: trimmed } : {}
  }
  return {
    ...rest,
    ...opt('condition', condition),
    ...opt('dimensions', dimensions),
    ...opt('accountCondition', accountCondition),
    ...opt('balancedAccountCondition', balancedAccountCondition),
    ...opt('extraDimensions', extraDimensions),
    ...opt('balancedExtraDimensions', balancedExtraDimensions),
  }
}

/**
 * The `$select` / `$filter` system options of a register call, passed through
 * as given — the client's `ReadFiOptions` owns the rule that blank values send
 * nothing.
 */
function readOptions(args: { select?: string[] | undefined; filter?: string | undefined }): ReadFiOptions {
  return {
    ...(args.select !== undefined ? { select: args.select } : {}),
    ...(args.filter !== undefined ? { filter: args.filter } : {}),
  }
}

/** Dispatch a register virtual-table call. Each arg builder is a small pure function. */
function runRegisterTable(
  reg: RegisterHelper<unknown>,
  args: RegisterQueryArgs,
  opts: ReadFiOptions,
  tz: string,
): Promise<Record<string, unknown>[]> {
  switch (args.table) {
    case 'balance':
      return reg.balance(balanceArgs(args, tz), opts)
    case 'turnovers':
      return reg.turnovers(turnoversArgs(args, tz), opts)
    case 'balanceAndTurnovers':
      return reg.balanceAndTurnovers(turnoversArgs(args, tz), opts)
    case 'sliceFirst':
      return reg.sliceFirst(sliceArgs(args, tz), opts)
    case 'sliceLast':
      return reg.sliceLast(sliceArgs(args, tz), opts)
    case 'drCrTurnovers':
      return reg.drCrTurnovers(drCrTurnoversArgs(args, tz), opts)
    case 'extDimensions':
      return reg.extDimensions(opts)
    case 'recordsWithExtDimensions':
      return reg.recordsWithExtDimensions(recordsWithExtDimensionsArgs(args, tz), opts)
  }
}
