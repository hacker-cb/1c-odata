// packages/client/src/query/validate.ts
//
// Shared integer-precondition guards. A dependency-free leaf (imports only
// `errors.js`) so every layer — builder setters, register FIs, the query
// terminals, and the batching helpers — validates with ONE implementation and
// one message format, without import cycles.

import { InvalidArgumentError } from '../errors.js'

/**
 * Validate a non-negative integer setter argument. Throws `InvalidArgumentError`
 * with a clear message that names the parameter and shows the rejected value.
 *
 * Used by `.top()` / `.skip()` setters and `ReadFiOptions.top`.
 *
 * @internal
 */
export function assertNonNegativeInt(value: number, paramName: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new InvalidArgumentError(`Invalid ${paramName}: must be a non-negative integer`, {
      argument: paramName,
      received: value,
    })
  }
}

/**
 * Validate a positive integer (>=1) argument. Same shape as
 * `assertNonNegativeInt` but rejects 0 too. Also rejects `NaN` (e.g. from
 * `Number(process.env.X)` when unset), which would otherwise silently degrade
 * to "no work" in count-driven loops.
 *
 * Used by `stream({ pageSize })` and `getByKeys({ batchSize, concurrency })`.
 *
 * @internal
 */
export function assertPositiveInt(value: number, paramName: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new InvalidArgumentError(`Invalid ${paramName}: must be a positive integer`, {
      argument: paramName,
      received: value,
    })
  }
}
