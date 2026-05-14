// packages/client/src/client/v3-functions-proxy.ts

import { buildFunctionUrl } from '../functions.js'
import { parseOptsFor, parseV3Collection } from '../parser.js'
import type { ODataV3Client } from './v3-client.js'

/**
 * Build the two-level Proxy that backs `client.functions.<EntitySet>.<Func>(args)`.
 *
 * Heuristic: if `args.ref` is present → POST `<set>(<ref>)/<func>()` (write FI,
 * returns `undefined`). Otherwise → GET `<set>/<func>()` (read FI, returns
 * `parsed.value` — the array form of the wrapped `{ value: [...] }` body;
 * scalar-returning read FIs are out of scope, see the inline note below).
 * This matches the 12 canonical FIs: Post / Unpost / Start / ExecuteTask are
 * instance-bound writes (need `ref`), Balance / Turnovers / SliceLast / etc.
 * are set-bound reads (no `ref`).
 *
 * Both Proxy levels intercept `then` and return `undefined` so `await client.functions.X`
 * does not turn into a fake call to `<base>/<set>/then()` from JS' implicit thenable probe.
 */
export function createFunctionsProxy(client: ODataV3Client<unknown>): unknown {
  return new Proxy(
    {},
    {
      get(_target, entitySet) {
        if (typeof entitySet !== 'string') return undefined
        // NOT thenable — prevents `await client.functions.X` from triggering
        // a `then`-probe that would build a fake `<set>(...)` Proxy and (in
        // the inner trap) issue a real HTTP call to `<base>/<set>/then()`.
        if (entitySet === 'then') return undefined
        return new Proxy(
          {},
          {
            get(_innerTarget, funcName) {
              if (typeof funcName !== 'string') return undefined
              // Same defence at the inner level: `await client.functions.X.Y`
              // (or any await on the dispatch result before it's invoked)
              // probes `.then` and would otherwise yield a callable, leading
              // JS to call `then(resolve, reject)` and dispatch a GET to
              // `<base>/<set>/then()` that never resolves.
              if (funcName === 'then') return undefined
              return async (rawArgs: Record<string, unknown> = {}) => {
                const { ref, ...rest } = rawArgs as { ref?: string; [k: string]: unknown }
                const url = buildFunctionUrl(
                  client.baseUrl,
                  entitySet,
                  funcName,
                  ref !== undefined ? { ref } : {},
                  rest,
                  client.serverTimezone,
                )
                // Heuristic: ref present → POST (write FI); absent → GET (read FI).
                if (ref !== undefined) {
                  await client.transportPost(url, undefined, {}, entitySet)
                  return undefined
                }
                const raw = await client.transportGet(url, {})
                // Route through `parseV3Collection` so Edm.DateTime strings
                // become `Date` instances and the 1С `0001-01-01T00:00:00`
                // empty-date sentinel becomes `null`. All 12 canonical read
                // FIs (Balance, Turnovers, SliceLast, …) return collections
                // wrapped in `{ value: [...] }`. Scalar-returning read FIs
                // are out of scope here — a follow-up may add a separate path.
                // typeHint omitted: virtual-table FI results differ from entity shape.
                const parsed = parseV3Collection<unknown>(raw.body, parseOptsFor(client, entitySet, false))
                return parsed.value
              }
            },
          },
        )
      },
    },
  )
}
