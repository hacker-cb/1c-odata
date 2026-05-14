import type { DataShape } from '@1c-odata/client'
import type { ClosureResult } from './analysis/closure.js'
import { detectValueStorage } from './analysis/value-storage.js'
import type { EdmxModel } from './parser/ast.js'
import { KIND_ORDER, type Kind } from './parser/classifier.js'

interface PropertySchema {
  type: string
  nullable: boolean
  maxLength?: number
}

interface TypeSchema {
  properties: Record<string, PropertySchema>
  valueStorages?: string[]
}

/**
 * Build per-property constraint records for every EntityType + ComplexType.
 * Includes ValueStorage bases for EntityTypes.
 * Keys are the type's local name (no `<schemaNamespace>.` prefix). Consumed
 * by the runtime client for response validation / shaping.
 */
function buildSchemas(model: EdmxModel): Record<string, TypeSchema> {
  const out: Record<string, TypeSchema> = {}
  for (const t of [...model.entityTypes, ...model.complexTypes]) {
    const props: Record<string, PropertySchema> = {}
    for (const p of t.properties) {
      const ps: PropertySchema = { type: p.type, nullable: p.nullable }
      if (p.maxLength !== undefined) ps.maxLength = p.maxLength
      props[p.name] = ps
    }
    const schema: TypeSchema = { properties: props }
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
function buildEntitySetToType(model: EdmxModel): Record<string, string> {
  const prefix = `${model.schemaNamespace}.`
  const out: Record<string, string> = {}
  for (const set of model.entityContainer.entitySets) {
    const localName = set.entityType.startsWith(prefix) ? set.entityType.slice(prefix.length) : set.entityType
    out[set.name] = localName
  }
  return out
}

/**
 * Build enum catalog for `__metadata.json`. Maps each EnumType to its
 * underlyingType and members (with numeric values).
 *
 * Duplicate EnumType names (1С `trade.xml` ships `AllowedLength` twice) are
 * deduped first-occurrence-wins to stay consistent with `emitEnumsFile` —
 * otherwise `__metadata.json` would describe a different enum than `enums.ts`
 * does for the same name.
 */
function buildEnums(
  model: EdmxModel,
): Record<string, { underlyingType: string; members: { name: string; value?: number }[] }> {
  // Null-prototype dict — avoids prototype-pollution if any EnumType ever
  // happens to be named e.g. `__proto__` or `constructor` (defensive; not
  // observed in 1С EDMX). Combined with Object.hasOwn so the `in` check
  // can't leak through the prototype chain.
  const out = Object.create(null) as Record<
    string,
    { underlyingType: string; members: { name: string; value?: number }[] }
  >
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
 * Build the `__metadata.json` payload — a normalized snapshot of the model
 * useful for debugging diff between snapshots and tracking schema drift.
 *
 * `headerCountsByKind` reflects what the coordinator ACTUALLY emits as a header
 * file (header entity, classified by kind, not in `tabularToHeader`). Register
 * headers have composite dimension keys (not `Ref_Key`), so a key-shape filter
 * here would always count them as 0 — the coordinator passes the authoritative
 * counts in.
 */
export function normalizeModel(
  model: EdmxModel,
  headerCountsByKind: Record<Kind, number>,
  closure: ClosureResult,
  shape: DataShape,
  inputs?: { metadata: string; options: string; cliVersion: string },
): string {
  // Re-emit in canonical KIND_ORDER for deterministic JSON key order.
  const headerCounts: Record<Kind, number> = Object.fromEntries(
    KIND_ORDER.map((k) => [k, headerCountsByKind[k] ?? 0]),
  ) as Record<Kind, number>
  const closureSection = {
    seedSize: closure.seed.size,
    totalEntities: closure.entities.size,
    totalComplexTypes: closure.complexTypes.size,
    additions: closure.additions,
  }
  const payload = {
    schemaNamespace: model.schemaNamespace,
    ...(inputs !== undefined ? { inputs } : {}),
    entityTypeCount: model.entityTypes.length,
    complexTypeCount: model.complexTypes.length,
    enumTypeCount: model.enumTypes.length,
    associationCount: model.associations.length,
    entitySetCount: model.entityContainer.entitySets.length,
    functionImportCount: model.entityContainer.functionImports.length,
    headerCounts,
    closure: closureSection,
    schemas: buildSchemas(model),
    entitySetToType: buildEntitySetToType(model),
    enums: buildEnums(model),
    shape,
  }
  return JSON.stringify(payload, null, 2)
}
