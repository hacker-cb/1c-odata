// packages/client/src/query/batch.ts
//
// Batched lookup-by-key support shared by `.whereIn()` (filter sugar) and
// `.getByKeys()` (chunking terminal). Kept in one small, dependency-light module
// so the chunking math and the bounded-concurrency runner are unit-testable in
// isolation, without an HTTP round-trip.

import { and, or, raw } from '../filter.js'
import { type FilterExpression, formatKeyLiteral } from './filter-internal.js'
import { assertPositiveInt } from './validate.js'

/** A value usable as a lookup key: GUID/string, number, or Int64 bigint. */
export type KeyValue = string | number | bigint

/**
 * Default total query-string byte budget for one batched request. Conservative:
 * well under the IIS `maxQueryString` default of 2048 bytes, so `$select` /
 * `$expand` / `$orderby` / `$format` fit in the remaining headroom. The single
 * source of truth for the budget — `getByKeys` subtracts the fixed query parts
 * from this to size each batch's key filter.
 */
export const DEFAULT_QUERY_BUDGET = 1500

/** URL-encoded length of the ` or ` term separator. */
const OR_SEPARATOR_LEN = encodeURIComponent(' or ').length

export interface ChunkOptions {
  /**
   * Force a fixed maximum number of keys per batch. Overrides the length-budget
   * estimation entirely — deterministic batch count of `ceil(n / batchSize)`.
   */
  batchSize?: number
  /**
   * URL-encoded byte budget for the OR-chain `$filter` value. Defaults to
   * `DEFAULT_QUERY_BUDGET`. Ignored when `batchSize` is set.
   */
  filterBudget?: number
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
 * Split key values into batches that each fit within the query-string budget.
 *
 * Two modes:
 *  - `batchSize` set → fixed chunks of that size (deterministic count).
 *  - otherwise → greedily pack `field eq <lit>` terms (measured URL-encoded,
 *    plus ` or ` separators) until adding the next would exceed `filterBudget`.
 *
 * A single term that alone exceeds the budget still gets its own batch — a key
 * is never split. Returns `[]` for empty input.
 *
 * @internal
 */
export function chunkKeyValues(
  field: string,
  values: readonly KeyValue[],
  serverTimezone: string,
  opts: ChunkOptions = {},
): KeyValue[][] {
  if (values.length === 0) return []

  if (opts.batchSize !== undefined) {
    assertPositiveInt(opts.batchSize, 'getByKeys({ batchSize })')
    const size = opts.batchSize
    const out: KeyValue[][] = []
    for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size))
    return out
  }

  const budget = opts.filterBudget ?? DEFAULT_QUERY_BUDGET
  const out: KeyValue[][] = []
  let current: KeyValue[] = []
  let currentLen = 0
  for (const v of values) {
    // Match `buildKeyFilter`'s wire output: `or()` wraps each term in parens, so
    // estimate the parenthesised, URL-encoded length. (Over-counts a lone term
    // by the 2 parens `or()` omits for length 1 — safely conservative.)
    const termLen = encodeURIComponent(`(${field} eq ${formatKeyLiteral(v, serverTimezone)})`).length
    const addLen = current.length === 0 ? termLen : OR_SEPARATOR_LEN + termLen
    if (current.length > 0 && currentLen + addLen > budget) {
      out.push(current)
      current = [v]
      currentLen = termLen
      continue
    }
    current.push(v)
    currentLen += addLen
  }
  if (current.length > 0) out.push(current)
  return out
}

/**
 * Run `fn` over `items` with at most `limit` concurrent invocations, preserving
 * input order in the result array. `limit` is clamped to `[1, items.length]`; a
 * non-finite or fractional `limit` is floored to a safe `1` (so a stray `NaN`
 * never silently starts zero workers and drops all the work).
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
