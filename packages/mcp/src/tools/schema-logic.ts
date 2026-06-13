import type { MetadataIndex } from '@1c-odata/client'
import { classifyEntity, type EdmxModel, tailName } from '@1c-odata/metadata'

/** Pure schema-query helpers shared by the schema tools — no I/O, easy to test. */

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
      name: tailName(entityType),
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
  const mappedType = index.entitySetToType[entity]
  let entityType: string
  let entitySet: string | null
  if (mappedType !== undefined) {
    entitySet = entity
    entityType = mappedType
  } else if (index.schemas[entity] !== undefined) {
    entityType = entity
    entitySet = Object.keys(index.entitySetToType).find((s) => index.entitySetToType[s] === entity) ?? null
  } else {
    throw new Error(`Unknown entity "${entity}". Use list_entities to discover names.`)
  }

  const schema = index.schemas[entityType]
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
    name: tailName(entityType),
    keys: edmxType?.key ?? [],
    properties,
    navigationProperties,
    valueStorages: schema?.valueStorages ?? [],
  }
}
