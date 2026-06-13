/**
 * Run `fn` over `items` with at most `limit` invocations in flight at once.
 *
 * Workers share one array iterator, so each pulls the next item as it frees up
 * — no manual index bookkeeping, no double-processing, no skipped items
 * (`iterator.next()` is synchronous, so concurrent workers never pull the same
 * tuple). `fn` receives each item's original index.
 *
 * Error policy is `Promise.all`-style: the returned promise rejects as soon as
 * the first `fn` call rejects, while the other in-flight workers keep running
 * to completion (their later settlements — including rejections — are observed
 * by `Promise.all` and discarded, not left unhandled). Callers that need every
 * item attempted regardless of failures should catch inside `fn` and surface
 * the errors themselves.
 *
 * @throws if `limit` is not a positive integer — a non-positive or `NaN`
 * `limit` would otherwise spawn zero workers and silently process nothing.
 */
export async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`mapWithConcurrency: limit must be a positive integer, got ${limit}`)
  }
  const iterator = items.entries()
  async function worker(): Promise<void> {
    for (const [index, item] of iterator) {
      await fn(item, index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
}
