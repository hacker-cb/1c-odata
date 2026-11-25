// packages/client/src/url-builder.ts
import { InvalidArgumentError } from './errors.js'
import type { QueryBuilder } from './query/builder.js'

/**
 * Composite key for entities with multiple key fields (registers).
 * @public
 */
export type EntityKey = string | Record<string, string>

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
 * Encode a caller-supplied path (an entity set, or a set path such as
 * `Register_X/Balance(…)`) as ONE segment. A dot segment or an empty name has
 * no encoded form a URL parser keeps as a name — `<base>/..` collapses into the
 * path above the base — so it is rejected, as is a string that cannot be
 * encoded (a lone surrogate).
 *
 * @internal
 */
export function encodeSegment(name: string, argument = 'entitySet'): string {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..') {
    throw new InvalidArgumentError(`${argument} must be a name, not ${String(name)}`, { argument, received: name })
  }
  return encodeComponent(name, argument)
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
 * Build a V3 keyed URL: `<base>/<EntitySet>(<key>)?$format=...`.
 */
export function buildV3KeyUrl(base: string, entitySet: string, key: EntityKey): string {
  const keyExpr = formatKey(key)
  const path = `${base}/${encodeSegment(entitySet)}(${keyExpr})`
  const formatParam = qp('$format', 'application/json;odata=nometadata')
  return `${path}?${formatParam}`
}

/**
 * Build a V3 `/$count` URL: returns plain integer.
 */
export function buildV3CountUrl(base: string, q: QueryBuilder<unknown>): string {
  const path = `${base}/${encodeSegment(q.entitySet)}/$count`
  // Only $filter — /$count returns text/plain, no $format needed
  const params = buildQueryParams(q, { onlyFilter: true })
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

function buildQueryParams(q: QueryBuilder<unknown>, opts: { onlyFilter?: boolean } = {}): string[] {
  const s = q.state
  const params: string[] = []
  if (s.filter) params.push(qp('$filter', s.filter._expr))
  if (!opts.onlyFilter) {
    if (s.select) params.push(qp('$select', s.select.join(',')))
    if (s.expand) params.push(qp('$expand', s.expand.join(',')))
    if (s.orderBy) {
      const ob = s.orderBy.map((o) => `${o.field} ${o.dir}`).join(',')
      params.push(qp('$orderby', ob))
    }
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
 *   object → `field1=guid'...',field2='string'` — field names must be 1С names
 * Anything else is an `InvalidArgumentError`: a key goes into the URL path, so a
 * caller-supplied string (an MCP `get_entity` argument, say) with `'`, `)` or
 * `/` must not rewrite the path the request — with its credentials — reaches.
 */
export function formatKey(key: EntityKey): string {
  if (typeof key === 'string') {
    if (!GUID_RE.test(key)) {
      throw new InvalidArgumentError('Entity key must be a GUID (8-4-4-4-12 hex form) or a composite-key object', {
        argument: 'key',
        received: key,
      })
    }
    return `guid'${key}'`
  }
  const entries = typeof key === 'object' && key !== null ? Object.entries(key) : []
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
      if (typeof v !== 'string') {
        throw new InvalidArgumentError(`Composite-key field ${k} must be a string value`, {
          argument: 'key',
          received: v,
        })
      }
      return `${k}=${formatKeyValue(v)}`
    })
    .join(',')
}

function formatKeyValue(v: string): string {
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
