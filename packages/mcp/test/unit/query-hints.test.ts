import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import type { PoolEntry, ReadPool } from '../../src/connection-pool.js'
import { DEFAULT_LIMITS } from '../../src/limits.js'
import { registerDataTools } from '../../src/tools/data.js'

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>

/** Register the data tools against a capturing server and a client whose query builder returns no rows. */
function setup() {
  const tools = new Map<string, { description: string; handler: Handler }>()
  const server = {
    registerTool: (name: string, config: { description: string }, handler: Handler) =>
      tools.set(name, { description: config.description, handler }),
  } as unknown as McpServer
  const builder: Record<string, unknown> = new Proxy(
    {},
    { get: (_t, key) => (key === 'get' ? async () => ({ value: [] }) : () => builder) },
  )
  const client = { serverTimezone: 'Europe/Moscow', query: () => builder }
  const pool = { get: async () => ({ client }) as unknown as PoolEntry } as unknown as ReadPool
  registerDataTools(server, pool, DEFAULT_LIMITS)
  return tools
}

describe('query: register virtual tables in the path (#181)', () => {
  it('the description names the per-segment limit and points to register_query', () => {
    const description = setup().get('query')?.description ?? ''
    expect(description).toContain('ONE URL path segment')
    expect(description).toContain('260 characters')
    expect(description).toContain('register_query sends them in the query string')
  })

  it('a virtual-table entity set gets the segment-limit tip in its summary', async () => {
    const query = setup().get('query')
    if (query === undefined) throw new Error('query not registered')
    const res = await query.handler({
      connection: 'c',
      entitySet: "AccountingRegister_X/Turnovers(AccountCondition='Account_Key eq guid''g1''')",
    })
    const text = (res.content[0] as { text: string }).text
    expect(text).toContain('register_query aggregates it server-side and sends its parameters in the query string')
    expect(text).toContain('IIS caps at 260 characters')
  })

  it('register_query itself carries no segment-limit warning — it has no such limit', () => {
    expect(setup().get('register_query')?.description).not.toMatch(/260|segment/)
  })
})
