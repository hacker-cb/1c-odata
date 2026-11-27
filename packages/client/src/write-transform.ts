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
  if (typeof v !== 'object' || v === null || serializesItself(v)) return false
  const o = v as Record<string, unknown>
  return typeof o.contentType === 'string' && typeof o.base64Data === 'string'
}

/** Whether `v` has a `toJSON` (own or inherited) — `JSON.stringify` sends what it returns, not `v`'s fields. */
function serializesItself(v: object): boolean {
  return typeof (v as { toJSON?: unknown }).toJSON === 'function'
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
 * ValueStorage fields are not this function's: {@link splitValueStorages}
 * writes them back as their wire halves, in every `dateMode`.
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

  return out
}

/**
 * Write every grouped ValueStorage of a write body back as the wire halves 1С
 * edits a storage through (#293) — of the body and of its tabular rows and
 * nested ComplexTypes, as `schema` and `metadataIndex` declare them — so the
 * read form (`parser.ts` `mapEntity`) is a valid write form, in every
 * `dateMode` (a storage is no date):
 * - `{ contentType, base64Data }` → `<base>_Type` + `<base>_Base64Data`;
 * - `null` → `<base>_Base64Data: null`, `<base>_Type` left out — 1С edits a
 *   storage through `_Base64Data` alone, and its docs name no form for
 *   clearing one;
 * - a half the payload sets itself (not `undefined`) wins over `<base>`, the
 *   other half taken from `<base>`: a row read back with new bytes written
 *   into `<base>_Base64Data` keeps them, not the stale `<base>` beside them;
 * - anything else under `<base>` is left as it came.
 * A body, row or value with a `toJSON` serializes itself and is sent as it
 * serializes — nothing in it is split; any other is split over its own
 * enumerable fields (what `JSON.stringify` sends), each read once. An object
 * nothing changes in is returned as it came; a changed one is a plain object.
 *
 * @internal
 */
export function splitValueStorages(
  body: Record<string, unknown>,
  schema: EntitySchema,
  metadataIndex: MetadataIndex,
): Record<string, unknown> {
  if (!carriesStorage(schema, metadataIndex)) return body
  // A body that serializes itself (`toJSON`, read once) goes as it serializes: nothing in it is split. Any other is
  // split over its own enumerable fields — what `JSON.stringify` sends — each read once.
  if (serializesItself(body)) return body
  const fields = new Map(Object.entries(body))
  let changed = false
  for (const [name, v] of fields) {
    const propType = Object.hasOwn(schema.properties, name) ? schema.properties[name]?.type : undefined
    if (propType === undefined || propType.startsWith('Edm.')) continue
    const inner = schemaOfRef(metadataIndex, propType)
    if (inner === undefined || !carriesStorage(inner, metadataIndex)) continue
    if (Array.isArray(v) && propType.startsWith('Collection(')) {
      let rowsChanged = false
      const rows = v.map((row) => {
        if (typeof row !== 'object' || row === null || Array.isArray(row)) return row
        const next = splitValueStorages(row as Record<string, unknown>, inner, metadataIndex)
        if (next !== row) rowsChanged = true
        return next
      })
      if (rowsChanged) {
        fields.set(name, rows)
        changed = true
      }
    } else if (typeof v === 'object' && v !== null && !Array.isArray(v) && !propType.startsWith('Collection(')) {
      const next = splitValueStorages(v as Record<string, unknown>, inner, metadataIndex)
      if (next !== v) {
        fields.set(name, next)
        changed = true
      }
    }
  }
  for (const base of schema.valueStorages ?? []) {
    if (!fields.has(base)) continue
    const grouped = fields.get(base)
    if (grouped !== null && !isValueStorageObject(grouped)) continue
    const b64Key = `${base}_Base64Data`
    const typeKey = `${base}_Type`
    const b64 = fields.get(b64Key) !== undefined ? fields.get(b64Key) : grouped === null ? null : grouped.base64Data
    const type =
      fields.get(typeKey) !== undefined ? fields.get(typeKey) : grouped === null ? undefined : grouped.contentType
    fields.delete(base)
    fields.set(b64Key, b64)
    if (type !== undefined) fields.set(typeKey, type)
    else fields.delete(typeKey)
    changed = true
  }
  if (!changed) return body
  // Fields are written as own keys (`setOwn`) — `__proto__` included.
  const out: Record<string, unknown> = {}
  for (const [k, v] of fields) setOwn(out, k, v)
  return out
}

/**
 * Whether an entity of `schema` can carry a ValueStorage — its own, or one of
 * a tabular row or nested ComplexType it declares, at any depth.
 */
function carriesStorage(schema: EntitySchema, metadataIndex: MetadataIndex, seen = new Set<EntitySchema>()): boolean {
  if ((schema.valueStorages ?? []).length > 0) return true
  if (seen.has(schema)) return false
  seen.add(schema)
  for (const prop of Object.values(schema.properties)) {
    if (prop.type.startsWith('Edm.')) continue
    const inner = schemaOfRef(metadataIndex, prop.type)
    if (inner !== undefined && carriesStorage(inner, metadataIndex, seen)) return true
  }
  return false
}
