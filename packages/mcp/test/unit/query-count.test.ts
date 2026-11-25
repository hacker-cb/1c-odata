import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import type { PoolEntry, ReadPool } from '../../src/connection-pool.js'
import { DEFAULT_LIMITS, type Limits } from '../../src/limits.js'
import { registerDataTools } from '../../src/tools/data.js'

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>

interface Result {
  count?: number
  pagination: { skip: number; top: number; fetched: number; returned: number; truncated: boolean; hasMore: boolean }
  value: { n: number }[]
}

interface Calls {
  builder: string[]
  get: (AbortSignal | undefined)[]
  count: (AbortSignal | undefined)[]
}

/**
 * The query tool over an entity set of `rowCount` rows that 1С pages as asked
 * (`$skip` / `$top`, each ignorable). Every builder method called is recorded;
 * `failCount` makes `/$count` fail after the page has started.
 */
function setup(rowCount: number, limits: Limits, { ignoreTop = false, ignoreSkip = false, failCount = false } = {}) {
  let handler: Handler | undefined
  const server = {
    registerTool: (name: string, _config: unknown, h: Handler) => {
      if (name === 'query') handler = h
    },
  } as unknown as McpServer
  const calls: Calls = { builder: [], get: [], count: [] }
  const state: { top?: number; skip?: number } = {}
  const chain =
    (name: string, set?: (n: number) => void) =>
    (n: number): unknown => {
      calls.builder.push(name)
      set?.(n)
      return builder
    }
  const builder: Record<string, unknown> = {
    filter: chain('filter'),
    select: chain('select'),
    orderBy: chain('orderBy'),
    withCount: chain('withCount'),
    top: chain('top', (n) => {
      state.top = n
    }),
    skip: chain('skip', (n) => {
      state.skip = n
    }),
    get: async (opts: { signal?: AbortSignal } = {}) => {
      calls.get.push(opts.signal)
      // The page answers after /$count has had its chance to fail.
      await new Promise((r) => setTimeout(r, 10))
      const skip = ignoreSkip ? 0 : (state.skip ?? 0)
      const top = ignoreTop ? rowCount : (state.top ?? rowCount)
      const value = Array.from({ length: Math.max(0, Math.min(top, rowCount - skip)) }, (_, i) => ({ n: skip + i }))
      return { odataMetadata: '#X', value }
    },
    count: async (opts: { signal?: AbortSignal } = {}) => {
      calls.count.push(opts.signal)
      if (failCount) throw new Error('count failed')
      return rowCount
    },
  }
  const client = { serverTimezone: 'Europe/Moscow', query: () => builder }
  const pool = { get: async () => ({ client }) as unknown as PoolEntry } as unknown as ReadPool
  registerDataTools(server, pool, limits)
  const run = async (args: Record<string, unknown>) => {
    if (handler === undefined) throw new Error('query not registered')
    const res = await handler({ connection: 'c', entitySet: 'Catalog_Валюты', ...args })
    return { res, data: (res.structuredContent ?? {}) as unknown as Result, summary: res.content?.[0] }
  }
  return { run, calls }
}

describe('query with count: a parallel /$count, never $inlinecount (#206)', () => {
  const limits: Limits = { ...DEFAULT_LIMITS, defaultTop: 4, maxTop: 4 }

  it('asks for the page and /$count — withCount() never called', async () => {
    const { run, calls } = setup(10, limits)
    const { data } = await run({ count: true, skip: 4, filter: 'DeletionMark eq false' })
    expect(calls.builder).not.toContain('withCount')
    expect(calls.get).toHaveLength(1)
    expect(calls.count).toHaveLength(1)
    expect(data.count).toBe(10)
    expect(data.value.map((r) => r.n)).toEqual([4, 5, 6, 7])
    expect(data.pagination.hasMore).toBe(true)
  })

  it('without count asks for the page alone', async () => {
    const { run, calls } = setup(10, limits)
    const { data } = await run({})
    expect(calls.count).toHaveLength(0)
    expect(data.count).toBeUndefined()
    expect(data.pagination.hasMore).toBe(true)
  })

  it('ends hasMore at the last page by the total', async () => {
    const { run } = setup(8, limits)
    const { data } = await run({ count: true, skip: 4 })
    expect(data.pagination.hasMore).toBe(false)
  })

  it('a failing /$count fails the call and aborts the page', async () => {
    const { run, calls } = setup(10, limits, { failCount: true })
    const { res } = await run({ count: true })
    expect(res.isError).toBe(true)
    expect(calls.get[0]?.aborted).toBe(true)
  })

  it('cuts a page 1С sent past top (honouring skip) back to top, and says so', async () => {
    const { run } = setup(10, limits, { ignoreTop: true })
    const { data, summary } = await run({ count: true, skip: 2 })
    expect(data.value.map((r) => r.n)).toEqual([2, 3, 4, 5])
    expect(data.pagination.hasMore).toBe(true)
    expect(JSON.stringify(summary)).toContain('ignored $top')
  })

  it('pages the whole set here when 1С ignored both $top and $skip', async () => {
    const { run } = setup(10, limits, { ignoreTop: true, ignoreSkip: true })
    const { data, summary } = await run({ count: true, skip: 8 })
    expect(data.value.map((r) => r.n)).toEqual([8, 9])
    expect(data.pagination.hasMore).toBe(false)
    expect(JSON.stringify(summary)).toContain('starting at skip 8')
  })

  it('cuts a page past top without count too', async () => {
    const { run } = setup(10, limits, { ignoreTop: true })
    const { data } = await run({})
    expect(data.value).toHaveLength(4)
    expect(data.pagination.hasMore).toBe(true)
  })

  it('says nothing about $top when 1С kept to it', async () => {
    const { run } = setup(10, limits)
    const { summary } = await run({ count: true })
    expect(JSON.stringify(summary)).not.toContain('$top')
  })
})
