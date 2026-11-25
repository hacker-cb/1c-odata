import type { ReadFiCountOptions } from '@1c-odata/client'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import type { PoolEntry, ReadPool } from '../../src/connection-pool.js'
import { DEFAULT_LIMITS, type Limits } from '../../src/limits.js'
import { registerDataTools } from '../../src/tools/data.js'

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>

interface Result {
  total?: number
  totalCapped?: boolean
  pagination: { skip: number; top: number; returned: number; truncated: boolean; hasMore: boolean }
  rows: { n: number }[]
}

/**
 * register_query over a register whose virtual table has `rowCount` rows and
 * pages them as 1С does: `$skip` / `$top` on the server, `odata.count` alongside
 * (left out where `reportCount` is false). Every call's options are recorded.
 */
function setup(rowCount: number, limits: Limits, { reportCount = true, pad = '' } = {}) {
  let handler: Handler | undefined
  const server = {
    registerTool: (name: string, _config: unknown, h: Handler) => {
      if (name === 'register_query') handler = h
    },
  } as unknown as McpServer
  const calls: ReadFiCountOptions[] = []
  const helper = {
    balance: async (_args: unknown, opts: ReadFiCountOptions) => {
      calls.push(opts)
      const skip = opts.skip ?? 0
      const top = opts.top ?? rowCount
      const value = Array.from({ length: Math.max(0, Math.min(top, rowCount - skip)) }, (_, i) =>
        pad === '' ? { n: skip + i } : { n: skip + i, pad },
      )
      return reportCount ? { value, count: rowCount } : { value }
    },
  }
  const client = { serverTimezone: 'Europe/Moscow', register: () => helper }
  const pool = { get: async () => ({ client }) as unknown as PoolEntry } as unknown as ReadPool
  registerDataTools(server, pool, limits)
  const run = async (args: Record<string, unknown>) => {
    if (handler === undefined) throw new Error('register_query not registered')
    const res = await handler({ connection: 'c', register: 'AccumulationRegister_X', table: 'balance', ...args })
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

  it('falls back to a full page as the hint when 1С reports no count', async () => {
    const { run } = setup(6, limits, { reportCount: false })
    const first = await run({ skip: 0 })
    expect(first.data.total).toBeUndefined()
    expect(first.data.pagination.hasMore).toBe(true)
    expect((await run({ skip: 4 })).data.pagination.hasMore).toBe(false)
  })

  it('keeps hasMore when the byte budget cut the page, even on the last rows', async () => {
    // Rows of ~600 bytes against a 1 KiB budget: only one of the four fits.
    const { run } = setup(4, { ...limits, maxBytes: 1024 }, { pad: 'x'.repeat(600) })
    const { data } = await run({ skip: 0 })
    expect(data.pagination).toMatchObject({ returned: 1, truncated: true, hasMore: true })
  })
})
