import {
  type DataShape,
  DEFAULT_SHAPE,
  type EntitySchema,
  type MetadataIndex,
  type PropertySchema,
} from '@1c-odata/client'
import { computeClosure } from './analysis/closure.js'
import { detectValueStorage } from './analysis/value-storage.js'
import type { EdmxModel } from './parser/ast.js'

/**
 * Build per-property constraint records for every EntityType + ComplexType.
 * Includes ValueStorage bases for EntityTypes.
 * Keys are the type's local name (no `<schemaNamespace>.` prefix). Consumed
 * by the runtime client for response validation / shaping.
 */
function buildSchemas(model: EdmxModel, keep?: (typeName: string) => boolean): Record<string, EntitySchema> {
  const out: Record<string, EntitySchema> = {}
  for (const t of [...model.entityTypes, ...model.complexTypes]) {
    if (keep !== undefined && !keep(t.name)) continue
    const props: Record<string, PropertySchema> = {}
    for (const p of t.properties) {
      const ps: PropertySchema = { type: p.type, nullable: p.nullable }
      if (p.maxLength !== undefined) ps.maxLength = p.maxLength
      props[p.name] = ps
    }
    const schema: EntitySchema = { properties: props }
    // Only EntityTypes have value storages (ComplexTypes don't have them in practice)
    if ('key' in t) {
      const valueStoragesSet = detectValueStorage(t)
      if (valueStoragesSet.size > 0) schema.valueStorages = [...valueStoragesSet].sort()
    }
    out[t.name] = schema
  }
  return out
}

/**
 * Build a runtime lookup map from EntitySet name to EntityType local name.
 * The EDMX `EntitySet.EntityType` attribute is fully qualified (e.g.
 * `StandardODATA.Catalog_X`); strip the schema-namespace prefix.
 */
function buildEntitySetToType(model: EdmxModel, keep?: (typeName: string) => boolean): Record<string, string> {
  const prefix = `${model.schemaNamespace}.`
  const out: Record<string, string> = {}
  for (const set of model.entityContainer.entitySets) {
    const localName = set.entityType.startsWith(prefix) ? set.entityType.slice(prefix.length) : set.entityType
    if (keep !== undefined && !keep(localName)) continue
    out[set.name] = localName
  }
  return out
}

/**
 * Build the enum catalog. Maps each EnumType to its underlyingType and
 * members (with numeric values).
 *
 * Duplicate EnumType names (1С `trade.xml` ships `AllowedLength` twice) are
 * deduped first-occurrence-wins to stay consistent with `emitEnumsFile` —
 * otherwise the index would describe a different enum than `enums.ts` does
 * for the same name.
 */
function buildEnums(model: EdmxModel): NonNullable<MetadataIndex['enums']> {
  // Null-prototype dict — avoids prototype-pollution if any EnumType ever
  // happens to be named e.g. `__proto__` or `constructor` (defensive; not
  // observed in 1С EDMX). Combined with Object.hasOwn so the `in` check
  // can't leak through the prototype chain.
  const out = Object.create(null) as NonNullable<MetadataIndex['enums']>
  for (const et of model.enumTypes) {
    if (Object.hasOwn(out, et.name)) continue
    out[et.name] = {
      underlyingType: et.underlyingType,
      members: et.members.map((m) => ({
        name: m.name,
        ...(m.value !== undefined ? { value: Number(m.value) } : {}),
      })),
    }
  }
  return out
}

/**
 * Options for {@link buildMetadataIndex}.
 *
 * @public
 */
export interface BuildMetadataIndexOptions {
  /**
   * Data-shape decisions. Resolved to `{ int64Mode: 'number', dateMode:
   * 'date' }` defaults and ALWAYS persisted in the returned index — the
   * runtime parser reads `metadataIndex.shape` to decide conversions, so an
   * absent field would silently mean "no conversion" instead of "documented
   * default".
   */
  shape?: DataShape
  /**
   * Optional entity-type whitelist predicate. When provided, the index is
   * narrowed to the transitive dependency closure of matching types (same
   * expansion codegen applies to `include` globs): `schemas` keeps closure
   * entities + complex types, `entitySetToType` keeps sets whose type is in
   * the closure. Enums are always kept in full (they are global and 1С does
   * not type properties with enum references). Default: the full model.
   */
  filter?: (entityTypeName: string) => boolean
}

/**
 * Build a runtime {@link MetadataIndex} from a parsed EDMX model — the same
 * structure codegen emits as `__metadata.json`, minus the CLI-only debug
 * sections (counts, closure stats, input hashes).
 *
 * This is the single source of truth for the index content: `@1c-odata/cli`
 * composes this function when emitting `__metadata.json`, and runtime
 * consumers call it directly (e.g. after fetching `$metadata` from a live
 * base) to get full date / Int64 / ValueStorage handling and write
 * validation without any generated files.
 *
 * The result is plain JSON-serializable data — safe to cache with
 * `JSON.stringify` / `JSON.parse`.
 *
 * @public
 */
export function buildMetadataIndex(model: EdmxModel, opts: BuildMetadataIndexOptions = {}): MetadataIndex {
  const shape: DataShape = {
    int64Mode: opts.shape?.int64Mode ?? DEFAULT_SHAPE.int64Mode,
    dateMode: opts.shape?.dateMode ?? DEFAULT_SHAPE.dateMode,
  }
  let keep: ((typeName: string) => boolean) | undefined
  if (opts.filter !== undefined) {
    const closure = computeClosure(model, opts.filter)
    keep = (typeName) => closure.entities.has(typeName) || closure.complexTypes.has(typeName)
  }
  return {
    schemaNamespace: model.schemaNamespace,
    schemas: buildSchemas(model, keep),
    entitySetToType: buildEntitySetToType(model, keep),
    shape,
    enums: buildEnums(model),
  }
}
