import {
  type DataShape,
  DEFAULT_SHAPE,
  type EntitySchema,
  type MetadataIndex,
  type NavigationSchema,
  type PropertySchema,
} from '@1c-odata/client'
import { setOwn } from '@1c-odata/client/internal'
import { computeClosure } from './analysis/closure.js'
import { detectValueStorage } from './analysis/value-storage.js'
import type { EdmxModel } from './parser/ast.js'
import { navigationTargetEnd } from './parser/edmx-parser.js'

/**
 * Build per-property constraint records for every EntityType + ComplexType.
 * Includes ValueStorage bases for EntityTypes.
 * Keys are the type's local name (no `<schemaNamespace>.` prefix). Consumed
 * by the runtime client for response validation / shaping.
 */
function buildSchemas(model: EdmxModel, keep?: (typeName: string) => boolean): Record<string, EntitySchema> {
  // Names from the EDMX are written as own keys (`setOwn`): a type or property named `__proto__` is an entry,
  // not the dictionary's prototype.
  const out: Record<string, EntitySchema> = {}
  for (const t of [...model.entityTypes, ...model.complexTypes]) {
    if (keep !== undefined && !keep(t.name)) continue
    const props: Record<string, PropertySchema> = {}
    for (const p of t.properties) {
      const ps: PropertySchema = { type: p.type, nullable: p.nullable }
      if (p.maxLength !== undefined) ps.maxLength = p.maxLength
      setOwn(props, p.name, ps)
    }
    const schema: EntitySchema = { properties: props }
    // Only EntityTypes have value storages (ComplexTypes don't have them in practice)
    if ('key' in t) {
      const valueStoragesSet = detectValueStorage(t)
      if (valueStoragesSet.size > 0) schema.valueStorages = [...valueStoragesSet].sort()
    }
    setOwn(out, t.name, schema)
  }
  addNavigation(model, out)
  return out
}

/**
 * Record each EntityType's navigation properties in its schema — after every
 * schema exists, a target may come later in the EDMX. The target is the one
 * `parseEdmx` resolved (`resolvedTargetType`, as the closure and codegen read
 * it); only a navigation whose target is a type `schemas` holds is written
 * (the filter's closure keeps every target of a kept entity): one naming no
 * schema would read schema-less either way. `collection: true` where the
 * target end's multiplicity is `*`; 1С declares every navigation `0..1`, so
 * none carries it. A type named twice gets the navigations of its last
 * declaration, as its schema is (`buildSchemas`). The key goes after
 * `valueStorages`, leaving the rest of `__metadata.json` byte-for-byte as it
 * was.
 */
function addNavigation(model: EdmxModel, schemas: Record<string, EntitySchema>): void {
  const prefix = `${model.schemaNamespace}.`
  const assocByName = new Map(model.associations.map((a) => [a.name, a]))
  for (const t of model.entityTypes) {
    if (!Object.hasOwn(schemas, t.name)) continue
    const schema = schemas[t.name] as EntitySchema
    const navigation: Record<string, NavigationSchema> = {}
    for (const np of t.navigationProperties) {
      const targetType = np.resolvedTargetType
      if (targetType === undefined || !targetType.startsWith(prefix)) continue
      const target = targetType.slice(prefix.length)
      if (!Object.hasOwn(schemas, target)) continue
      const many = navigationTargetEnd(np, assocByName)?.multiplicity === '*'
      setOwn(navigation, np.name, many ? { type: target, collection: true } : { type: target })
    }
    if (Object.keys(navigation).length > 0) schema.navigation = navigation
    else delete schema.navigation
  }
}

/**
 * Build a runtime lookup map from EntitySet name to EntityType local name.
 * The EDMX `EntitySet.EntityType` attribute is fully qualified (e.g.
 * `StandardODATA.Catalog_X`); strip the schema-namespace prefix.
 *
 * Only sets whose type `schemas` holds — the filter's closure among them: a set
 * whose type lies in another namespace or is missing from the EDMX would name
 * a type no schema stands for, and `parseMetadataIndex` refuses such an index
 * whole. Without a schema the set reads and writes schema-less either way.
 */
function buildEntitySetToType(model: EdmxModel, schemas: Record<string, EntitySchema>): Record<string, string> {
  const prefix = `${model.schemaNamespace}.`
  const out: Record<string, string> = {}
  for (const set of model.entityContainer.entitySets) {
    const localName = set.entityType.startsWith(prefix) ? set.entityType.slice(prefix.length) : set.entityType
    if (!Object.hasOwn(schemas, localName)) continue
    setOwn(out, set.name, localName)
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
  const schemas = buildSchemas(model, keep)
  return {
    schemaNamespace: model.schemaNamespace,
    schemas,
    entitySetToType: buildEntitySetToType(model, schemas),
    shape,
    enums: buildEnums(model),
  }
}
