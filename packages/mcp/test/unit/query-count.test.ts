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
  count?: number
  pagination: { skip: number; top: number; fetched: number; returned: number; truncated: boolean; hasMore: boolean }
  value: { n: number }[]
}

interface Calls {
  builder: string[]
  get: (AbortSignal | undefined)[]
  count: (AbortSignal | undefined)[]
  /** Whether each page request was aborted while still in flight. */
  abortedInFlight: boolean[]
}

/**
 * The query tool over an entity set of `rowCount` rows that 1С pages as asked
 * (`$skip` / `$top`, each ignorable). Every builder method called is recorded;
 * `failCount` makes `/$count` fail while the page is loading; `count` is what
 * `/$count` answers (the row count by default).
 */
function setup(
  rowCount: number,
  limits: Limits,
  { ignoreTop = false, ignoreSkip = false, failCount = false, count = rowCount } = {},
) {
  let handler: Handler | undefined
  const server = {
    registerTool: (name: string, _config: unknown, h: Handler) => {
      if (name === 'query') handler = h
    },
  } as unknown as McpServer
  const calls: Calls = { builder: [], get: [], count: [], abortedInFlight: [] }
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
      calls.abortedInFlight.push(opts.signal?.aborted === true)
      const skip = ignoreSkip ? 0 : (state.skip ?? 0)
      const top = ignoreTop ? rowCount : (state.top ?? rowCount)
      const value = Array.from({ length: Math.max(0, Math.min(top, rowCount - skip)) }, (_, i) => ({ n: skip + i }))
      return { odataMetadata: '#X', value }
    },
    count: async (opts: { signal?: AbortSignal } = {}) => {
      calls.count.push(opts.signal)
      if (failCount) throw new Error('count failed')
      return count
    },
  }
  const client = { serverTimezone: 'Europe/Moscow', query: () => builder }
  const pool = { get: async () => ({ client }) as unknown as PoolEntry } as unknown as ReadPool
  registerDataTools(server, pool, limits)
  const run = async (args: Record<string, unknown>) => {
    if (handler === undefined) throw new Error('query not registered')
    const res = await handler({ connection: 'c', entitySet: 'Catalog_Валюты', ...args }, extra)
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

  it('pages on past a full page landing exactly on the total; the empty page after ends it (#234)', async () => {
    const { run } = setup(8, limits)
    expect((await run({ count: true, skip: 4 })).data.pagination.hasMore).toBe(true)
    expect((await run({ count: true, skip: 8 })).data.pagination).toMatchObject({ returned: 0, hasMore: false })
  })

  it('ends hasMore on a short last page', async () => {
    const { run } = setup(6, limits)
    expect((await run({ count: true, skip: 4 })).data.pagination).toMatchObject({ returned: 2, hasMore: false })
  })

  it('reaches every row past a short count that a full page lands on (#234)', async () => {
    // 12 rows, counted 8 (a select on a virtual table 1С counts rolled up and returns un-rolled).
    const { run } = setup(12, limits, { count: 8 })
    const seen: number[] = []
    let skip = 0
    // Bounded: a regression answering hasMore on an empty page must fail, not hang.
    for (let page = 0; page < 10; page++) {
      const { data } = await run({ count: true, skip })
      seen.push(...data.value.map((r) => r.n))
      if (!data.pagination.hasMore) break
      skip += data.pagination.returned
    }
    expect(seen).toEqual(Array.from({ length: 12 }, (_, i) => i))
  })

  it('a failing /$count fails the call and aborts the page', async () => {
    const { run, calls } = setup(10, limits, { failCount: true })
    const { res } = await run({ count: true })
    expect(res.isError).toBe(true)
    // Asked in parallel: /$count failed while the page was still loading, and aborted it.
    await new Promise((r) => setTimeout(r, 30))
    expect(calls.abortedInFlight).toEqual([true])
  })

  it('cuts a page 1С sent past top (honouring skip) back to top, and says so', async () => {
    const { run } = setup(10, limits, { ignoreTop: true })
    const { data, summary } = await run({ count: true, skip: 2 })
    expect(data.value.map((r) => r.n)).toEqual([2, 3, 4, 5])
    expect(data.pagination.hasMore).toBe(true)
    expect(JSON.stringify(summary)).toContain('ignored $top')
  })

  it('a page with as many rows as counted at a skip is ambiguous: no rows dropped, no paging on', async () => {
    // 1С ignored $top and $skip — or counted short: both send all 10 rows here.
    const { run } = setup(10, limits, { ignoreTop: true, ignoreSkip: true })
    const { data, summary } = await run({ count: true, skip: 8 })
    expect(data.value.map((r) => r.n)).toEqual([0, 1, 2, 3])
    expect(data.pagination.hasMore).toBe(false)
    expect(JSON.stringify(summary)).toContain('exactly as many as it counted')
  })

  it('a short count matching the rows past skip does not drop the rows asked for', async () => {
    // 10 rows, /$count says 6, 1С ignores only $top: rows 4..9 come back — six of them.
    const { run } = setup(10, limits, { ignoreTop: true, count: 6 })
    const { data } = await run({ count: true, skip: 4 })
    expect(data.value.map((r) => r.n)).toEqual([4, 5, 6, 7])
    expect(data.pagination.hasMore).toBe(false)
  })

  it('never loops on the first rows when 1С ignored $top and $skip and counts short (#214)', async () => {
    const { run } = setup(10, limits, { ignoreTop: true, ignoreSkip: true, count: 6 })
    const { data, summary } = await run({ count: true, skip: 4 })
    expect(data.value.map((r) => r.n)).toEqual([0, 1, 2, 3])
    expect(data.pagination.hasMore).toBe(false)
    expect(JSON.stringify(summary)).toContain('more than it counted')
  })

  it('without count cuts a page past top to top, and offers no paging on (1С may ignore $skip too)', async () => {
    const { run } = setup(10, limits, { ignoreTop: true, ignoreSkip: true })
    const { data, summary } = await run({ skip: 4 })
    expect(data.value).toHaveLength(4)
    expect(data.pagination.hasMore).toBe(false)
    expect(JSON.stringify(summary)).toContain('page with count:true')
  })

  it('without count offers no paging on past top even where the byte budget cut the page', async () => {
    const { run } = setup(10, { ...limits, maxBytes: 12 }, { ignoreTop: true, ignoreSkip: true })
    const { data } = await run({})
    expect(data.pagination.truncated).toBe(true)
    expect(data.pagination.hasMore).toBe(false)
  })

  it('within top too: as many rows as counted at a skip offers no paging on', async () => {
    const { run } = setup(3, limits, { ignoreTop: true, ignoreSkip: true })
    const { data, summary } = await run({ count: true, skip: 2 })
    expect(data.value.map((r) => r.n)).toEqual([0, 1, 2])
    expect(data.pagination.hasMore).toBe(false)
    expect(JSON.stringify(summary)).toContain('ignored $skip')
  })

  it('an empty page ends the paging even where the count says more (rows a $select rolls up)', async () => {
    const { run } = setup(2, limits, { count: 178 })
    const { data } = await run({ count: true, skip: 4 })
    expect(data.value).toHaveLength(0)
    expect(data.pagination.hasMore).toBe(false)
  })

  it('a full page goes on once the rows outran the count', async () => {
    const { run } = setup(10, limits, { count: 6 })
    const { data } = await run({ count: true, skip: 4 })
    expect(data.value.map((r) => r.n)).toEqual([4, 5, 6, 7])
    expect(data.pagination.hasMore).toBe(true)
  })

  it('says nothing about $top when 1С kept to it', async () => {
    const { run } = setup(10, limits)
    const { summary } = await run({ count: true })
    expect(JSON.stringify(summary)).not.toContain('$top')
  })
})
