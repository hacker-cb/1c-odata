import type { ReadFiOptions } from '@1c-odata/client'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import type { PoolEntry, ReadPool } from '../../src/connection-pool.js'
import { DEFAULT_LIMITS } from '../../src/limits.js'
import { registerDataTools } from '../../src/tools/data.js'

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>

interface Call {
  register: string
  method: string
  args: unknown
  opts: ReadFiOptions
}

/**
 * Register the data tools against a capturing server and a pool whose client's
 * RegisterHelper records every virtual-table call — the MCP layer is exercised
 * end to end without HTTP; the URL encoding is the client's (register.test.ts).
 */
function setup(rows: Record<string, unknown>[] = [], serverTimezone = 'Europe/Moscow') {
  const handlers = new Map<string, Handler>()
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => handlers.set(name, handler),
  } as unknown as McpServer
  const calls: Call[] = []
  const helper = (register: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) => async (a: unknown, o?: ReadFiOptions) => {
          // extDimensions takes only the options.
          const [args, opts] = method === 'extDimensions' ? [undefined, a as ReadFiOptions] : [a, o ?? {}]
          calls.push({ register, method, args, opts })
          return rows
        },
      },
    )
  const client = { serverTimezone, register: helper }
  const pool = { get: async () => ({ client }) as unknown as PoolEntry } as unknown as ReadPool
  registerDataTools(server, pool, DEFAULT_LIMITS)
  const run = async (args: Record<string, unknown>) => {
    const handler = handlers.get('register_query')
    if (handler === undefined) throw new Error('register_query not registered')
    return handler({ connection: 'c', register: 'AccountingRegister_Хозрасчетный', ...args })
  }
  return { run, calls }
}

describe('register_query select / filter (#179)', () => {
  it('passes select (the grouping) and filter to the virtual-table call', async () => {
    const { run, calls } = setup()
    const res = await run({
      table: 'turnovers',
      periodFrom: '2026-01-01T00:00:00Z',
      accountCondition: "Account_Key eq guid'g1'",
      select: ['Account_Key', ' СуммаTurnoverDr ', ''],
      filter: ' СуммаTurnoverDr gt 100000 ',
    })
    expect(res.isError).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('turnovers')
    expect(calls[0]?.opts).toEqual({
      top: DEFAULT_LIMITS.maxRegisterRows + 1,
      select: ['Account_Key', 'СуммаTurnoverDr'],
      filter: 'СуммаTurnoverDr gt 100000',
    })
  })

  it('sends neither option when absent or blank', async () => {
    const { run, calls } = setup()
    await run({ table: 'balance' })
    await run({ table: 'balance', select: [' '], filter: '  ' })
    expect(calls.map((c) => c.opts)).toEqual([
      { top: DEFAULT_LIMITS.maxRegisterRows + 1 },
      { top: DEFAULT_LIMITS.maxRegisterRows + 1 },
    ])
  })

  it('applies to the no-argument extDimensions table too', async () => {
    const { run, calls } = setup()
    await run({ table: 'extDimensions', select: ['ExtDimension_Type'] })
    expect(calls[0]?.opts.select).toEqual(['ExtDimension_Type'])
  })
})
