import { describe, expect, it } from 'vitest'
import { toolResult } from '../../src/tools/_result.js'

const text = (r: Awaited<ReturnType<typeof toolResult>>): string => (r.content[0] as { text: string }).text

describe('toolResult', () => {
  it('serializes bigint values (int64Mode: "bigint") without throwing', async () => {
    const r = await toolResult(async () => ({
      summary: 'ok',
      data: { lineNumber: 123n, nested: [{ big: 9007199254740993n }] },
    }))
    expect(r.isError).toBeUndefined()
    expect(r.structuredContent).toEqual({ lineNumber: '123', nested: [{ big: '9007199254740993' }] })
    expect(text(r)).toContain('"lineNumber": "123"')
  })

  it('serializes Date values as ISO strings', async () => {
    const r = await toolResult(async () => ({ summary: 'ok', data: { when: new Date('2024-01-02T03:04:05.000Z') } }))
    expect(r.structuredContent).toEqual({ when: '2024-01-02T03:04:05.000Z' })
  })

  it('returns a redacted isError result when the body throws', async () => {
    const r = await toolResult(async () => {
      throw new Error('connect http://u:pw@host failed')
    })
    expect(r.isError).toBe(true)
    expect(text(r)).toBe('connect http://***@host failed')
  })
})
