import { describe, expect, it } from 'vitest'
import { InvalidArgumentError } from '../../src/errors.js'
import { toFilterString } from '../../src/filter.js'
import { buildKeyFilter, chunkKeyValues, dedupeKeys, type KeyValue, mapBounded } from '../../src/query/batch.js'

const TZ = 'Europe/Moscow'
const guid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`

describe('dedupeKeys', () => {
  it('removes duplicates preserving first-seen order', () => {
    expect(dedupeKeys(['b', 'a', 'b', 'c', 'a'])).toEqual(['b', 'a', 'c'])
  })
  it('keeps distinct number vs bigint entries', () => {
    expect(dedupeKeys<KeyValue>([1, 1, 2])).toEqual([1, 2])
  })
})

describe('chunkKeyValues — fixed batchSize', () => {
  it('splits N keys into ceil(N / batchSize) batches', () => {
    const values = Array.from({ length: 23 }, (_, i) => guid(i))
    const batches = chunkKeyValues('Ref_Key', values, TZ, { batchSize: 5 })
    expect(batches.map((b) => b.length)).toEqual([5, 5, 5, 5, 3])
    expect(batches.flat()).toEqual(values) // order preserved, nothing dropped
  })

  it('one batch when batchSize >= N', () => {
    expect(chunkKeyValues('Ref_Key', [guid(1), guid(2)], TZ, { batchSize: 10 })).toHaveLength(1)
  })

  it('rejects a non-positive batchSize', () => {
    expect(() => chunkKeyValues('Ref_Key', [guid(1)], TZ, { batchSize: 0 })).toThrow(InvalidArgumentError)
    expect(() => chunkKeyValues('Ref_Key', [guid(1)], TZ, { batchSize: 1.5 })).toThrow(InvalidArgumentError)
  })

  it('returns [] for empty input', () => {
    expect(chunkKeyValues('Ref_Key', [], TZ, { batchSize: 5 })).toEqual([])
  })
})

describe('chunkKeyValues — query-string budget', () => {
  const values = Array.from({ length: 24 }, (_, i) => guid(i))

  it('packs multiple keys per batch under a generous budget, recovering all keys', () => {
    const batches = chunkKeyValues('Ref_Key', values, TZ, { filterBudget: 1500 })
    expect(batches.length).toBeGreaterThan(1)
    expect(batches.flat()).toEqual(values)
    expect(batches.every((b) => b.length > 0)).toBe(true)
    // Each batch's encoded OR-chain stays within budget (single-key batches exempt).
    for (const b of batches) {
      const encoded = encodeURIComponent(toFilterString(buildKeyFilter(undefined, 'Ref_Key', b, TZ)))
      if (b.length > 1) expect(encoded.length).toBeLessThanOrEqual(1500)
    }
  })

  it('a tiny budget forces one key per batch (never splits a key)', () => {
    const batches = chunkKeyValues('Ref_Key', values, TZ, { filterBudget: 1 })
    expect(batches).toHaveLength(24)
    expect(batches.every((b) => b.length === 1)).toBe(true)
  })

  it('a huge budget yields a single batch', () => {
    expect(chunkKeyValues('Ref_Key', values, TZ, { filterBudget: 100_000 })).toHaveLength(1)
  })
})

describe('buildKeyFilter', () => {
  it('emits guid literals for GUID-shaped values and ORs them', () => {
    const expr = toFilterString(buildKeyFilter(undefined, 'Ref_Key', [guid(1), guid(2)], TZ))
    expect(expr).toBe(`(Ref_Key eq guid'${guid(1)}') or (Ref_Key eq guid'${guid(2)}')`)
  })

  it('a single value produces no OR wrapper', () => {
    expect(toFilterString(buildKeyFilter(undefined, 'Ref_Key', [guid(1)], TZ))).toBe(`Ref_Key eq guid'${guid(1)}'`)
  })

  it('non-guid string / number values use ordinary literals', () => {
    expect(toFilterString(buildKeyFilter(undefined, 'Code', ['001'], TZ))).toBe("Code eq '001'")
    expect(toFilterString(buildKeyFilter(undefined, 'Number', [42], TZ))).toBe('Number eq 42')
  })

  it('AND-combines with an existing filter, parenthesising the OR-chain', () => {
    const existing = buildKeyFilter(undefined, 'DeletionMark', ['x'], TZ) // reuse as a stand-in expr
    const expr = toFilterString(buildKeyFilter(existing, 'Ref_Key', [guid(1), guid(2)], TZ))
    expect(expr).toBe(`DeletionMark eq 'x' and ((Ref_Key eq guid'${guid(1)}') or (Ref_Key eq guid'${guid(2)}'))`)
  })
})

describe('mapBounded', () => {
  it('preserves input order in the result array', async () => {
    const out = await mapBounded([10, 20, 30], 2, async (x) => x * 2)
    expect(out).toEqual([20, 40, 60])
  })

  it('never exceeds the concurrency limit', async () => {
    let active = 0
    let peak = 0
    const items = Array.from({ length: 12 }, (_, i) => i)
    await mapBounded(items, 3, async (x) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
      return x
    })
    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBeGreaterThan(1) // actually ran concurrently
  })

  it('handles empty input', async () => {
    expect(await mapBounded([], 4, async (x) => x)).toEqual([])
  })

  it('treats a non-finite limit as 1 worker (never silently drops all work)', async () => {
    // A NaN limit must not yield Array.from({length: NaN}) → zero workers → []
    const out = await mapBounded([1, 2, 3], Number.NaN, async (x) => x * 10)
    expect(out).toEqual([10, 20, 30])
  })
})
