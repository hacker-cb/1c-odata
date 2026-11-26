/**
 * The longest delay `setTimeout` keeps: past it — `Infinity` included — Node
 * fires after 1 ms (with a `TimeoutOverflowWarning`).
 */
export const MAX_TIMER_MS = 2 ** 31 - 1

/**
 * `ms` as a `setTimeout` delay: capped at {@link MAX_TIMER_MS} (about 24.8
 * days), so a delay meant as "practically unbounded" never turns into an
 * immediate one. Shared by the request timeout (`http/transport.ts`) and the
 * retry pause (`http/retry.ts`).
 */
export function timerDelay(ms: number): number {
  return Math.min(ms, MAX_TIMER_MS)
}
