import { InvalidArgumentError } from './errors.js'

/**
 * Format a finite JS `number` as an OData V3 numeric literal. Throws
 * `InvalidArgumentError` for `NaN`, `+Infinity`, and `-Infinity` — none of
 * these have OData V3 wire representations, and passing them through silently
 * produces invalid query strings that 1С either rejects with HTTP 400 or
 * (worse) returns spurious results for.
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
  return String(v)
}
