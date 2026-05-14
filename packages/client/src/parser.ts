// packages/client/src/parser.ts

import type { DataShape } from './connection.js'
import { ParseError } from './errors.js'
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
  const typeHint = withTypeHint ? client.metadataIndex?.entitySetToType[entitySet] : undefined
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

/**
 * Parse a V3 collection response. Maps (in `dateMode='date'`, the default):
 *   - `odata.count` (string in 1С) → `number`
 *   - `Edm.DateTime` strings → `Date` via `parseInZone(v, opts.serverTimezone)`,
 *     except sentinel `0001-01-01T00:00:00` → `null` (sentinel check runs first)
 *   - `@navigationLinkUrl` fields are passed through as strings
 *   - When `metadataIndex` + `typeHint` present: Edm.Int64 → bigint/number per
 *     `shape.int64Mode`; ValueStorage triples → ValueStorage object (or null on
 *     null halves; halves removed from output regardless)
 *
 * In `dateMode='string'` mode parser passes Edm.DateTime through as wire string —
 * no sentinel handling, no tz conversion. User responsibility via parseInZone helper.
 */
export function parseV3Collection<T>(body: string, opts: ParseOptions): CollectionResult<T> {
  const parsed = safeParse(body)
  if (typeof parsed !== 'object' || parsed === null) throw new ParseError('Expected object at root')
  const obj = parsed as Record<string, unknown>
  const value = Array.isArray(obj.value)
    ? (obj.value as unknown[]).map((v) => mapEntity(v as Record<string, unknown>, opts))
    : []
  const result: CollectionResult<T> = {
    odataMetadata: typeof obj['odata.metadata'] === 'string' ? (obj['odata.metadata'] as string) : '',
    value: value as T[],
  }
  if (typeof obj['odata.count'] === 'string') result.count = Number.parseInt(obj['odata.count'] as string, 10)
  return result
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
 * Parse a `/$count` response: BOM-prefixed plain integer.
 */
export function parseV3Count(body: string): number {
  const trimmed = body.replace(/^﻿/, '').trim()
  const n = Number.parseInt(trimmed, 10)
  if (Number.isNaN(n)) throw new ParseError(`Expected integer in /$count response, got: ${trimmed.slice(0, 50)}`)
  return n
}

function mapEntity(obj: Record<string, unknown>, opts: ParseOptions): Record<string, unknown> {
  const schema =
    opts.typeHint !== undefined && opts.metadataIndex !== undefined
      ? opts.metadataIndex.schemas[opts.typeHint]
      : undefined
  const shape: DataShape | undefined = opts.shape ?? opts.metadataIndex?.shape

  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    out[k] = mapValue(v, k, schema, shape, opts)
  }

  // Group ValueStorage triples: <X>_Base64Data + <X>_Type → ValueStorage.
  // Null halves: collapse to out[base] = null and remove flat halves
  // (they're not declared in emitted TS — leaving them would leak).
  if (schema !== undefined) {
    for (const base of schema.valueStorages ?? []) {
      const b64 = out[`${base}_Base64Data`]
      const ct = out[`${base}_Type`]
      if (typeof b64 === 'string' && typeof ct === 'string') {
        out[base] = { contentType: ct, base64Data: b64 }
      } else if (b64 === null || ct === null) {
        out[base] = null
      }
      delete out[`${base}_Base64Data`]
      delete out[`${base}_Type`]
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
  if (typeof v === 'string') {
    const propType = schema?.properties[fieldName]?.type
    // Edm.Int64 — apply `shape.int64Mode`. Defaults to 'number' per the
    // DataShape contract in connection.ts; absence of an explicit shape (or
    // an explicit shape without `int64Mode`) means "behave like the documented
    // default", not "leave the wire string untouched".
    if (propType === 'Edm.Int64') {
      const mode = shape?.int64Mode ?? 'number'
      if (mode === 'bigint') return BigInt(v)
      if (mode === 'number') return Number(v)
      return v
    }
    // Edm.DateTime — by schema or regex heuristic.
    // `Collection(Edm.DateTime)` not handled here — 0 empirical occurrences in real
    // 1С EDMX; emitter falls back to generic `Date[]` typing, runtime leaves wire
    // elements as strings. See packages/cli/src/codegen/emitter/entity.ts for the
    // full design rationale.
    if (propType === 'Edm.DateTime' || (propType === undefined && DATETIME_FIELD.test(v))) {
      if (shape?.dateMode === 'string') return v
      if (v.startsWith(ONEC_EMPTY_DATE)) return null
      return parseInZone(v, opts.serverTimezone)
    }
    return v
  }
  if (Array.isArray(v)) {
    return v.map((item) =>
      typeof item === 'object' && item !== null
        ? mapEntity(item as Record<string, unknown>, opts)
        : mapValue(item, fieldName, schema, shape, opts),
    )
  }
  if (typeof v === 'object' && v !== null) {
    return mapEntity(v as Record<string, unknown>, opts)
  }
  return v
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch (e) {
    throw new ParseError('Invalid JSON in response body', { cause: e })
  }
}
