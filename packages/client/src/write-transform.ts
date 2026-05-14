import { formatInZone } from './timezone.js'
import { ONEC_EMPTY_DATE } from './types/core.js'
import type { EntitySchema, MetadataIndex } from './validate.js'

/** Transform a single Edm.DateTime field value into wire form. */
function transformDateTime(v: unknown, tz: string): unknown {
  if (v === null) return ONEC_EMPTY_DATE
  if (v instanceof Date) return formatInZone(v, tz)
  return v // string passthrough
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
 * Only fields declared as Edm.DateTime in schema are transformed. Other fields
 * pass through unchanged. Recursive for nested entities (tabular parts and
 * single nested ComplexType).
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
