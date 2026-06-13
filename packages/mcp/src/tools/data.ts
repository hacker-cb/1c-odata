import type {
  BalanceArgs,
  DrCrTurnoversArgs,
  RecordsWithExtDimensionsArgs,
  RegisterHelper,
  SliceArgs,
  TurnoversArgs,
  UntypedEntity,
  V3QueryBuilder,
} from '@1c-odata/client'
import { raw } from '@1c-odata/client/filter'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { ConnectionPool } from '../connection-pool.js'
import { clampTop } from '../limits.js'
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
  startDate?: string | undefined
  endDate?: string | undefined
  condition?: string | undefined
  dimensions?: string | undefined
  accountKey?: string | undefined
  accountDr?: string | undefined
  accountCr?: string | undefined
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

/** Register the read-only data tools (queries, lookups, register virtual tables). */
export function registerDataTools(server: McpServer, pool: ConnectionPool): void {
  server.registerTool(
    'query',
    {
      title: 'Query data',
      description:
        'Read-only OData query against an entity set: raw $filter, $select, $expand, $orderby, $top/$skip, optional total count.',
      inputSchema: {
        connection: z.string().describe('Connection name'),
        entitySet: z.string().describe('Entity set, e.g. Catalog_Валюты'),
        filter: z.string().optional().describe('Raw OData $filter, e.g. "DeletionMark eq false"'),
        select: z
          .array(z.string())
          .optional()
          .describe('Properties to return ("*" = all, "**" = all minus tabular parts)'),
        expand: z.array(z.string()).optional().describe('Navigation properties to expand'),
        orderBy: z
          .array(z.object({ field: z.string(), dir: z.enum(['asc', 'desc']).optional() }))
          .optional()
          .describe('Sort specification (applied in order)'),
        top: z.number().int().optional().describe('Page size (default 50, max 1000)'),
        skip: z.number().int().min(0).optional().describe('Offset for pagination (default 0)'),
        count: z.boolean().optional().describe('Include the total row count (OData $inlinecount)'),
      },
    },
    async ({ connection, entitySet, filter, select, expand, orderBy, top, skip, count }) =>
      toolResult(async () => {
        const { client } = await pool.get(connection)
        const limit = clampTop(top)
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
        return {
          summary: `${result.value.length} row(s)${result.count !== undefined ? ` of ${result.count} total` : ''} from ${entitySet}.`,
          data: {
            connection,
            entitySet,
            ...(result.count !== undefined ? { count: result.count } : {}),
            pagination: {
              skip: offset,
              top: limit,
              returned: result.value.length,
              // With a total count, the last full page still has no more rows.
              hasMore:
                result.count !== undefined
                  ? offset + result.value.length < result.count
                  : result.value.length === limit,
            },
            value: result.value,
          },
        }
      }),
  )

  server.registerTool(
    'get_entity',
    {
      title: 'Get entity',
      description:
        'Fetch a single entity by key (Ref_Key GUID). For a projection or $expand of one record, use query with filter "Ref_Key eq guid\'…\'".',
      inputSchema: {
        connection: z.string().describe('Connection name'),
        entitySet: z.string().describe('Entity set, e.g. Catalog_Валюты'),
        key: z.string().describe('Entity key — usually the Ref_Key GUID'),
      },
    },
    async ({ connection, entitySet, key }) =>
      toolResult(async () => {
        const { client } = await pool.get(connection)
        const entity = await client.entity<UntypedEntity>(entitySet, key).get()
        return { summary: `Fetched ${entitySet}(${key}).`, data: { connection, entitySet, key, entity } }
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
        'Query a 1С register virtual table (read-only analytics): balance/turnovers/balanceAndTurnovers (accumulation), sliceFirst/sliceLast (information), drCrTurnovers/extDimensions/recordsWithExtDimensions (accounting). Dates are ISO 8601 strings.',
      inputSchema: {
        connection: z.string().describe('Connection name'),
        register: z.string().describe('Register entity set, e.g. AccumulationRegister_ТоварыНаСкладах'),
        table: z.enum(REGISTER_TABLES).describe('Virtual table to query'),
        period: z.string().optional().describe('ISO date — point in time for balance/slice/turnovers'),
        periodFrom: z.string().optional().describe('ISO date — range start for turnovers'),
        periodTo: z.string().optional().describe('ISO date — range end for turnovers'),
        startDate: z.string().optional().describe('ISO date — range start for accounting tables'),
        endDate: z.string().optional().describe('ISO date — range end for accounting tables'),
        condition: z.string().optional().describe('Raw OData condition expression'),
        dimensions: z.string().optional().describe('Comma-separated dimension names'),
        accountKey: z.string().optional().describe('Account Ref_Key for extDimensions'),
        accountDr: z.string().optional().describe('Debit account binding (entity-set path) for drCrTurnovers'),
        accountCr: z.string().optional().describe('Credit account binding (entity-set path) for drCrTurnovers'),
      },
    },
    async (args) =>
      toolResult(async () => {
        const { client } = await pool.get(args.connection)
        const rows = await runRegisterTable(client.register(args.register), args)
        return {
          summary: `${rows.length} row(s) from ${args.register}.${args.table}.`,
          data: {
            connection: args.connection,
            register: args.register,
            table: args.table,
            returned: rows.length,
            rows,
          },
        }
      }),
  )
}

function toDate(iso: string | undefined): Date | undefined {
  if (iso === undefined) return undefined
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid ISO date: "${iso}"`)
  return date
}

function balanceArgs(args: RegisterQueryArgs): BalanceArgs {
  const a: BalanceArgs = {}
  const period = toDate(args.period)
  if (period !== undefined) a.Period = period
  if (args.condition !== undefined) a.Condition = args.condition
  if (args.dimensions !== undefined) a.Dimensions = args.dimensions
  return a
}

function turnoversArgs(args: RegisterQueryArgs): TurnoversArgs {
  const a: TurnoversArgs = {}
  const from = toDate(args.periodFrom)
  const to = toDate(args.periodTo)
  const period = toDate(args.period)
  if (from !== undefined && to !== undefined) a.Period = { from, to }
  else if (period !== undefined) a.Period = period
  if (args.condition !== undefined) a.Condition = args.condition
  if (args.dimensions !== undefined) a.Dimensions = args.dimensions
  return a
}

function sliceArgs(args: RegisterQueryArgs): SliceArgs {
  const a: SliceArgs = {}
  const period = toDate(args.period)
  if (period !== undefined) a.Period = period
  if (args.condition !== undefined) a.Condition = args.condition
  return a
}

function drCrTurnoversArgs(args: RegisterQueryArgs): DrCrTurnoversArgs {
  const a: DrCrTurnoversArgs = {}
  const start = toDate(args.startDate)
  const end = toDate(args.endDate)
  if (start !== undefined) a.StartDate = start
  if (end !== undefined) a.EndDate = end
  if (args.accountDr !== undefined) a.AccountDr = { '@odata.bind': args.accountDr }
  if (args.accountCr !== undefined) a.AccountCr = { '@odata.bind': args.accountCr }
  return a
}

function recordsWithExtDimensionsArgs(args: RegisterQueryArgs): RecordsWithExtDimensionsArgs {
  const a: RecordsWithExtDimensionsArgs = {}
  const start = toDate(args.startDate)
  const end = toDate(args.endDate)
  if (start !== undefined) a.StartDate = start
  if (end !== undefined) a.EndDate = end
  return a
}

/** Dispatch a register virtual-table call. Each arg builder is a small pure function. */
function runRegisterTable(reg: RegisterHelper<unknown>, args: RegisterQueryArgs): Promise<Record<string, unknown>[]> {
  switch (args.table) {
    case 'balance':
      return reg.balance(balanceArgs(args))
    case 'turnovers':
      return reg.turnovers(turnoversArgs(args))
    case 'balanceAndTurnovers':
      return reg.balanceAndTurnovers(turnoversArgs(args))
    case 'sliceFirst':
      return reg.sliceFirst(sliceArgs(args))
    case 'sliceLast':
      return reg.sliceLast(sliceArgs(args))
    case 'drCrTurnovers':
      return reg.drCrTurnovers(drCrTurnoversArgs(args))
    case 'extDimensions':
      return reg.extDimensions(args.accountKey !== undefined ? { Account_Key: args.accountKey } : {})
    case 'recordsWithExtDimensions':
      return reg.recordsWithExtDimensions(recordsWithExtDimensionsArgs(args))
  }
}
