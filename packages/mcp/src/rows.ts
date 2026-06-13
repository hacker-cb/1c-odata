/**
 * Pure row-shaping utilities shared by the data tools and result serialization:
 * JSON-safe coercion, OData/1С noise stripping, and byte-budget truncation.
 * Dependency-free so they stay unit-testable without a live client.
 */

/**
 * Recursively convert a value into JSON-safe form: `bigint` → decimal string
 * (1С `Edm.Int64` under `int64Mode: 'bigint'` would otherwise throw in
 * `JSON.stringify`), `Date` → ISO string. Everything else passes through.
 */
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(toJsonSafe)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value)) out[key] = toJsonSafe(val)
    return out
  }
  return value
}

/**
 * Recursively strip 1С/OData annotation noise from query rows (opt-in via the
 * data tools' `compact` flag):
 * - `<Field>_Type` — the composite-type companion 1С emits next to every
 *   reference field (e.g. `Recorder_Type: "StandardODATA.Document_…"`). It names
 *   the referenced entity type; dropped when the caller doesn't need it.
 * - `@odata.*` / `__metadata` — protocol annotations (absent from 1С rows in
 *   practice, stripped defensively).
 *
 * `<Field>_Key` (the actual FK GUID) is intentionally KEPT, and `Date` values
 * pass through untouched (treating them as plain objects would erase them).
 */
export function stripNoise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNoise)
  if (value instanceof Date) return value
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value)) {
      if (key.endsWith('_Type') || key.startsWith('@odata') || key === '__metadata') continue
      out[key] = stripNoise(val)
    }
    return out
  }
  return value
}

/**
 * Recursively cap oversized string leaf values: any string whose UTF-8 size
 * exceeds `capBytes` is replaced with a short head plus a `…(N bytes truncated)`
 * marker. This keeps the byte budget binding for the cases {@link fitRows} can't
 * help with — a single row whose size is dominated by one huge field (a base64
 * `ValueStorage`, a large text/HTML field), and single-entity `get_entity`
 * reads. Preserves `Date`/`bigint` and object/array structure.
 */
export function capLongStrings(value: unknown, capBytes: number): unknown {
  if (typeof value === 'string') {
    const total = Buffer.byteLength(value, 'utf8')
    if (total <= capBytes) return value
    // Head trimmed by UTF-8 bytes (never larger than the cap) so capping always
    // shrinks the field, even for multi-byte Cyrillic. No retrieval hint — the
    // MCP server exposes no way to fetch the full blob.
    const head = sliceUtf8(value, Math.min(120, capBytes))
    return `${head}…(truncated, ${total} bytes)`
  }
  if (value instanceof Date) return value
  if (Array.isArray(value)) return value.map((v) => capLongStrings(v, capBytes))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value)) out[key] = capLongStrings(val, capBytes)
    return out
  }
  return value
}

/** Longest prefix of `s` whose UTF-8 encoding fits in `maxBytes`, never splitting a code point. */
function sliceUtf8(s: string, maxBytes: number): string {
  let bytes = 0
  let end = 0
  for (const ch of s) {
    const chBytes = Buffer.byteLength(ch, 'utf8')
    if (bytes + chBytes > maxBytes) break
    bytes += chBytes
    end += ch.length
  }
  return s.slice(0, end)
}

/** Outcome of {@link fitRows}: the rows that fit, and whether any were dropped. */
export interface FitResult<T> {
  rows: T[]
  truncated: boolean
}

/**
 * Keep the longest prefix of `rows` whose compact-JSON size stays within
 * `byteBudget` (UTF-8 bytes). Always keeps at least one row when `rows` is
 * non-empty, so the caller still sees the result shape even if a single row
 * exceeds the budget. `truncated` is `true` when any rows were dropped.
 */
export function fitRows<T>(rows: T[], byteBudget: number): FitResult<T> {
  if (rows.length === 0) return { rows, truncated: false }
  const kept: T[] = []
  let used = 2 // the enclosing "[]"
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(toJsonSafe(row)) ?? '', 'utf8') + 1 // +1 for the separator
    if (kept.length > 0 && used + size > byteBudget) break
    kept.push(row)
    used += size
  }
  return { rows: kept, truncated: kept.length < rows.length }
}
