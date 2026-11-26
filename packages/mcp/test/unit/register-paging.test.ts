import type { ReadFiCountOptions } from '@1c-odata/client'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import type { PoolEntry, ReadPool } from '../../src/connection-pool.js'
import { DEFAULT_LIMITS, type Limits } from '../../src/limits.js'
import { registerDataTools } from '../../src/tools/data.js'

type Handler = (args: Record<string, unknown>, extra: { signal: AbortSignal }) => Promise<CallToolResult>

/** What the MCP SDK hands a tool handler beside its arguments — a request never cancelled. */
const extra = { signal: new AbortController().signal }

interface Result {
  total: number
  totalCapped?: boolean
  pagination: { skip: number; top: number; returned: number; truncated: boolean; hasMore: boolean }
  rows: { n: number }[]
}

/**
 * register_query over a register whose virtual table has `rowCount` rows and
 * pages them as 1С does: `$skip` / `$top` on the server (ignoring `$top` where
 * `ignoreTop`), the count alongside. Every call's options are recorded.
 */
function setup(
  rowCount: number,
  limits: Limits,
  { ignoreTop = false, ignoreSkip = false, count = rowCount, pad = '' } = {},
) {
  let handler: Handler | undefined
  const server = {
    registerTool: (name: string, _config: unknown, h: Handler) => {
      if (name === 'register_query') handler = h
    },
  } as unknown as McpServer
  const calls: ReadFiCountOptions[] = []
  const helper = {
    balance: async (_args: unknown, opts: ReadFiCountOptions) => {
      // The MCP request's signal rides along (#216, cancel.test.ts); the paging is what is pinned here.
      const { signal: _signal, ...paging } = opts
      calls.push(paging)
      const skip = ignoreSkip ? 0 : (opts.skip ?? 0)
      const top = ignoreTop ? rowCount : (opts.top ?? rowCount)
      const value = Array.from({ length: Math.max(0, Math.min(top, rowCount - skip)) }, (_, i) =>
        pad === '' ? { n: skip + i } : { n: skip + i, pad },
      )
      return { value, count }
    },
  }
  const client = { serverTimezone: 'Europe/Moscow', register: () => helper }
  const pool = { get: async () => ({ client }) as unknown as PoolEntry } as unknown as ReadPool
  registerDataTools(server, pool, limits)
  const run = async (args: Record<string, unknown>) => {
    if (handler === undefined) throw new Error('register_query not registered')
    const res = await handler({ connection: 'c', register: 'AccumulationRegister_X', table: 'balance', ...args }, extra)
    expect(res.isError).toBeUndefined()
    return { data: (res.structuredContent ?? {}) as unknown as Result, summary: res.content?.[0] }
  }
  return { run, calls }
}

describe('register_query pages on the 1С server (#192)', () => {
  const limits: Limits = { ...DEFAULT_LIMITS, defaultTop: 4, maxTop: 4 }

  it('asks 1С for one page and the count — never the whole table', async () => {
    const { run, calls } = setup(250_000, limits)
    const { data } = await run({ skip: 100_000 })
    expect(calls).toEqual([{ top: 4, skip: 100_000, count: true }])
    expect(data.rows.map((r) => r.n)).toEqual([100_000, 100_001, 100_002, 100_003])
    // The total is exact past the old 100 000-row cap, and nothing is flagged as capped.
    expect(data.total).toBe(250_000)
    expect(data.totalCapped).toBeUndefined()
    expect(data.pagination).toMatchObject({ skip: 100_000, top: 4, returned: 4, hasMore: true })
  })

  it('sends no $skip on the first page', async () => {
    const { run, calls } = setup(3, limits)
    await run({})
    expect(calls).toEqual([{ top: 4, count: true }])
  })

  it('ends hasMore at the last row, and past it', async () => {
    const { run } = setup(6, limits)
    expect((await run({ skip: 0 })).data.pagination).toMatchObject({ returned: 4, hasMore: true })
    expect((await run({ skip: 4 })).data.pagination).toMatchObject({ returned: 2, hasMore: false })
    expect((await run({ skip: 6 })).data.pagination).toMatchObject({ returned: 0, hasMore: false })
  })

  it('keeps hasMore on an exact last full page only while the total says rows remain', async () => {
    const { run } = setup(8, limits)
    expect((await run({ skip: 4 })).data.pagination).toMatchObject({ returned: 4, hasMore: false })
  })

  it('cuts a page 1С sent past top (honouring skip) back to top, and says so', async () => {
    const { run } = setup(10, limits, { ignoreTop: true })
    const { data, summary } = await run({ skip: 4 })
    expect(data.rows.map((r) => r.n)).toEqual([4, 5, 6, 7])
    expect(data.pagination).toMatchObject({ returned: 4, hasMore: true })
    expect(JSON.stringify(summary)).toContain('ignored $top')
  })

  it('drops no rows on a guess when 1С ignored both $top and $skip (#214)', async () => {
    // As many rows as counted at a skip: these may be the table's first rows, or a short count.
    const { run } = setup(10, limits, { ignoreTop: true, ignoreSkip: true })
    const { data, summary } = await run({ skip: 8 })
    expect(data.rows.map((r) => r.n)).toEqual([0, 1, 2, 3])
    expect(data.pagination).toMatchObject({ returned: 4, hasMore: false })
    const text = JSON.stringify(summary)
    expect(text).toContain('ignored $skip too')
    expect(text).toContain('counts fewer rows than it returns')
    expect(text).toContain('Paging on stops here')
  })

  it('keeps the rows asked for when $top is ignored and a short count equals them (#214)', async () => {
    // 1С honoured $skip, ignored $top, and counted 6 of 10 rows: rows 4–9 — six — came back.
    const { run } = setup(10, limits, { ignoreTop: true, count: 6 })
    const { data, summary } = await run({ skip: 4 })
    expect(data.rows.map((r) => r.n)).toEqual([4, 5, 6, 7])
    expect(data.pagination).toMatchObject({ returned: 4, hasMore: false })
    expect(JSON.stringify(summary)).toContain('Paging on stops here')
  })

  it('stops on an ambiguous page even when the byte budget cut it (#214)', async () => {
    const { run } = setup(
      10,
      { ...limits, maxBytes: 1024 },
      { ignoreTop: true, ignoreSkip: true, pad: 'x'.repeat(600) },
    )
    const { data } = await run({ skip: 8 })
    expect(data.pagination).toMatchObject({ returned: 1, truncated: true, hasMore: false })
  })

  it('ends the paging on an empty page, whatever the parallel count says', async () => {
    // The count saw 12 rows, the page — read a moment later — none past skip 10.
    const { run } = setup(10, limits, { count: 12 })
    expect((await run({ skip: 10 })).data.pagination).toMatchObject({ returned: 0, hasMore: false })
  })

  it('keeps paging from the rows in hand when 1С ignored $top and the count is short', async () => {
    // 1С honoured $skip but not $top and counted 3 of 10 rows: rows 4–9 came back.
    const { run } = setup(10, limits, { ignoreTop: true, count: 3 })
    const { data } = await run({ skip: 4 })
    expect(data.rows.map((r) => r.n)).toEqual([4, 5, 6, 7])
    expect(data.pagination).toMatchObject({ returned: 4, hasMore: true })
  })

  it('pages on by full pages once the rows outrun a short count (ungrouped $select)', async () => {
    // 1С counted 6 (grouped) but holds 10 rows (ungrouped).
    const { run } = setup(10, limits, { count: 6 })
    expect((await run({ skip: 0 })).data.pagination.hasMore).toBe(true)
    const second = await run({ skip: 4 })
    expect(second.data.pagination).toMatchObject({ returned: 4, hasMore: true })
    expect(JSON.stringify(second.summary)).toContain('not the number of rows')
    expect((await run({ skip: 8 })).data.pagination).toMatchObject({ returned: 2, hasMore: false })
  })

  it('says nothing about $top when 1С kept to it', async () => {
    const { run } = setup(10, limits)
    expect(JSON.stringify((await run({ skip: 4 })).summary)).not.toContain('ignored $top')
  })

  it('keeps hasMore when the byte budget cut the page, even on the last rows', async () => {
    // Rows of ~600 bytes against a 1 KiB budget: only one of the four fits.
    const { run } = setup(4, { ...limits, maxBytes: 1024 }, { pad: 'x'.repeat(600) })
    const { data } = await run({ skip: 0 })
    expect(data.pagination).toMatchObject({ returned: 1, truncated: true, hasMore: true })
  })
})
