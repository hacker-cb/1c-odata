import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { type ZodRawShape, z } from 'zod'
import type { PoolEntry, ReadPool } from '../../src/connection-pool.js'
import { DEFAULT_LIMITS } from '../../src/limits.js'
import { registerDataTools } from '../../src/tools/data.js'

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>

/** register_query against a client whose RegisterHelper records the FI arguments of each call. */
function setup(serverTimezone: string) {
  let handler: Handler | undefined
  const server = {
    registerTool: (name: string, config: { inputSchema: ZodRawShape }, h: Handler) => {
      if (name === 'register_query') handler = (args) => h(z.object(config.inputSchema).parse(args))
    },
  } as unknown as McpServer
  const calls: { method: string; args: Record<string, unknown> }[] = []
  const helper = new Proxy(
    {},
    {
      get: (_t, method: string) => async (args: Record<string, unknown>) => {
        calls.push({ method, args })
        return []
      },
    },
  )
  const client = { serverTimezone, register: () => helper }
  const pool = { get: async () => ({ client }) as unknown as PoolEntry } as unknown as ReadPool
  registerDataTools(server, pool, DEFAULT_LIMITS)
  const run = (args: Record<string, unknown>) => {
    if (handler === undefined) throw new Error('register_query not registered')
    return handler({ connection: 'c', register: 'AccumulationRegister_X', ...args })
  }
  return { run, calls }
}

const iso = (d: unknown) => (d as Date).toISOString()

describe('register_query periods in the connection serverTimezone (#182)', () => {
  it('reads a naive date-time as server time', async () => {
    const { run, calls } = setup('Europe/Moscow')
    await run({ table: 'turnovers', periodFrom: '2026-01-01T00:00:00', periodTo: '2026-01-31 23:59:59' })
    const period = calls[0]?.args.Period as { from: Date; to: Date }
    expect(iso(period.from)).toBe('2025-12-31T21:00:00.000Z')
    expect(iso(period.to)).toBe('2026-01-31T20:59:59.000Z')
  })

  it('reads a bare periodFrom/periodTo as the whole server days (January = 01-01 .. 01-31)', async () => {
    const { run, calls } = setup('Europe/Moscow')
    await run({ table: 'turnovers', periodFrom: '2026-01-01', periodTo: '2026-01-31' })
    const period = calls[0]?.args.Period as { from: Date; to: Date }
    expect(iso(period.from)).toBe('2025-12-31T21:00:00.000Z') // 01-01 00:00:00 MSK
    expect(iso(period.to)).toBe('2026-01-31T20:59:59.000Z') // 01-31 23:59:59 MSK
  })

  it('takes the same bare day as periodFrom and periodTo to be that whole day', async () => {
    const { run, calls } = setup('Europe/Moscow')
    await run({ table: 'drCrTurnovers', periodFrom: '2026-03-15', periodTo: '2026-03-15' })
    const period = calls[0]?.args.Period as { from: Date; to: Date }
    expect(iso(period.from)).toBe('2026-03-14T21:00:00.000Z')
    expect(iso(period.to)).toBe('2026-03-15T20:59:59.000Z')
  })

  it('starts a bare day whose midnight a DST switch skips at its first real moment', async () => {
    const { run, calls } = setup('America/Sao_Paulo')
    await run({ table: 'turnovers', periodFrom: '2018-11-04' })
    // 2018-11-04 01:00 -02:00 — never the previous evening.
    expect(iso((calls[0]?.args.Period as { from: Date } | undefined)?.from)).toBe('2018-11-04T03:00:00.000Z')
  })

  it('keeps a naive periodTo date-time as given', async () => {
    const { run, calls } = setup('Europe/Moscow')
    await run({ table: 'turnovers', periodTo: '2026-01-31T12:00' })
    const period = calls[0]?.args.Period as { to: Date }
    expect(iso(period.to)).toBe('2026-01-31T09:00:00.000Z')
  })

  it('reads a bare period (a point) as the start of the server day (no longer UTC midnight)', async () => {
    const { run, calls } = setup('Europe/Moscow')
    await run({ table: 'balance', period: '2026-01-01' })
    expect(iso(calls[0]?.args.Period)).toBe('2025-12-31T21:00:00.000Z')
  })

  it('follows the zone of the connection, DST included', async () => {
    const { run, calls } = setup('America/New_York')
    await run({ table: 'sliceLast', period: '2026-07-01T12:30' })
    expect(iso(calls[0]?.args.Period)).toBe('2026-07-01T16:30:00.000Z')
  })

  it('keeps an explicit Z or offset as that instant', async () => {
    const { run, calls } = setup('Europe/Moscow')
    await run({ table: 'turnovers', periodFrom: '2026-01-01T00:00:00Z', periodTo: '2026-01-31T23:59:59+0500' })
    const period = calls[0]?.args.Period as { from: Date; to: Date }
    expect(iso(period.from)).toBe('2026-01-01T00:00:00.000Z')
    expect(iso(period.to)).toBe('2026-01-31T18:59:59.000Z')
  })

  it('keeps milliseconds of a naive date-time', async () => {
    const { run, calls } = setup('Europe/Moscow')
    await run({ table: 'balance', period: '2026-01-01T10:00:00.250' })
    expect(iso(calls[0]?.args.Period)).toBe('2026-01-01T07:00:00.250Z')
  })

  it('accepts the 1С empty-date year range (years below 100 are not shifted to 19xx)', async () => {
    const { run, calls } = setup('UTC')
    await run({ table: 'balance', period: '0050-06-01T00:00:00Z' })
    expect(iso(calls[0]?.args.Period)).toBe('0050-06-01T00:00:00.000Z')
  })

  it('reads a naive year below 1000 as server time (#193)', async () => {
    const { run, calls } = setup('Europe/Moscow')
    await run({ table: 'balance', period: '0999-05-01T00:00:00' })
    // Moscow local mean time then: +02:30:17.
    expect(iso(calls[0]?.args.Period)).toBe('0999-04-30T21:29:43.000Z')
  })

  it.each([
    ['Europe/Berlin', '2025-10-26T02:30', '2025-10-26T00:30:00.000Z'],
    ['America/Sao_Paulo', '2019-02-16T23:30', '2019-02-17T01:30:00.000Z'],
  ])('reads a %s time the clocks pass twice as the earlier instant (#193)', async (zone, value, expected) => {
    const { run, calls } = setup(zone)
    await run({ table: 'balance', period: value })
    expect(iso(calls[0]?.args.Period)).toBe(expected)
  })

  it.each([
    [
      'a daylight-saving gap',
      'America/New_York',
      '2026-03-08T02:30',
      'daylight-saving switch skips in America/New_York',
    ],
    ['an offset Date cannot represent', 'Europe/Moscow', '2026-01-01T00:00:00+24:00', 'an impossible offset'],
    ['the naive year 0000, outside 1С dates', 'UTC', '0000-06-01T00:00:00', 'the year 0000'],
  ])('rejects %s with a clear message', async (_name, zone, value, why) => {
    const { run, calls } = setup(zone)
    const res = await run({ table: 'balance', period: value })
    expect(res.isError).toBe(true)
    expect((res.content[0] as { text: string }).text).toContain(why)
    expect(calls).toHaveLength(0)
  })

  it.each(['2026-02-30', '2026-13-01', '2026-01-01T24:00', '2026-01-01T10:60', '2026/01/01', '2026-1-1', 'yesterday'])(
    'rejects %s instead of rolling it over',
    async (value) => {
      const { run, calls } = setup('Europe/Moscow')
      const res = await run({ table: 'balance', period: value })
      expect(res.isError).toBe(true)
      expect((res.content[0] as { text: string }).text).toContain(`Invalid ISO date: "${value}"`)
      expect((res.content[0] as { text: string }).text).toContain('Europe/Moscow')
      expect(calls).toHaveLength(0)
    },
  )
})
