// packages/client/src/query/batch.ts
//
// Batched lookup-by-key support shared by `.whereIn()` (filter sugar) and
// `.getByKeys()` (chunking terminal). Kept in one small, dependency-light module
// so the chunking algorithm and the bounded-concurrency runner are unit-testable
// in isolation, without an HTTP round-trip.

import { and, or, raw } from '../filter.js'
import { type FilterExpression, formatKeyLiteral } from './filter-internal.js'
import { assertPositiveInt } from './validate.js'

/** A value usable as a lookup key: GUID/string, number, or Int64 bigint. */
export type KeyValue = string | number | bigint

/**
 * Values accepted for key field `K` of entity `T` by `whereIn` / `getByKeys`:
 * the field's own type, except any `string` subtype (e.g. a branded `Guid`) is
 * widened back to plain `string` so callers can pass ordinary string GUIDs.
 * Non-key field types and untyped builders fall back to `KeyValue`. The effect:
 * `whereIn('Code', [42])` is a compile error when `Code` is a string field,
 * while `getByKeys('Ref_Key', stringGuids)` still type-checks.
 */
export type KeyValueFor<T, K extends keyof T> = T[K] extends string ? string : T[K] extends KeyValue ? T[K] : KeyValue

export interface ChunkOptions {
  /**
   * Force a fixed maximum number of keys per batch. Deterministic batch count of
   * `ceil(n / batchSize)`. Takes precedence over `fits`.
   */
  batchSize?: number
  /**
   * Greedy fit predicate: returns whether a candidate batch is acceptable (e.g.
   * its rendered request URL is within budget). A batch grows until adding the
   * next key would make `fits` false. The caller owns the actual measurement, so
   * `chunkKeyValues` stays free of URL/encoding knowledge. With neither
   * `batchSize` nor `fits`, everything lands in a single batch.
   */
  fits?: (batch: readonly KeyValue[]) => boolean
}

/** Remove duplicate keys, preserving first-seen order. */
export function dedupeKeys<V>(values: readonly V[]): V[] {
  const seen = new Set<V>()
  const out: V[] = []
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v)
      out.push(v)
    }
  }
  return out
}

/**
 * Compile the lookup filter for one batch: a GUID-aware `field eq <lit> or …`
 * chain, AND-combined with any pre-existing builder filter (so an upstream
 * `.filter(f => …)` is honoured on every batch). `values` MUST be non-empty.
 *
 * @internal
 */
export function buildKeyFilter(
  existing: FilterExpression | undefined,
  field: string,
  values: readonly KeyValue[],
  serverTimezone: string,
): FilterExpression {
  const terms = values.map((v) => raw(`${field} eq ${formatKeyLiteral(v, serverTimezone)}`))
  const keyOr = or(...terms)
  return existing ? and(existing, keyOr) : keyOr
}

/**
 * Split key values into batches. Two modes:
 *  - `batchSize` set → fixed chunks of that size (deterministic count).
 *  - `fits` set → greedily grow a batch until adding the next key would make
 *    `fits` false, then start a new one.
 *
 * A key is never split: the first key of a batch always goes in, even if it
 * alone fails `fits` (the caller surfaces that as an error, since chunking
 * cannot help). Returns `[]` for empty input.
 *
 * @internal
 */
export function chunkKeyValues(values: readonly KeyValue[], opts: ChunkOptions = {}): KeyValue[][] {
  if (values.length === 0) return []

  if (opts.batchSize !== undefined) {
    assertPositiveInt(opts.batchSize, 'getByKeys({ batchSize })')
    const size = opts.batchSize
    const out: KeyValue[][] = []
    for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size))
    return out
  }

  const fits = opts.fits
  const out: KeyValue[][] = []
  let current: KeyValue[] = []
  for (const v of values) {
    // Push then test-and-rollback, so the candidate is the live array (no
    // per-step `[...current, v]` copy → no O(n²) allocation / GC churn). `fits`
    // reads the array synchronously and must not retain it (the measurer copies).
    current.push(v)
    if (current.length > 1 && fits && !fits(current)) {
      current.pop()
      out.push(current)
      current = [v]
    }
  }
  if (current.length > 0) out.push(current)
  return out
}

/**
 * Run `fn` over `items` with at most `limit` concurrent invocations, preserving
 * input order in the result array. `limit` is floored to an integer (`2.9` → `2`)
 * and clamped to `[1, items.length]`; a non-finite `limit` (e.g. `NaN` from
 * `Number(undefined)`) is treated as `1`, so it never silently starts zero
 * workers and drops all the work.
 *
 * @internal
 */
export async function mapBounded<I, O>(
  items: readonly I[],
  limit: number,
  fn: (item: I, index: number) => Promise<O>,
): Promise<O[]> {
  const results = new Array<O>(items.length)
  let next = 0
  const safeLimit = Number.isFinite(limit) ? Math.floor(limit) : 1
  const workerCount = Math.max(1, Math.min(safeLimit, items.length))
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i] as I, i)
    }
  }
  await Promise.all(Array.from({ length: workerCount }, worker))
  return results
}
