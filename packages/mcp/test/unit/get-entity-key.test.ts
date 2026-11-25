import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { describe, expect, it } from 'vitest'
import { type ZodRawShape, z } from 'zod'
import type { ReadPool } from '../../src/connection-pool.js'
import { DEFAULT_LIMITS } from '../../src/limits.js'
import { registerDataTools } from '../../src/tools/data.js'

describe('get_entity key schema', () => {
  function keySchema() {
    let shape: ZodRawShape | undefined
    const server = {
      registerTool: (name: string, config: { inputSchema: ZodRawShape }) => {
        if (name === 'get_entity') shape = config.inputSchema
      },
    } as unknown as McpServer
    registerDataTools(server, {} as ReadPool, DEFAULT_LIMITS)
    if (shape === undefined) throw new Error('get_entity not registered')
    return z.object(shape)
  }

  it('accepts a Ref_Key GUID', () => {
    expect(
      keySchema().safeParse({ connection: 'c', entitySet: 'Catalog_X', key: '11111111-2222-3333-4444-555555555555' })
        .success,
    ).toBe(true)
  })

  it('accepts an upper-case GUID, and its JSON-Schema pattern does too (no `i` flag to lose)', () => {
    const key = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE'
    expect(keySchema().safeParse({ connection: 'c', entitySet: 'Catalog_X', key }).success).toBe(true)
    const pattern = (z.toJSONSchema(keySchema()) as unknown as { properties: { key: { pattern: string } } }).properties
      .key.pattern
    expect(new RegExp(pattern).test(key)).toBe(true)
  })

  it.each(['abc', "x')/../../hs/svc?a=('", ''])('rejects %j before any connection is opened', (key) => {
    expect(keySchema().safeParse({ connection: 'c', entitySet: 'Catalog_X', key }).success).toBe(false)
  })
})
