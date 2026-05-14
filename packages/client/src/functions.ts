// packages/client/src/functions.ts
import { InvalidArgumentError } from './errors.js'
import { formatInZone } from './timezone.js'

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Empty placeholder type — used as the default `TFunctions` for `ODataV3Client`
 * when the user doesn't supply the codegen-emitted `Functions` interface.
 *
 * See spec §4.5: `client.functions.<EntitySet>.<Func>(args)`. With this default
 * the runtime accepts any property access (untyped); with a real `Functions`
 * type from `@1c-odata/cli/codegen`, the call sites become fully typed.
 */
export interface ODataV3FunctionsBase {
  // Allow any string -> any object -> any function — runtime Proxy handles dispatch.
  [entitySet: string]: { [method: string]: (args: Record<string, unknown>) => Promise<unknown> }
}

/**
 * Wrap the codegen-emitted `Functions` interface to add `ref: string` to args
 * of any method returning `Promise<void>` — the heuristic for instance-bound
 * write FIs (Post / Unpost / Start / ExecuteTask). Read FIs (Balance /
 * Turnovers / SliceLast / etc.) return `Promise<T[]>` and are left untouched.
 */
export type WithInstanceRef<TFunctions> = {
  [TSet in keyof TFunctions]: {
    [TMethod in keyof TFunctions[TSet]]: TFunctions[TSet][TMethod] extends (args: infer A) => Promise<void>
      ? (args: A & { ref: string }) => Promise<void>
      : TFunctions[TSet][TMethod]
  }
}

/**
 * Serialize FI args as OData V3 query-string. Ignores `undefined`, formats
 * `Date` using `formatInZone` with the server's IANA timezone (1С naive datetime
 * — server interprets the literal in its own zone), strings get single-quote
 * quoting with `''` escape, `null` becomes the literal string `null`, and
 * booleans / numbers pass through.
 *
 * Both keys and values are URL-encoded after OData literal formatting via
 * `encodeURIComponent`. This matters for query-component reserved chars that
 * `encodeURIComponent` does percent-encode (`@`, `:`, `&`, `?`, `#`, space,
 * `%`, `+`, `=`) — e.g. `@` in keys like `AccountDr@odata.bind`, `:` in
 * datetime literals (`datetime'2025-01-15T10:30:00'` → `...T10%3A30%3A00...`),
 * `&`/`?`/`#`/space inside arbitrary string values. Chars like `'`, `(`, `)`,
 * `*`, `!`, `~` are left raw by `encodeURIComponent` and remain part of the
 * OData literal syntax verbatim.
 */
export function serializeArgs(args: Record<string, unknown>, serverTimezone: string): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(formatValue(v, serverTimezone))}`)
  }
  return parts.join('&')
}

function formatValue(v: unknown, serverTimezone: string): string {
  if (v === null) return 'null'
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'bigint') return String(v)
  if (v instanceof Date) {
    return `datetime'${formatInZone(v, serverTimezone)}'`
  }
  // `@odata.bind` shape (spec §2.5) — emit the URI as a single-quoted string literal.
  // Without this branch the object would fall through to `String(v)` and produce a
  // bare `[object Object]` in the URL (silent server-side 400).
  if (typeof v === 'object' && '@odata.bind' in v) {
    const uri = (v as { '@odata.bind': unknown })['@odata.bind']
    if (typeof uri === 'string') return `'${uri.replace(/'/g, "''")}'`
  }
  // Fallback — shouldn't happen for normal FI args. Quote so unsupported objects
  // produce a visibly stringified value (`'[object Object]'`) instead of a bare one.
  return `'${String(v).replace(/'/g, "''")}'`
}

/**
 * Build the OData V3 FunctionImport URL. If `target.ref` is provided, the FI
 * is treated as instance-bound and the URL becomes `<base>/<set>(guid'<ref>')/<func>()`.
 * Otherwise it's treated as set-bound: `<base>/<set>/<func>()`.
 *
 * Args (excluding `ref`) are appended as query string per spec §2.5.
 */
export function buildFunctionUrl(
  base: string,
  entitySet: string,
  funcName: string,
  target: { ref?: string },
  args: Record<string, unknown>,
  serverTimezone: string,
): string {
  const trimmedBase = base.replace(/\/$/, '')
  let head: string
  if (target.ref !== undefined) {
    // Reject non-GUID `ref` early — a stray apostrophe would terminate the
    // OData literal and silently mutate the URL. Mirrors `formatKey`'s GUID
    // shape check in `url-builder.ts`.
    if (!GUID_RE.test(target.ref)) {
      throw new InvalidArgumentError('FunctionImport `ref` must be a GUID (8-4-4-4-12 hex form)', {
        argument: 'ref',
        received: target.ref,
      })
    }
    head = `${trimmedBase}/${entitySet}(guid'${target.ref}')/${funcName}()`
  } else {
    head = `${trimmedBase}/${entitySet}/${funcName}()`
  }
  const qs = serializeArgs(args, serverTimezone)
  return qs.length > 0 ? `${head}?${qs}` : head
}
