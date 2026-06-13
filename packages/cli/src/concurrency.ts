/**
 * Run `fn` over `items` with at most `limit` invocations in flight at once.
 *
 * Workers share one array iterator, so each pulls the next item as it frees up
 * — no manual index bookkeeping, no double-processing, no skipped items
 * (`iterator.next()` is synchronous, so concurrent workers never pull the same
 * tuple). `fn` receives each item's original index.
 *
 * Error policy is `Promise.all`-style: if `fn` rejects, the rejection
 * propagates and items already picked up by other workers still run to
 * completion (a late sibling rejection would be unhandled). Callers that need
 * every item attempted regardless of failures should catch inside `fn` and
 * surface errors themselves.
 */
export async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const iterator = items.entries()
  async function worker(): Promise<void> {
    for (const [index, item] of iterator) {
      await fn(item, index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
}
