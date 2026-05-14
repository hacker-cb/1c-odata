// packages/client/src/url-builder.ts
import type { QueryBuilder } from './query/builder.js'

/**
 * Composite key for entities with multiple key fields (registers).
 * @public
 */
export type EntityKey = string | Record<string, string>

/**
 * Build a V3 collection URL: `<base>/<EntitySet>?$format=...&$filter=...&...`.
 */
export function buildV3CollectionUrl(base: string, q: QueryBuilder<unknown>): string {
  const path = `${base}/${encodeURIComponent(q.entitySet)}`
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
  const path = `${base}/${encodeURIComponent(entitySet)}(${keyExpr})`
  const formatParam = qp('$format', 'application/json;odata=nometadata')
  return `${path}?${formatParam}`
}

/**
 * Build a V3 `/$count` URL: returns plain integer.
 */
export function buildV3CountUrl(base: string, q: QueryBuilder<unknown>): string {
  const path = `${base}/${encodeURIComponent(q.entitySet)}/$count`
  // Only $filter — /$count returns text/plain, no $format needed
  const params = buildQueryParams(q, { onlyFilter: true })
  if (params.length === 0) return path
  return `${path}?${params.join('&')}`
}

/** Encode both the key (including `$`) and value */
function qp(key: string, value: string): string {
  return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
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
 *   string → `guid'...'` (assumes Guid)
 *   object → `field1=guid'...',field2='string'`
 */
export function formatKey(key: EntityKey): string {
  if (typeof key === 'string') return `guid'${key}'`
  return Object.entries(key)
    .map(([k, v]) => `${k}=${formatKeyValue(v)}`)
    .join(',')
}

function formatKeyValue(v: string): string {
  // GUID-shaped: quote as guid. Hex+hyphens only — URL-safe by construction.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return `guid'${v}'`
  // Otherwise treat as string literal. Two-step encoding: OData apostrophe
  // doubling first (so a literal `'` inside the value survives parsing), then
  // URL-encode the inner content. `encodeURIComponent` percent-encodes the
  // problematic chars (&, ?, #, space, +, %) and leaves `'`, `(`, `)`, `*`,
  // `!`, `~` raw — the doubled `''` survives intact, and `)` is safe inside
  // the quoted OData string literal because OData tokenizes literals by
  // grammar, not by paren-counting. The outer apostrophes stay raw as the
  // OData literal delimiter.
  return `'${encodeURIComponent(v.replace(/'/g, "''"))}'`
}
