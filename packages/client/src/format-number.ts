import { InvalidArgumentError } from './errors.js'

/**
 * Expand JavaScript exponential notation (`1e-7`, `1e+21`) into a plain decimal
 * string. `String(number)` switches to exponential for magnitudes `< 1e-6` or
 * `>= 1e21`, but OData V3's numeric-literal grammar has no exponential form —
 * `1e-7` in a `$filter` is rejected (HTTP 400) or silently mismatches. The
 * expansion is exact (a textual digit shift, no re-parse) and locale-free.
 */
function expandExponential(s: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(s)
  if (m === null) return s
  const sign = m[1] ?? ''
  const intPart = m[2] ?? '0'
  const fracPart = m[3] ?? ''
  const exp = Number(m[4] ?? '0')
  const digits = intPart + fracPart
  // Decimal point currently sits after `intPart.length` digits; shift by `exp`.
  const pointPos = intPart.length + exp
  let out: string
  if (pointPos <= 0) {
    out = `0.${'0'.repeat(-pointPos)}${digits}`
  } else if (pointPos >= digits.length) {
    out = digits + '0'.repeat(pointPos - digits.length)
  } else {
    out = `${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`
  }
  if (out.includes('.')) out = out.replace(/0+$/, '').replace(/\.$/, '')
  return sign + out
}

/**
 * Format a finite JS `number` as an OData V3 numeric literal. Throws
 * `InvalidArgumentError` for `NaN`, `+Infinity`, and `-Infinity` — none of
 * these have OData V3 wire representations, and passing them through silently
 * produces invalid query strings that 1С either rejects with HTTP 400 or
 * (worse) returns spurious results for.
 *
 * Values JavaScript would render in exponential notation (`1e-7`, `1e21`) are
 * expanded to a plain decimal string — OData V3 has no exponential literal.
 *
 * `argument` names the caller-visible parameter (e.g. the filter field name
 * or FunctionImport arg key) so the thrown error points at the offending
 * input.
 *
 * @internal — used by `query/filter-internal.ts` and `functions.ts`. Not part
 * of the public surface.
 */
export function formatNumberLiteral(v: number, argument: string): string {
  if (!Number.isFinite(v)) {
    throw new InvalidArgumentError(`Numeric literal for "${argument}" must be a finite number; received ${String(v)}`, {
      argument,
      received: v,
    })
  }
  const s = String(v)
  return s.includes('e') || s.includes('E') ? expandExponential(s) : s
}
