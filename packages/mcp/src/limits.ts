/** Default page size for `query`/`list_entities` when the caller omits `top`. */
export const DEFAULT_TOP = 50

/** Hard cap on a single page — guards against dumping a whole table into context. */
export const MAX_TOP = 1000

/**
 * Clamp a caller-supplied `top` into `[1, MAX_TOP]`, defaulting when absent or
 * invalid. Keeps tool responses bounded regardless of what the LLM requests.
 */
export function clampTop(top: number | undefined): number {
  if (top === undefined || !Number.isInteger(top) || top < 1) return DEFAULT_TOP
  return Math.min(top, MAX_TOP)
}
