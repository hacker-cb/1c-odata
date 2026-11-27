// packages/client/src/read-format.ts

import { schemaOfType, typeNameOfNavigation } from './schema-lookup.js'
import type { EntitySchema, MetadataIndex } from './validate.js'

/** The JSON the client reads by default: no annotations at all. */
export const NOMETADATA_JSON = 'application/json;odata=nometadata'

/**
 * The JSON a read asks for where its reply carries a ValueStorage: in
 * `nometadata` 1С sends a storage's `<X>_Base64Data` but withholds its
 * `<X>_Type`, so the parser could never group the two into `<X>` (#289).
 * `minimalmetadata` brings `_Type` at the price of an `odata.metadata` in the
 * root and a `<Nav>@navigationLinkUrl` per navigation in each row — both
 * dropped by the parser — measured at +5–45 % on sets with storages and up to
 * +130 % on registers, which is why it is asked for only where needed.
 */
export const MINIMALMETADATA_JSON = 'application/json;odata=minimalmetadata'

/** The `$select` / `$expand` of a read — the query's, or none for a single entity. */
export interface ReadShape {
  select?: readonly string[] | undefined
  expand?: readonly string[] | undefined
}

/**
 * The JSON format to read a reply of `typeName` in — `$format` and `Accept`
 * alike: {@link MINIMALMETADATA_JSON} where the index says the reply carries a
 * ValueStorage, {@link NOMETADATA_JSON} otherwise, and always without an index
 * or for a type it does not hold (a register virtual table among them).
 *
 * A storage is in the reply where the row's type has one and the `$select` is
 * empty, `*` / `**`, or names a storage's base or either half; or where an
 * `$expand` path reaches (through `EntitySchema.navigation`) a type that has
 * one and the `$select` keeps that entity whole (it is empty, or names the path
 * itself or `<path>/*`) or names a storage of it (`<path>/<base or half>`).
 */
export function readFormat(
  index: MetadataIndex | undefined,
  typeName: string | undefined,
  shape: ReadShape = {},
): string {
  const root = schemaOfType(index, typeName)
  if (index === undefined || root === undefined) return NOMETADATA_JSON
  const select = names(shape.select)
  if (carriesStorage(root, select, '')) return MINIMALMETADATA_JSON
  for (const path of names(shape.expand)) {
    let schema: EntitySchema | undefined = root
    let prefix = ''
    for (const segment of path.split('/')) {
      const target = typeNameOfNavigation(index, schema, segment)
      schema = schemaOfType(index, target)
      if (schema === undefined) break
      prefix = prefix === '' ? segment : `${prefix}/${segment}`
      if (carriesStorage(schema, select, prefix)) return MINIMALMETADATA_JSON
    }
  }
  return NOMETADATA_JSON
}

/**
 * Whether the entity at `prefix` (`''` for the row itself, else an `$expand`
 * path) comes back with one of `schema`'s storages under `select`.
 */
function carriesStorage(schema: EntitySchema, select: readonly string[], prefix: string): boolean {
  const storages = schema.valueStorages ?? []
  if (storages.length === 0) return false
  if (select.length === 0) return true
  const at = prefix === '' ? '' : `${prefix}/`
  if (prefix !== '' && select.includes(prefix)) return true
  const level = select
    .filter((n) => n.startsWith(at) && !n.slice(at.length).includes('/'))
    .map((n) => n.slice(at.length))
  if (level.includes('*') || (prefix === '' && level.includes('**'))) return true
  return storages.some((b) => level.includes(b) || level.includes(`${b}_Base64Data`) || level.includes(`${b}_Type`))
}

/** The names of a `$select` / `$expand` list, trimmed, blank ones dropped — as the URL writes them. */
function names(list: readonly string[] | undefined): readonly string[] {
  if (list === undefined) return []
  return list.map((n) => String(n ?? '').trim()).filter((n) => n !== '')
}
