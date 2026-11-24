import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import type { PoolEntry, ReadPool } from '../../src/connection-pool.js'
import { DEFAULT_LIMITS, type Limits } from '../../src/limits.js'
import { registerDataTools } from '../../src/tools/data.js'

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>

/** register_query over a register whose virtual table returns `rowCount` rows (capped by the call's $top). */
function setup(rowCount: number, limits: Limits) {
  let handler: Handler | undefined
  const server = {
    registerTool: (name: string, _config: unknown, h: Handler) => {
      if (name === 'register_query') handler = h
    },
  } as unknown as McpServer
  const helper = {
    balance: async (_args: unknown, opts: { top?: number }) =>
      Array.from({ length: Math.min(rowCount, opts.top ?? rowCount) }, (_, i) => ({ n: i })),
  }
  const client = { serverTimezone: 'Europe/Moscow', register: () => helper }
  const pool = { get: async () => ({ client }) as unknown as PoolEntry } as unknown as ReadPool
  registerDataTools(server, pool, limits)
  return async (args: Record<string, unknown>) => {
    if (handler === undefined) throw new Error('register_query not registered')
    const res = await handler({ connection: 'c', register: 'AccumulationRegister_X', table: 'balance', ...args })
    return (res.structuredContent ?? {}) as {
      total: number
      totalCapped?: boolean
      pagination: { returned: number; hasMore: boolean }
    }
  }
}

describe('register_query paging past the row cap', () => {
  const limits: Limits = { ...DEFAULT_LIMITS, maxRegisterRows: 10, defaultTop: 4, maxTop: 4 }

  it('pages through the capped rows and stops at the cap, still flagging it', async () => {
    const run = setup(25, limits)
    const first = await run({ skip: 0 })
    expect(first.totalCapped).toBe(true)
    expect(first.pagination).toMatchObject({ returned: 4, hasMore: true })
    const last = await run({ skip: 8 })
    expect(last.pagination).toMatchObject({ returned: 2, hasMore: false })
    expect(last.totalCapped).toBe(true)
    const past = await run({ skip: 10 })
    expect(past.pagination).toMatchObject({ returned: 0, hasMore: false })
  })

  it('keeps hasMore for a register under the cap while rows remain', async () => {
    const run = setup(6, limits)
    expect((await run({ skip: 0 })).pagination.hasMore).toBe(true)
    expect((await run({ skip: 4 })).pagination.hasMore).toBe(false)
  })
})
