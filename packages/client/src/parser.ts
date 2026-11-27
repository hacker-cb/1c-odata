// packages/client/src/parser.ts

import { type DataShape, DEFAULT_SHAPE } from './connection.js'
import { InvalidArgumentError, ParseError } from './errors.js'
import { setOwn } from './own-key.js'
import { schemaOfType, typeNameOfRef, typeNameOfSet } from './schema-lookup.js'
import { parseInZone } from './timezone.js'
import { ONEC_EMPTY_DATE } from './types/core.js'
import type { EntitySchema, MetadataIndex } from './validate.js'

export interface ParseOptions {
  serverTimezone: string
  /** EntityType local name (e.g. `Catalog_X`) — drives schema lookup. */
  typeHint?: string
  /** Schema index loaded from codegen `__metadata.json`. */
  metadataIndex?: MetadataIndex
  /**
   * Resolved shape. Populated by `parseOptsFor` with `opts.shape ??
   * metadataIndex?.shape` precedence. `mapEntity`/`mapValue` fall back to
   * `metadataIndex?.shape` for direct callers that bypass `parseOptsFor`.
   *
   * @internal
   */
  shape?: DataShape
}

/**
 * Build `ParseOptions` for a parser call from a V3 client + entity-set context.
 * Centralises the conditional spread idiom that previously appeared at 7 call
 * sites (now distributed across `client/v3-query.ts`, `client/v3-handles.ts`,
 * `client/v3-functions-proxy.ts`, and `register.ts`). Pass `withTypeHint =
 * false` for virtual-table FI results, where the row shape differs from the
 * entity type.
 *
 * `client` is typed structurally (not as `ODataV3Client<unknown>`) so the
 * helper is callable with plain object literals from unit tests, AND so
 * `parser.ts` does not need to import the v3 client (which would create a
 * `parser.ts ↔ client/v3-*` cycle).
 *
 * NB on `metadataIndex?: MetadataIndex | undefined`: the explicit `| undefined`
 * is required (not just `?: MetadataIndex`) so callers can pass through a
 * value-or-undefined source like `ODataV3Client.metadataIndex` directly under
 * `exactOptionalPropertyTypes: true`. Do not "simplify" it back.
 *
 * @internal
 */
export function parseOptsFor(
  client: { serverTimezone: string; metadataIndex?: MetadataIndex | undefined; shape?: DataShape | undefined },
  entitySet: string,
  withTypeHint = true,
): ParseOptions {
  const typeHint = withTypeHint ? typeNameOfSet(client.metadataIndex, entitySet) : undefined
  const shape = client.shape ?? client.metadataIndex?.shape
  return {
    serverTimezone: client.serverTimezone,
    ...(typeHint !== undefined ? { typeHint } : {}),
    ...(client.metadataIndex !== undefined ? { metadataIndex: client.metadataIndex } : {}),
    ...(shape !== undefined ? { shape } : {}),
  }
}

export interface CollectionResult<T> {
  odataMetadata: string
  value: T[]
  count?: number
}

const DATETIME_FIELD = /^(?:\d{4})-(?:\d{2})-(?:\d{2})T(?:\d{2}):(?:\d{2}):(?:\d{2})(?:\.\d+)?$/

/** The wire form of an `Edm.Int64` 1С sends — a decimal integer string, optionally negative. */
const INT64_WIRE = /^-?\d+$/

/**
 * Parse a V3 collection response. Maps (in `dateMode='date'`, the default):
 *   - `odata.count` (string in 1С) → `number`
 *   - `Edm.DateTime` strings → `Date` via `parseInZone(v, opts.serverTimezone)`,
 *     except sentinel `0001-01-01T00:00:00` → `null` (sentinel check runs first)
 *   - `@navigationLinkUrl` fields are passed through as strings
 *   - When `metadataIndex` + `typeHint` present: Edm.Int64 → bigint/number per
 *     `shape.int64Mode` (a value that is neither null, a decimal integer
 *     string within the 64-bit range nor a safe-integer JSON number is a
 *     `ParseError` in both, untouched in `'string'`); a ValueStorage pair → ValueStorage object (or null on
 *     a null half), its halves removed; a half sent without its pair stays as it came
 *
 * In `dateMode='string'` mode parser passes Edm.DateTime through as wire string —
 * no sentinel handling, no tz conversion. User responsibility via parseInZone helper.
 *
 * A body without a `value` array, or with a row that is not an object, is a
 * `ParseError` — 1С sends an empty result as `"value": []`.
 */
export function parseV3Collection<T>(body: string, opts: ParseOptions): CollectionResult<T> {
  const parsed = safeParse(body)
  if (typeof parsed !== 'object' || parsed === null) throw new ParseError('Expected object at root')
  const obj = parsed as Record<string, unknown>
  // Before the rows: a malformed count fails the response without mapping them first.
  const count = inlineCount(obj['odata.count'])
  const value = collectionRows(parsed, obj.value).map((v) => mapEntity(v, opts))
  const result: CollectionResult<T> = {
    odataMetadata: typeof obj['odata.metadata'] === 'string' ? (obj['odata.metadata'] as string) : '',
    value: value as T[],
  }
  if (count !== undefined) result.count = count
  return result
}

/**
 * The rows of a collection response — its `value` array, every row an object.
 * 1С answers every collection read with one, an empty result as `"value": []`
 * (checked live on entity sets and on every register virtual table), so a body
 * without it — a gateway's `{"error": …}` with a 200, a truncated or foreign
 * body — is a `ParseError` naming what came instead, never "no rows".
 */
function collectionRows(root: unknown, value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    const got =
      value !== undefined
        ? `"value" ${describeJson(value)}`
        : Array.isArray(root)
          ? 'an array at root'
          : `no "value" — ${rootKeys(root as Record<string, unknown>)}`
    throw new ParseError(`Expected a "value" array in the collection response, got ${got}`)
  }
  value.forEach((row, i) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new ParseError(`Expected an object at value[${i}] of the collection response, got ${describeJson(row)}`)
    }
  })
  return value as Record<string, unknown>[]
}

/** A JSON value by its kind, for a message — never its content beyond a short scalar. */
function describeJson(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'an array'
  if (typeof v === 'object') return 'an object'
  // A string is cut before it is quoted — never serialized whole, never split inside a character or an escape.
  if (typeof v === 'string') return `string ${JSON.stringify(clip(v, 50))}`
  return `${typeof v} ${String(v)}`
}

/** `s` cut to its first `max` characters (code points), `…` marking a cut. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s
  let out = ''
  let n = 0
  for (const ch of s) {
    if (n === max) return `${out}…`
    out += ch
    n++
  }
  return out
}

/** The first keys of a response body's root object, for a message. */
function rootKeys(root: Record<string, unknown>): string {
  const keys = Object.keys(root)
  if (keys.length === 0) return 'an empty object'
  const shown = keys.slice(0, 5).map((k) => JSON.stringify(clip(k, 40)))
  return `keys ${shown.join(', ')}${keys.length > 5 ? `, … (${keys.length} in all)` : ''}`
}

/**
 * The `odata.count` of a collection (`$inlinecount=allpages`) — a string in 1С,
 * read by the `/$count` rule; a JSON number taken where it is a non-negative
 * safe integer. Absent is `undefined`; anything else is a `ParseError`.
 */
function inlineCount(raw: unknown): number | undefined {
  if (raw === undefined) return undefined
  if (typeof raw === 'string') return strictCount(raw, 'odata.count')
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return raw
  // Not `String(raw)`: a JSON object with a `"toString"` key fails it with a TypeError.
  throw new ParseError(`Expected a non-negative integer row count in odata.count, got: ${describeJson(raw)}`)
}

/**
 * Parse a single-entity V3 response (e.g. `Catalog_X(guid'...')` GET).
 * The response object is the entity itself with `odata.metadata` alongside —
 * NOT wrapped in `value`.
 */
export function parseV3Single<T>(body: string, opts: ParseOptions): T {
  const parsed = safeParse(body)
  if (typeof parsed !== 'object' || parsed === null) throw new ParseError('Expected object at root')
  const obj = parsed as Record<string, unknown>
  // Strip odata.metadata from the entity payload
  const { 'odata.metadata': _, ...rest } = obj
  return mapEntity(rest, opts) as T
}

/**
 * Parse a `/$count` response — the whole (BOM-stripped, trimmed) body a
 * non-negative decimal integer within the safe range. `12oops`, `1.5`, `-1`,
 * `1e3` or an empty body is a `ParseError` rather than a count read off its
 * prefix: a proxy page or a truncated body starting with digits is no total.
 * The one parser of a `/$count` body — `.count()`, register virtual tables.
 */
export function parseV3Count(body: string): number {
  return strictCount(body, '/$count')
}

/**
 * `text` as a row count — trimmed (`trim` takes a BOM too), then only `^\d+$`
 * within the safe range — or a `ParseError` naming `source`.
 */
function strictCount(text: string, source: string): number {
  const digits = text.trim()
  const n = /^\d+$/.test(digits) ? Number(digits) : Number.NaN
  if (!Number.isSafeInteger(n)) {
    throw new ParseError(`Expected a non-negative integer row count in ${source}, got: ${digits.slice(0, 50)}`)
  }
  return n
}

function mapEntity(obj: Record<string, unknown>, opts: ParseOptions): Record<string, unknown> {
  const schema = schemaOfType(opts.metadataIndex, opts.typeHint)
  const shape: DataShape | undefined = opts.shape ?? opts.metadataIndex?.shape

  // Every key the body sent becomes the row's own field — `__proto__` included (`JSON.parse` makes it an own
  // key; plain assignment would swap the row's prototype for it).
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    setOwn(out, k, mapValue(v, k, schema, shape, opts))
  }

  // Group ValueStorage triples: <X>_Base64Data + <X>_Type → ValueStorage, a null half → out[base] = null; the
  // flat halves go once grouped (emitted TS does not declare them). Only a pair is grouped: a half the body
  // sent alone (`$select` named one) — or a pair of values neither form fits — stays the field it came as, where
  // removing it lost the value the caller asked for.
  if (schema !== undefined) {
    for (const base of schema.valueStorages ?? []) {
      const b64Key = `${base}_Base64Data`
      const ctKey = `${base}_Type`
      if (!Object.hasOwn(out, b64Key) || !Object.hasOwn(out, ctKey)) continue
      const b64 = out[b64Key]
      const ct = out[ctKey]
      if (typeof b64 === 'string' && typeof ct === 'string') {
        setOwn(out, base, { contentType: ct, base64Data: b64 })
      } else if (b64 === null || ct === null) {
        setOwn(out, base, null)
      } else {
        continue
      }
      delete out[b64Key]
      delete out[ctKey]
    }
  }

  return out
}

function mapValue(
  v: unknown,
  fieldName: string,
  schema: EntitySchema | undefined,
  shape: DataShape | undefined,
  opts: ParseOptions,
): unknown {
  const propType = schema?.properties[fieldName]?.type
  if (propType === 'Edm.Int64') {
    // Defaults to 'number' per the DataShape contract in connection.ts: no shape (or one without `int64Mode`)
    // means "behave like the documented default", not "leave the wire value untouched".
    const mode = shape?.int64Mode ?? DEFAULT_SHAPE.int64Mode
    if (mode === 'bigint' || mode === 'number') return int64Value(v, fieldName, mode)
  }
  if (typeof v === 'string') return convertStringValue(v, fieldName, propType, shape, opts)
  // A schema-typed date-time is a string or null on the wire; anything else would reach a `Date`-typed field
  // as-is. `dateMode: 'string'` passes values through untouched, this one included.
  if (propType === 'Edm.DateTime' && v !== null && shape?.dateMode !== 'string') {
    const shown = JSON.stringify(v)?.slice(0, 64) ?? String(v)
    throw new ParseError(
      `Edm.DateTime field ${fieldName}: expected a date-time string or null, got ${typeof v} ${shown}`,
    )
  }
  // Nested entities (tabular parts, ComplexTypes) are parsed with THEIR OWN
  // schema, resolved from the field's declared type — not the parent's. Without
  // this, a nested `Edm.Int64` / `Edm.DateTime` / ValueStorage field is looked
  // up in the parent schema (absent → no conversion), diverging from the write
  // path (write-transform.ts), which already recurses with the nested type.
  if (Array.isArray(v)) {
    const childOpts = withNestedTypeHint(opts, propType)
    // An array inside the array (no OData V3 collection holds one) is read as an array again, never handed
    // to `mapEntity`, which would turn it into an object keyed `"0"`, `"1"`, …. The field's declared type
    // describes the items of this array, not those of one nested in it: that one is read schema-less.
    return v.map((item) =>
      Array.isArray(item)
        ? mapValue(item, fieldName, undefined, shape, opts)
        : typeof item === 'object' && item !== null
          ? mapEntity(item as Record<string, unknown>, childOpts)
          : mapValue(item, fieldName, schema, shape, opts),
    )
  }
  if (typeof v === 'object' && v !== null) {
    return mapEntity(v as Record<string, unknown>, withNestedTypeHint(opts, propType))
  }
  return v
}

/**
 * An `Edm.Int64` wire value converted per `int64Mode` — `null`, a decimal
 * integer string within the signed 64-bit range (what 1С sends), or a JSON
 * number that is a safe integer. Anything else is a `ParseError` naming the
 * field and the value, where `BigInt` threw a bare `SyntaxError` on `12x` and
 * read `''` / ` 0x1f ` as 0n / 31n, `Number` made `12x` NaN and `''` 0, and a
 * JSON number reached a `bigint`-typed field as-is, a fraction included.
 */
function int64Value(v: unknown, fieldName: string, mode: 'bigint' | 'number'): unknown {
  if (v === null) return null
  // A JSON number is no Edm.Int64 by the OData V3 spec, but a server or proxy sending a whole one costs no
  // value as long as it is a safe integer — refusing it would fail every read of the set for nothing.
  const n =
    typeof v === 'string' ? int64OfWire(v) : typeof v === 'number' && Number.isSafeInteger(v) ? BigInt(v) : undefined
  if (n === undefined) {
    throw new ParseError(
      `Edm.Int64 field ${fieldName}: expected a 64-bit integer string, a safe integer or null, got ${describeJson(v)}`,
    )
  }
  if (mode === 'bigint') return n
  const num = Number(n)
  return num === 0 ? 0 : num // `-0` reads as 0, as it reads as 0n
}

const INT64_MIN = -(2n ** 63n)
const INT64_MAX = 2n ** 63n - 1n

/**
 * `v` as a `bigint` where it is a decimal integer string within the signed
 * 64-bit range, else `undefined`. Past 19 significant digits it is out of range
 * without `BigInt` ever reading it — a long string costs no arbitrary-precision
 * parse.
 */
function int64OfWire(v: string): bigint | undefined {
  if (!INT64_WIRE.test(v)) return undefined
  const significant = v.length - (v.match(/^-?0*/)?.[0].length ?? 0)
  if (significant > 19) return undefined
  const n = BigInt(v)
  return n >= INT64_MIN && n <= INT64_MAX ? n : undefined
}

/** Convert a string wire value per its declared (or heuristically-detected) type. */
function convertStringValue(
  v: string,
  fieldName: string,
  propType: string | undefined,
  shape: DataShape | undefined,
  opts: ParseOptions,
): unknown {
  // Edm.DateTime — by schema or regex heuristic.
  // `Collection(Edm.DateTime)` not handled here — 0 empirical occurrences in real
  // 1С EDMX; emitter falls back to generic `Date[]` typing, runtime leaves wire
  // elements as strings. See packages/cli/src/codegen/emitter/entity.ts for the
  // full design rationale.
  if (propType === 'Edm.DateTime' || (propType === undefined && DATETIME_FIELD.test(v))) {
    if (shape?.dateMode === 'string') return v
    if (v === ONEC_EMPTY_DATE) return null
    return parseDateTime(v, fieldName, propType !== undefined, opts.serverTimezone)
  }
  return v
}

/**
 * A wire date-time → `Date` in the server's zone. A time a daylight-saving
 * switch skips or passes twice still parses (`parseInZone`'s `'compatible'`
 * rule): 1С stores wall-clock time without checking it. What does not name a
 * real date-time (`2026-02-30T00:00:00`) is, for a field the schema declares
 * `Edm.DateTime`, a `ParseError` naming the field and the value — the reply
 * breaks its own schema; for a field matched by the schema-less heuristic it
 * was never a date-time, and stays the string it came as.
 */
function parseDateTime(v: string, fieldName: string, typed: boolean, serverTimezone: string): Date | string {
  try {
    return parseInZone(v, serverTimezone)
  } catch (err) {
    if (!(err instanceof InvalidArgumentError) || err.argument !== 'naive') throw err
    if (!typed) return v
    throw new ParseError(`Edm.DateTime field ${fieldName}: ${err.message}`, { cause: err })
  }
}

/**
 * Build the `ParseOptions` for a nested value: adopt the nested type's own
 * `typeHint` when resolvable, otherwise drop the parent `typeHint` so the
 * nested value is parsed schema-less (an expanded navigation property is absent
 * from `schema.properties`, so its type can't be resolved here — schema-less is
 * safer than misapplying the parent schema).
 */
function withNestedTypeHint(opts: ParseOptions, propType: string | undefined): ParseOptions {
  const typeHint = typeNameOfRef(opts.metadataIndex, propType)
  const { typeHint: _parent, ...rest } = opts
  return typeHint !== undefined ? { ...rest, typeHint } : rest
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch (e) {
    throw new ParseError('Invalid JSON in response body', { cause: e })
  }
}
