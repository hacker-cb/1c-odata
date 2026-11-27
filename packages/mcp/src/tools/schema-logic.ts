import type { MetadataIndex } from '@1c-odata/client'
import { schemaOfType } from '@1c-odata/client/internal'
import { classifyEntity, type EdmxModel, tailName } from '@1c-odata/metadata'

/** Pure schema-query helpers shared by the schema tools — no I/O, easy to test. */

/**
 * An entity type's name without its kind prefix (`Catalog_Валюты` → `Валюты`);
 * a type of no known kind keeps its whole name — `tailName` would cut it at
 * its first underscore (`__proto__` → `_proto__`). Every 1С type has a kind.
 */
function shortName(entityType: string): string {
  return classifyEntity(entityType) === null ? entityType : tailName(entityType)
}

export interface EntityListItem {
  entitySet: string
  entityType: string
  kind: string | null
  name: string
}

/** Entity sets of a base, filtered by kind and a name substring, sorted by set name. */
export function selectEntities(
  index: MetadataIndex,
  opts: { kind?: string | undefined; name?: string | undefined } = {},
): EntityListItem[] {
  const needle = opts.name?.toLowerCase()
  return Object.entries(index.entitySetToType)
    .map(([entitySet, entityType]) => ({
      entitySet,
      entityType,
      kind: classifyEntity(entityType),
      name: shortName(entityType),
    }))
    .filter((e) => (opts.kind === undefined ? true : e.kind === opts.kind))
    .filter((e) =>
      needle === undefined ? true : e.entitySet.toLowerCase().includes(needle) || e.name.toLowerCase().includes(needle),
    )
    .sort((a, b) => a.entitySet.localeCompare(b.entitySet))
}

export interface EntityProperty {
  name: string
  type: string
  nullable: boolean
  maxLength?: number
}

export interface EntityNavProp {
  name: string
  targetType?: string
}

export interface EntityDescription {
  entitySet: string | null
  entityType: string
  kind: string | null
  name: string
  keys: string[]
  properties: EntityProperty[]
  navigationProperties: EntityNavProp[]
  valueStorages: string[]
}

/**
 * Describe one entity by an entity-set OR entity-type name. Properties + value
 * storages come from the {@link MetadataIndex}; keys + navigation properties
 * from the {@link EdmxModel}. Throws when the name resolves to neither.
 */
export function describeEntity(index: MetadataIndex, edmx: EdmxModel, entity: string): EntityDescription {
  // `entity` is a tool argument and these maps are plain objects: own keys only, so a key like
  // "__proto__"/"constructor" never resolves up the prototype chain. Schemas go through the client's own-key
  // lookup (the one the read and write paths use). A set is looked up by its own key alone, whether or not the
  // index holds its type's schema: list_entities lists every set, and each one it lists describes.
  const mappedType = Object.hasOwn(index.entitySetToType, entity) ? index.entitySetToType[entity] : undefined
  let entityType: string
  let entitySet: string | null
  if (mappedType !== undefined) {
    entitySet = entity
    entityType = mappedType
  } else if (schemaOfType(index, entity) !== undefined) {
    entityType = entity
    entitySet = Object.keys(index.entitySetToType).find((s) => index.entitySetToType[s] === entity) ?? null
  } else {
    throw new Error(`Unknown entity "${entity}". Use list_entities to discover names.`)
  }

  const schema = schemaOfType(index, entityType)
  const properties: EntityProperty[] = Object.entries(schema?.properties ?? {}).map(([propName, p]) => ({
    name: propName,
    type: p.type,
    nullable: p.nullable,
    ...(p.maxLength !== undefined ? { maxLength: p.maxLength } : {}),
  }))
  const edmxType = edmx.entityTypes.find((t) => t.name === entityType)
  const navigationProperties: EntityNavProp[] = (edmxType?.navigationProperties ?? []).map((np) => ({
    name: np.name,
    ...(np.resolvedTargetType !== undefined ? { targetType: np.resolvedTargetType } : {}),
  }))

  return {
    entitySet,
    entityType,
    kind: classifyEntity(entityType),
    name: shortName(entityType),
    keys: edmxType?.key ?? [],
    properties,
    navigationProperties,
    valueStorages: schema?.valueStorages ?? [],
  }
}
