import type { DateMode } from './connection.js'
import { setOwn } from './own-key.js'
import { schemaOfRef } from './schema-lookup.js'
import { formatInZone } from './timezone.js'
import { ONEC_EMPTY_DATE } from './types/core.js'
import { isDate } from './url-builder.js'
import type { EntitySchema, MetadataIndex } from './validate.js'

/** Transform a single Edm.DateTime field value into wire form. */
function transformDateTime(v: unknown, tz: string): unknown {
  if (v === null) return ONEC_EMPTY_DATE
  if (isDate(v)) return formatInZone(v, tz)
  return v // string passthrough
}

/**
 * Value-based write fallback for fields/bodies with no schema: convert every
 * `Date` — any realm's (`node:vm`) — to naive ISO in the server timezone, recursing into plain
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
  if (isDate(v)) return formatInZone(v, tz)
  if (Array.isArray(v)) return v.map((item) => transformDateValuesUntyped(item, tz))
  // Recurse into plain objects only — of any realm (`node:vm`), so their dates
  // convert too. Exotic objects (Map, Buffer, class instances, a custom
  // prototype) and an object serializing itself (`toJSON`) keep the old
  // passthrough behavior and serialize as before.
  if (typeof v === 'object' && v !== null) {
    if (!isPlainObject(v)) return v
    if (typeof (v as { toJSON?: unknown }).toJSON === 'function') return v
    // fromEntries defines each key as its own — an own `__proto__` field included.
    return Object.fromEntries(
      Object.entries(v)
        .filter(([, value]) => value !== undefined)
        .map(([name, value]) => [name, transformDateValuesUntyped(value, tz)]),
    )
  }
  return v
}

/**
 * An object literal of any realm (`node:vm`): its prototype is none, or a
 * realm's own `Object.prototype` — the root of the chain, whose own
 * `constructor` is that realm's `Object`. A custom prototype, a null-prototype
 * one included, is not.
 */
function isPlainObject(v: object): boolean {
  const proto: unknown = Object.getPrototypeOf(v)
  if (proto === null) return true
  if (typeof proto !== 'object' || Object.getPrototypeOf(proto) !== null) return false
  const ctor: unknown = Object.getOwnPropertyDescriptor(proto, 'constructor')?.value
  return typeof ctor === 'function' && ctor.name === 'Object' && (ctor as { prototype?: unknown }).prototype === proto
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

/** Type guard for the grouped ValueStorage read form `{ contentType, base64Data }`. */
function isValueStorageObject(v: unknown): v is { contentType: string; base64Data: string } {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o.contentType === 'string' && typeof o.base64Data === 'string'
}

/** Recurse into a Collection(<ns>.Foo) field, transforming each element. */
function transformCollection(
  v: unknown[],
  propType: string,
  tz: string,
  metadataIndex: MetadataIndex,
  dateMode: DateMode,
): unknown {
  const innerSchema = schemaOfRef(metadataIndex, propType)
  // A row type the index does not hold is written as without an index — `Date`s found by value.
  if (innerSchema === undefined) return transformDateValuesUntyped(v, tz)
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
  dateMode: DateMode,
): unknown {
  const innerSchema = schemaOfRef(metadataIndex, propType)
  if (innerSchema === undefined) return transformDateValuesUntyped(v, tz)
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
 * ValueStorage fields: the read side groups `<base>_Base64Data` + `<base>_Type`
 * into a single `{ contentType, base64Data }` object under `<base>`. This
 * splits that object back into the two wire halves (same shape `writeStream`
 * PATCHes), so the read form is a valid write form — a natural read → modify →
 * patch round-trip otherwise sends a body 1С does not understand.
 *
 * In `dateMode: 'string'` mode this function is a no-op — full passthrough
 * (the client also short-circuits before calling it, so ValueStorage splitting
 * does not apply in that advanced raw-wire mode; use `writeStream` instead).
 *
 * @internal
 */
export function transformDatesToWire(
  body: Record<string, unknown>,
  schema: EntitySchema,
  tz: string,
  metadataIndex: MetadataIndex,
  dateMode: DateMode,
): Record<string, unknown> {
  if (dateMode === 'string') return body

  // Every key of the body is written as the payload's own field — `__proto__` included (a row read back
  // carries it as one; plain assignment would swap the payload's prototype for it and drop the field).
  const out: Record<string, unknown> = {}
  for (const [name, v] of Object.entries(body)) {
    const propType = schema.properties[name]?.type

    if (propType === 'Edm.DateTime') {
      if (v === undefined) continue
      setOwn(out, name, transformDateTime(v, tz))
      continue
    }

    // Unknown field (newer server schema) — value heuristic, same as the
    // schema-less write path.
    if (propType === undefined) {
      setOwn(out, name, transformDateValuesUntyped(v, tz))
      continue
    }

    // `Collection(Edm.DateTime)` not handled — 0 empirical occurrences in real 1С EDMX.
    // See packages/cli/src/codegen/emitter/entity.ts for the full design rationale.
    if (Array.isArray(v) && propType?.startsWith('Collection(')) {
      setOwn(out, name, transformCollection(v, propType, tz, metadataIndex, dateMode))
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
      setOwn(out, name, transformNestedComplex(v as Record<string, unknown>, propType, tz, metadataIndex, dateMode))
      continue
    }

    setOwn(out, name, v)
  }

  // Split each grouped ValueStorage back into its two wire halves — symmetric
  // with the read-side grouping in parser.ts `mapEntity`. Only EntityTypes carry
  // `valueStorages`; a string/undefined value (the user passed wire halves
  // directly, or cleared the field) is left untouched.
  for (const base of schema.valueStorages ?? []) {
    const grouped = out[base]
    if (isValueStorageObject(grouped)) {
      out[`${base}_Type`] = grouped.contentType
      out[`${base}_Base64Data`] = grouped.base64Data
      delete out[base]
    }
  }

  return out
}
