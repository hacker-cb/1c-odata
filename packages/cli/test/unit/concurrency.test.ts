import { describe, expect, it } from 'vitest'
import { mapWithConcurrency } from '../../src/concurrency.js'

describe('mapWithConcurrency', () => {
  it('processes every item and passes its original index', async () => {
    const seen: [string, number][] = []
    await mapWithConcurrency(['a', 'b', 'c'], 2, async (item, index) => {
      seen.push([item, index])
    })
    expect([...seen].sort()).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ])
  })

  it('never exceeds the concurrency limit in flight', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const items = Array.from({ length: 10 }, (_, i) => i)
    await mapWithConcurrency(items, 3, async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
    })
    expect(maxInFlight).toBeLessThanOrEqual(3)
    expect(maxInFlight).toBeGreaterThan(1) // proves work actually overlapped
  })

  it('is a no-op for an empty list (never calls fn)', async () => {
    let called = false
    await mapWithConcurrency([], 4, async () => {
      called = true
    })
    expect(called).toBe(false)
  })

  it('rejects (Promise.all-style) when fn rejects', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
  })

  it('throws when limit is not a positive integer', async () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(mapWithConcurrency([1], bad, async () => {})).rejects.toThrow(/positive integer/)
    }
  })
})
