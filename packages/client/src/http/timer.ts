/**
 * The longest delay `setTimeout` keeps: past it — `Infinity` included — Node
 * fires after 1 ms (with a `TimeoutOverflowWarning`).
 */
export const MAX_TIMER_MS = 2 ** 31 - 1

/**
 * `ms` as a `setTimeout` delay: capped at {@link MAX_TIMER_MS} (about 24.8
 * days), so a delay meant as "practically unbounded" does not fire at once for
 * being too large. Only the cap: a negative or `NaN` delay passes through as
 * given (`setTimeout` fires it after 1 ms) — the caller decides what those mean.
 * Shared by the request timeout (`http/transport.ts`) and the retry pause
 * (`http/retry.ts`).
 */
export function timerDelay(ms: number): number {
  return Math.min(ms, MAX_TIMER_MS)
}
