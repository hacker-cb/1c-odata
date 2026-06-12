import { formatInZone } from './timezone.js'
import { ONEC_EMPTY_DATE } from './types/core.js'
import type { EntitySchema, MetadataIndex } from './validate.js'

/** Transform a single Edm.DateTime field value into wire form. */
function transformDateTime(v: unknown, tz: string): unknown {
  if (v === null) return ONEC_EMPTY_DATE
  if (v instanceof Date) return formatInZone(v, tz)
  return v // string passthrough
}

/**
 * Value-based write fallback for fields/bodies with no schema: convert every
 * `Date` instance to naive ISO in the server timezone, recursing into plain
 * objects and arrays. Mirror of the read-side regex heuristic (parser.ts) —
 * a `Date` in a write payload can only mean an `Edm.DateTime` field, the
 * sole Date-shaped type in 1С EDMX.
 *
 * Unlike the schema-driven path, `null` is NOT turned into the
 * `ONEC_EMPTY_DATE` sentinel — without a schema `null` is valid for any
 * nullable field; pass `ONEC_EMPTY_DATE` explicitly to clear a date.
 *
 * @internal
 */
export function transformDateValuesUntyped(v: unknown, tz: string): unknown {
  if (v instanceof Date) return formatInZone(v, tz)
  if (Array.isArray(v)) return v.map((item) => transformDateValuesUntyped(item, tz))
  // Recurse into plain objects only — exotic objects (Map, Buffer, class
  // instances) keep the old passthrough behavior and serialize as before.
  if (typeof v === 'object' && v !== null) {
    const proto = Object.getPrototypeOf(v)
    if (proto !== Object.prototype && proto !== null) return v
    const out: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(v)) {
      if (value === undefined) continue
      out[name] = transformDateValuesUntyped(value, tz)
    }
    return out
  }
  return v
}

/**
 * `JSON.stringify` replacer: serialize `bigint` as its decimal string — the
 * wire form of `Edm.Int64`. Without it `JSON.stringify` throws `TypeError`
 * on any bigint, breaking the `int64Mode: 'bigint'` read → write round-trip.
 *
 * NB: `Date` cannot be fixed the same way — `toJSON` runs BEFORE the
 * replacer sees the value, so date conversion lives in the transforms above.
 *
 * @internal
 */
export function bigintToStringReplacer(_key: string, v: unknown): unknown {
  return typeof v === 'bigint' ? String(v) : v
}

/** Strip schema namespace prefix from a fully-qualified type reference. */
function makeStripNs(metadataIndex: MetadataIndex): (t: string) => string {
  const prefix = `${metadataIndex.schemaNamespace}.`
  return (t: string): string => (t.startsWith(prefix) ? t.slice(prefix.length) : t)
}

/** Recurse into a Collection(<ns>.Foo) field, transforming each element. */
function transformCollection(
  v: unknown[],
  propType: string,
  tz: string,
  metadataIndex: MetadataIndex,
  dateMode: 'date' | 'string',
  stripNs: (t: string) => string,
): unknown {
  const innerType = propType.slice('Collection('.length, -1)
  const innerSchema = metadataIndex.schemas[stripNs(innerType)]
  if (innerSchema === undefined) return v
  return v.map((item) =>
    typeof item === 'object' && item !== null
      ? transformDatesToWire(item as Record<string, unknown>, innerSchema, tz, metadataIndex, dateMode)
      : item,
  )
}

/** Recurse into a single nested ComplexType field. */
function transformNestedComplex(
  v: Record<string, unknown>,
  propType: string,
  tz: string,
  metadataIndex: MetadataIndex,
  dateMode: 'date' | 'string',
  stripNs: (t: string) => string,
): unknown {
  const innerSchema = metadataIndex.schemas[stripNs(propType)]
  if (innerSchema === undefined) return v
  return transformDatesToWire(v, innerSchema, tz, metadataIndex, dateMode)
}

/**
 * Transform write payload: convert JS Date instances and nulls in Edm.DateTime
 * fields into wire form. Mirror of read-side parser's DateTime branch.
 *
 * - Date instance → formatInZone(d, tz) in server timezone (naive ISO without offset)
 * - null → ONEC_EMPTY_DATE sentinel
 * - string → passthrough (user already formatted)
 * - undefined → omit field (do not include in output)
 *
 * Schema-declared fields: only Edm.DateTime is transformed, other declared
 * types pass through unchanged (the schema knows best). Fields ABSENT from
 * the schema (forward-compat: a newer server added a field) fall back to the
 * value heuristic — `Date` instances convert via `transformDateValuesUntyped`.
 * Recursive for nested entities (tabular parts and single nested ComplexType).
 *
 * In `dateMode: 'string'` mode this function is a no-op — full passthrough.
 *
 * @internal
 */
export function transformDatesToWire(
  body: Record<string, unknown>,
  schema: EntitySchema,
  tz: string,
  metadataIndex: MetadataIndex,
  dateMode: 'date' | 'string',
): Record<string, unknown> {
  if (dateMode === 'string') return body

  const stripNs = makeStripNs(metadataIndex)
  const out: Record<string, unknown> = {}
  for (const [name, v] of Object.entries(body)) {
    const propType = schema.properties[name]?.type

    if (propType === 'Edm.DateTime') {
      if (v === undefined) continue
      out[name] = transformDateTime(v, tz)
      continue
    }

    // Unknown field (newer server schema) — value heuristic, same as the
    // schema-less write path.
    if (propType === undefined) {
      out[name] = transformDateValuesUntyped(v, tz)
      continue
    }

    // `Collection(Edm.DateTime)` not handled — 0 empirical occurrences in real 1С EDMX.
    // See packages/cli/src/codegen/emitter/entity.ts for the full design rationale.
    if (Array.isArray(v) && propType?.startsWith('Collection(')) {
      out[name] = transformCollection(v, propType, tz, metadataIndex, dateMode, stripNs)
      continue
    }

    if (
      typeof v === 'object' &&
      v !== null &&
      !Array.isArray(v) &&
      propType !== undefined &&
      !propType.startsWith('Edm.') &&
      !propType.startsWith('Collection(')
    ) {
      // Nested ComplexType — propType is `<ns>.SomeComplex`
      out[name] = transformNestedComplex(v as Record<string, unknown>, propType, tz, metadataIndex, dateMode, stripNs)
      continue
    }

    out[name] = v
  }
  return out
}
