/**
 * Tunable response limits, resolved once from the environment at server start
 * and threaded into the read tools. Keeps tool responses bounded regardless of
 * what the LLM requests.
 */
export interface Limits {
  /** Page size when the caller omits `top`. */
  defaultTop: number
  /** Hard ceiling on a single page's `top`. */
  maxTop: number
  /** Byte budget (UTF-8) for a result's row array; rows beyond it are truncated. */
  maxBytes: number
  /** Safety cap on rows fetched from a register virtual-table FI ($top) before client-side paging. */
  maxRegisterRows: number
}

/** Built-in defaults; each is overridable via an `ONEC_MCP_*` env var (see {@link resolveLimits}). */
export const DEFAULT_LIMITS: Limits = { defaultTop: 50, maxTop: 1000, maxBytes: 24_000, maxRegisterRows: 100_000 }

function intEnv(raw: string | undefined, fallback: number, min: number): number {
  // Strict decimal only — reject hex ("0x10"), exponential ("1e9"), floats and
  // blanks so a typo can't silently raise a cap to an unintended value.
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return fallback
  const n = Number(raw.trim())
  return Number.isInteger(n) && n >= min ? n : fallback
}

/**
 * Resolve {@link Limits} from the environment, falling back to
 * {@link DEFAULT_LIMITS} for unset/invalid values:
 * - `ONEC_MCP_DEFAULT_TOP` — default page size (≥ 1)
 * - `ONEC_MCP_MAX_TOP` — page-size ceiling (≥ 1)
 * - `ONEC_MCP_MAX_BYTES` — per-result row-array byte budget (≥ 1024)
 * - `ONEC_MCP_MAX_REGISTER_ROWS` — cap on rows fetched from a register FI (≥ 1)
 *
 * `defaultTop` is clamped to `maxTop` so a misconfiguration can't exceed the cap.
 */
export function resolveLimits(env: NodeJS.ProcessEnv = process.env): Limits {
  const maxTop = intEnv(env.ONEC_MCP_MAX_TOP, DEFAULT_LIMITS.maxTop, 1)
  const defaultTop = Math.min(intEnv(env.ONEC_MCP_DEFAULT_TOP, DEFAULT_LIMITS.defaultTop, 1), maxTop)
  const maxBytes = intEnv(env.ONEC_MCP_MAX_BYTES, DEFAULT_LIMITS.maxBytes, 1024)
  const maxRegisterRows = intEnv(env.ONEC_MCP_MAX_REGISTER_ROWS, DEFAULT_LIMITS.maxRegisterRows, 1)
  return { defaultTop, maxTop, maxBytes, maxRegisterRows }
}

/**
 * Clamp a caller-supplied `top` into `[1, limits.maxTop]`, defaulting to
 * `limits.defaultTop` when absent or invalid (non-integer / < 1).
 */
export function clampTop(top: number | undefined, limits: Limits): number {
  if (top === undefined || !Number.isInteger(top) || top < 1) return limits.defaultTop
  return Math.min(top, limits.maxTop)
}
