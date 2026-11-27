// packages/client/src/schema-lookup.ts

import type { EntitySchema, MetadataIndex } from './validate.js'

/**
 * The one rule for finding a schema in a `MetadataIndex` — the read path
 * (`parser.ts`), the write path (`v3-client.ts`, `write-transform.ts`) and the
 * filter DSL (`v3-query.ts`, `query/filter-internal.ts`) all look it up here.
 *
 * Own keys only: `schemas` and `entitySetToType` are plain objects (a parsed
 * `__metadata.json`, a built index, or one a caller assembled), so an
 * inherited name — `constructor`, `toString`, `__proto__` — names no entity
 * set and no type. A name the index does not hold resolves to `undefined`, and
 * the caller goes on schema-less, as it does without an index.
 *
 * Reached through `@1c-odata/client/internal` (the MCP schema tools look
 * names up by it too), so these functions carry no internal tag: `stripInternal`
 * would drop them from that entrypoint's types.
 */
export function schemaOfType(index: MetadataIndex | undefined, typeName: string | undefined): EntitySchema | undefined {
  if (index === undefined || typeName === undefined || !Object.hasOwn(index.schemas, typeName)) return undefined
  return index.schemas[typeName]
}

/**
 * The EntityType local name of `entitySet` — `undefined` without an index, for
 * a set it does not list (a virtual-table path such as
 * `Register_X/SliceLast()` among them), or for a set whose type it holds no
 * schema for.
 */
export function typeNameOfSet(index: MetadataIndex | undefined, entitySet: string): string | undefined {
  if (index === undefined || !Object.hasOwn(index.entitySetToType, entitySet)) return undefined
  const typeName = index.entitySetToType[entitySet]
  return schemaOfType(index, typeName) !== undefined ? typeName : undefined
}

/**
 * The EntityType schema of `entitySet` — {@link typeNameOfSet}, then its schema.
 */
export function schemaOfSet(index: MetadataIndex | undefined, entitySet: string): EntitySchema | undefined {
  return schemaOfType(index, typeNameOfSet(index, entitySet))
}

/**
 * The local type name a declared property type refers to — `<ns>.Foo` or
 * `Collection(<ns>.Foo)` → `Foo` — where the index holds a schema for it.
 * `undefined` for a primitive (`Edm.*`, `Collection(Edm.*)`), or a type absent
 * from the index: the caller then reads the value schema-less rather than with
 * another type's schema.
 */
export function typeNameOfRef(index: MetadataIndex | undefined, typeRef: string | undefined): string | undefined {
  if (index === undefined || typeRef === undefined) return undefined
  let t = typeRef
  if (t.startsWith('Collection(') && t.endsWith(')')) t = t.slice('Collection('.length, -1)
  if (t.startsWith('Edm.')) return undefined
  const prefix = `${index.schemaNamespace}.`
  const local = t.startsWith(prefix) ? t.slice(prefix.length) : t
  return schemaOfType(index, local) !== undefined ? local : undefined
}

/**
 * The schema a declared property type refers to — {@link typeNameOfRef}, then
 * its schema.
 */
export function schemaOfRef(index: MetadataIndex | undefined, typeRef: string | undefined): EntitySchema | undefined {
  return schemaOfType(index, typeNameOfRef(index, typeRef))
}
