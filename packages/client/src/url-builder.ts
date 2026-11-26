// packages/client/src/url-builder.ts
import { InvalidArgumentError } from './errors.js'
import { formatNumberLiteral } from './format-number.js'
import type { QueryBuilder } from './query/builder.js'
import { formatInZone } from './timezone.js'

/**
 * An entity key: a `Ref_Key` GUID string, or a composite key — an object of
 * key field → value for entities with several key fields (registers, tabular
 * rows). A composite value is written by its JS type, as the 1С docs show it:
 * a GUID string as `guid'…'`, any other string as a quoted literal, a `number`
 * or `bigint` bare (`LineNumber=1`), a `boolean` as `true` / `false`, a `Date`
 * as `datetime'…'` in the connection's `serverTimezone`
 * (`Period=datetime'2025-01-01T00:00:00'`) — so a value read back from a
 * record keys it as it came. Those that do not: the empty date, read as
 * `null` (pass `ONEC_EMPTY_DATE`); an `Edm.Int64` past 2^53 read as a
 * `number` (read it with `int64Mode: 'bigint'` or `'string'`); a wall-clock
 * time a daylight-saving switch skips, which a `Date` cannot hold, and a
 * string field the schema-less date heuristic took for a date-time (read
 * with a schema, or with `dateMode: 'string'`).
 *
 * @public
 */
export type EntityKey = string | Record<string, string | number | bigint | boolean | Date>

/** A GUID in the 8-4-4-4-12 hex form — the only string key 1С entities take (`Ref_Key`). @internal */
export const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A 1С metadata name — an entity set, a function, a key field: letters (Cyrillic included), digits, `_`. @internal */
export const NAME_RE = /^[\p{L}\p{N}_]+$/u

/**
 * `encodeURIComponent`, answering a string it cannot encode (a lone UTF-16
 * surrogate, which makes it throw a raw `URIError`) with the library's own
 * `InvalidArgumentError` naming the argument.
 *
 * @internal
 */
export function encodeComponent(value: string, argument: string): string {
  try {
    return encodeURIComponent(value)
  } catch {
    throw new InvalidArgumentError(`${argument} cannot be URL-encoded (it contains a lone UTF-16 surrogate)`, {
      argument,
      received: value,
    })
  }
}

/**
 * One path segment for a metadata name — an entity set or function in a
 * FunctionImport URL, a ValueStorage property. Anything but a plain name — a
 * `/`, `?`, `#`, `%`, `(`, a dot segment, an empty or malformed string — is
 * rejected rather than encoded: a caller-supplied name (an MCP tool argument,
 * say) must not reach another path of the host with this connection's
 * credentials, push the query into a fragment, address an entity instead of
 * the set, or rely on how a proxy in between decodes `%2F`.
 *
 * @internal
 */
export function encodeName(name: string, argument: string): string {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new InvalidArgumentError(
      `${argument} must be a 1С metadata name (letters, digits, _), got ${typeof name === 'string' ? JSON.stringify(name) : String(name)}`,
      { argument, received: name },
    )
  }
  return encodeURIComponent(name)
}

/**
 * Encode a caller-supplied path (an entity set, or a set path such as
 * `Register_X/Balance(…)`) as ONE segment. A dot segment or an empty name has
 * no encoded form a URL parser keeps as a name — `<base>/..` collapses into the
 * path above the base — so it is rejected, as is a string that cannot be
 * encoded (a lone surrogate).
 *
 * @internal
 */
export function encodeSegment(name: string, argument = 'entitySet'): string {
  // Any empty or dot part — `..`, `X/..`, `X//Y`, `X\\..` — would collapse once a
  // server or proxy splits on the encoded separator, so it is rejected.
  if (typeof name !== 'string' || pathParts(name).some((part) => part === '' || part === '.' || part === '..')) {
    throw new InvalidArgumentError(`${argument} must be a name, not ${String(name)}`, { argument, received: name })
  }
  return encodeComponent(name, argument)
}

/**
 * The parts of a set path between its `/` or `\\` separators, skipping those
 * inside parentheses and quoted OData literals — a `Condition='… https://…'`
 * argument of a virtual table is one part, not several.
 */
function pathParts(path: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quoted = false
  let start = 0
  for (let i = 0; i < path.length; i++) {
    const ch = path[i]
    if (ch === "'") quoted = !quoted
    else if (!quoted && ch === '(') depth++
    else if (!quoted && ch === ')') depth = Math.max(0, depth - 1)
    else if (!quoted && depth === 0 && (ch === '/' || ch === '\\')) {
      parts.push(path.slice(start, i))
      start = i + 1
    }
  }
  parts.push(path.slice(start))
  return parts
}

/**
 * Build a V3 collection URL: `<base>/<EntitySet>?$format=...&$filter=...&...`.
 */
export function buildV3CollectionUrl(base: string, q: QueryBuilder<unknown>): string {
  const path = `${base}/${encodeSegment(q.entitySet)}`
  const params = buildQueryParams(q)
  // Always prepend $format
  const allParams = [qp('$format', 'application/json;odata=nometadata'), ...params]
  return `${path}?${allParams.join('&')}`
}

/**
 * Build a V3 keyed URL: `<base>/<EntitySet>(<key>)?$format=...`. A `Date` in a
 * composite key is written in `serverTimezone`.
 */
export function buildV3KeyUrl(base: string, entitySet: string, key: EntityKey, serverTimezone: string): string {
  const keyExpr = formatKey(key, serverTimezone)
  const path = `${base}/${encodeSegment(entitySet)}(${keyExpr})`
  const formatParam = qp('$format', 'application/json;odata=nometadata')
  return `${path}?${formatParam}`
}

/**
 * Build a V3 `/$count` URL: returns plain integer. It carries the query's
 * `$filter`, `$select` and `$expand`: on a register virtual table in the path
 * (`AccumulationRegister_X/Balance`) 1С counts the rows as it would roll them
 * up by the `$select` (#215 — see `V3QueryBuilder.count()`), and a navigation
 * path in `$select` needs its `$expand`, there as on the page. On an ordinary
 * entity set the count is the same with them or without. `$orderby` / `$top` /
 * `$skip` / `$inlinecount` stay off; so does `$format`, `/$count` answering
 * text/plain.
 */
export function buildV3CountUrl(base: string, q: QueryBuilder<unknown>): string {
  const path = `${base}/${encodeSegment(q.entitySet)}/$count`
  const params = buildQueryParams(q, { count: true })
  if (params.length === 0) return path
  return `${path}?${params.join('&')}`
}

/**
 * Encode both the key (including `$`) and value of one system query option.
 * Shared by the collection builders here and the register virtual-table calls
 * (`register.ts`), so both encode `$filter` / `$select` alike.
 *
 * @internal
 */
export function qp(key: string, value: string): string {
  return `${encodeURIComponent(key)}=${encodeComponent(value, key)}`
}

/**
 * The `$orderby` value: `field dir` pairs joined by commas, `dir` defaulting to
 * `asc`. Shared by collection queries and the register virtual-table calls
 * (`register.ts`); validating the fields is the caller's.
 *
 * @internal
 */
export function formatOrderBy(orderBy: readonly { field: string; dir?: 'asc' | 'desc' | undefined }[]): string {
  return orderBy.map((o) => `${o.field} ${o.dir ?? 'asc'}`).join(',')
}

function buildQueryParams(q: QueryBuilder<unknown>, opts: { count?: boolean } = {}): string[] {
  const s = q.state
  const params: string[] = []
  if (s.filter) params.push(qp('$filter', s.filter._expr))
  if (s.select) params.push(qp('$select', s.select.join(',')))
  if (s.expand) params.push(qp('$expand', s.expand.join(',')))
  if (!opts.count) {
    if (s.orderBy) params.push(qp('$orderby', formatOrderBy(s.orderBy)))
    if (s.top !== undefined) params.push(qp('$top', String(s.top)))
    if (s.skip !== undefined) params.push(qp('$skip', String(s.skip)))
    if (s.inlineCount) params.push(qp('$inlinecount', 'allpages'))
  }
  return params
}

/**
 * Normalize a baseUrl by trimming trailing slashes — needed for predictable
 * URL composition downstream (`<base>/<path>` would otherwise produce
 * `<base>//<path>`). Pure helper, no validation: malformed input passes
 * through. Idempotent.
 *
 * @public
 */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * Format a key as it appears inside `(...)`:
 *   string → `guid'...'` — must be a GUID (a 1С `Ref_Key`)
 *   object → `field1=guid'...',field2='string',LineNumber=1,Period=datetime'...'`
 *            — field names must be 1С names; values by JS type (see `EntityKey`),
 *            a `Date` in `serverTimezone`
 * Anything else is an `InvalidArgumentError`: a key goes into the URL path, so a
 * caller-supplied string (an MCP `get_entity` argument, say) with `'`, `)` or
 * `/` must not rewrite the path the request — with its credentials — reaches.
 */
export function formatKey(key: EntityKey, serverTimezone: string): string {
  if (typeof key === 'string') {
    if (!GUID_RE.test(key)) {
      throw new InvalidArgumentError('Entity key must be a GUID (8-4-4-4-12 hex form) or a composite-key object', {
        argument: 'key',
        received: key,
      })
    }
    return `guid'${key}'`
  }
  const entries = typeof key === 'object' && key !== null && !Array.isArray(key) ? Object.entries(key) : []
  if (entries.length === 0) {
    throw new InvalidArgumentError('Entity key must be a GUID or a non-empty composite-key object', {
      argument: 'key',
      received: key,
    })
  }
  return entries
    .map(([k, v]) => {
      if (!NAME_RE.test(k)) {
        throw new InvalidArgumentError(
          `Composite-key field must be a 1С name (letters, digits, _), got ${JSON.stringify(k)}`,
          {
            argument: 'key',
            received: k,
          },
        )
      }
      return `${k}=${formatKeyValue(k, v, serverTimezone)}`
    })
    .join(',')
}

/** One composite-key value as its OData literal, by JS type. */
function formatKeyValue(field: string, v: unknown, serverTimezone: string): string {
  // Not the shared quoted literal: a GUID string keys as `guid'…'`, and the rest is URL-encoded here.
  if (typeof v === 'string') return formatKeyString(v)
  // Digits, `.` and `-` only — URL-safe by construction.
  if (typeof v === 'number' && !Number.isFinite(v)) {
    throw new InvalidArgumentError(`Composite-key field ${field} must be a finite number, got ${String(v)}`, {
      argument: 'key',
      received: v,
    })
  }
  if (Number.isNaN(dateTime(v))) {
    throw new InvalidArgumentError(`Composite-key field ${field} is an invalid Date`, {
      argument: 'key',
      received: v,
    })
  }
  let literal: string | undefined
  try {
    // A `Date`: digits, `-`, `:`, `.` and `T` — `:` is a legal path character, written raw as 1С writes it in its own links.
    literal = formatScalarLiteral(v, serverTimezone, 'key')
  } catch (err) {
    // A year outside 1С's 0001–9999 in the zone: name the key field, as every other key error does.
    if (!(err instanceof InvalidArgumentError) || err.argument !== 'date') throw err
    throw new InvalidArgumentError(`Composite-key field ${field}: ${err.message}`, {
      argument: 'key',
      received: v,
      cause: err,
    })
  }
  if (literal !== undefined) return literal
  throw new InvalidArgumentError(`Composite-key field ${field} must be a string, number, bigint, boolean or Date`, {
    argument: 'key',
    received: v,
  })
}

/**
 * The OData literal of a scalar, by its JS type — the one rule the filter DSL,
 * function-import arguments and composite keys share: a string quoted with `'`
 * doubled, a `boolean` as `true` / `false`, a `number` as a plain decimal
 * (`argument` names it in the error for a non-finite one), a `bigint` bare, a
 * `Date` — any realm's (`node:vm`) — as `datetime'…'` in `serverTimezone`.
 * `undefined` for anything else (`null`, an object), which each caller writes
 * by its own rule. Not URL-encoded.
 *
 * @throws InvalidArgumentError — a non-finite number; an invalid `Date`, or one
 *   whose year in the zone falls outside 1С's 0001–9999 (`argument: 'date'`).
 * @internal
 */
export function formatScalarLiteral(v: unknown, serverTimezone: string, argument: string): string | undefined {
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return formatNumberLiteral(v, argument)
  if (typeof v === 'bigint') return String(v)
  if (isDate(v)) return `datetime'${formatInZone(v, serverTimezone)}'`
  return undefined
}

/**
 * The time value of a `Date` — any realm's (`node:vm`), read by
 * `Date.prototype.getTime` itself, so a subclass overriding `getTime` cannot
 * move it — or `undefined` for anything that is not a `Date`.
 *
 * @internal
 */
export function dateTime(v: unknown): number | undefined {
  // Only an object can be a Date: no exception thrown and caught per primitive.
  if (typeof v !== 'object' || v === null) return undefined
  try {
    return Date.prototype.getTime.call(v)
  } catch {
    return undefined
  }
}

/**
 * Whether `v` is to be written as a date: a `Date` of any realm (`node:vm`),
 * where `instanceof Date` answers `false` for another realm's — or anything
 * `instanceof Date` (a `Proxy` over a `Date`), which `formatInZone` then
 * refuses with an `InvalidArgumentError` rather than let it pass as an object.
 *
 * @internal
 */
export function isDate(v: unknown): v is Date {
  return v instanceof Date || dateTime(v) !== undefined
}

function formatKeyString(v: string): string {
  // GUID-shaped: quote as guid. Hex+hyphens only — URL-safe by construction.
  if (GUID_RE.test(v)) return `guid'${v}'`
  // Otherwise treat as string literal. Two-step encoding: OData apostrophe
  // doubling first (so a literal `'` inside the value survives parsing), then
  // URL-encode the inner content. `encodeURIComponent` percent-encodes the
  // problematic chars (&, ?, #, space, +, %) and leaves `'`, `(`, `)`, `*`,
  // `!`, `~` raw — the doubled `''` survives intact, and `)` is safe inside
  // the quoted OData string literal because OData tokenizes literals by
  // grammar, not by paren-counting. The outer apostrophes stay raw as the
  // OData literal delimiter.
  return `'${encodeComponent(v.replace(/'/g, "''"), 'key')}'`
}
