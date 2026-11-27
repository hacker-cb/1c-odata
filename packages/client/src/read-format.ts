// packages/client/src/read-format.ts

import { schemaOfType, typeNameOfNavigation } from './schema-lookup.js'
import { MINIMALMETADATA_JSON, NOMETADATA_JSON, nonBlank } from './url-builder.js'
import type { EntitySchema, MetadataIndex } from './validate.js'

export { MINIMALMETADATA_JSON, NOMETADATA_JSON }

/** The `$select` / `$expand` of a read — the query's, or none for a single entity. */
export interface ReadShape {
  select?: readonly string[] | undefined
  expand?: readonly string[] | undefined
}

/**
 * The JSON format to read a reply of `typeName` in — `$format` and `Accept`
 * alike. In `nometadata` 1С sends a ValueStorage's `<X>_Base64Data` but
 * withholds its `<X>_Type`, so the parser could never group the two into `<X>`
 * (#289); `minimalmetadata` brings `_Type` at the price of an `odata.metadata`
 * in the root and a `<Nav>@navigationLinkUrl` per navigation in each row, both
 * dropped by the parser — measured at +5–45 % on sets with storages and up to
 * +130 % on registers, which is why it is asked for only where a storage is in
 * the reply. Without an index, or for a type it does not hold (a register
 * virtual table among them): {@link NOMETADATA_JSON}.
 *
 * A storage is in the reply where an entity of it comes back with one:
 * - the row, where its type has a storage and the `$select` is empty, holds
 *   `*` / `**`, or names a storage's base or either half;
 * - an entity an `$expand` path reaches through `EntitySchema.navigation` (`*`
 *   ending a path reaches every navigation of its level), where its type has a storage and
 *   the `$select` keeps it whole — is empty, holds a root `*` / `**`, or names
 *   the path, one of its ancestors, or `<that>/*` / `<that>/**` — or names a
 *   storage of it (`<path>/<base or half>`).
 * Where it is unclear whether 1С sends a storage, the heavier format is asked
 * for: it costs bytes, the other costs the field.
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
    const segments = path.split('/').map((s) => s.trim())
    if (expandCarriesStorage(index, root, segments, '', select)) return MINIMALMETADATA_JSON
  }
  return NOMETADATA_JSON
}

/** Whether an entity the `$expand` path `segments` reaches from `schema` comes back with a storage. */
function expandCarriesStorage(
  index: MetadataIndex,
  schema: EntitySchema,
  segments: readonly string[],
  prefix: string,
  select: readonly string[],
): boolean {
  const [segment, ...rest] = segments
  if (segment === undefined || segment === '') return false
  // `*` names every navigation of its level, and only ends a path (1С allows it nowhere else): one inside a
  // path names nothing here, rather than walk every navigation at every level after it.
  if (segment === '*' && rest.length > 0) return false
  const navs = segment === '*' ? Object.keys(schema.navigation ?? {}) : [segment]
  for (const nav of navs) {
    const target = schemaOfType(index, typeNameOfNavigation(index, schema, nav))
    if (target === undefined) continue
    const path = prefix === '' ? nav : `${prefix}/${nav}`
    if (carriesStorage(target, select, path) || expandCarriesStorage(index, target, rest, path, select)) return true
  }
  return false
}

/**
 * Whether the entity at `path` (`''` for the row itself, else an `$expand`
 * path) comes back with one of `schema`'s storages under `select`.
 */
function carriesStorage(schema: EntitySchema, select: readonly string[], path: string): boolean {
  const storages = schema.valueStorages ?? []
  if (storages.length === 0) return false
  if (select.length === 0 || keptWhole(select, path)) return true
  const at = path === '' ? '' : `${path}/`
  const level = select
    .filter((n) => n.startsWith(at) && !n.slice(at.length).includes('/'))
    .map((n) => n.slice(at.length))
  return storages.some((b) => level.includes(b) || level.includes(`${b}_Base64Data`) || level.includes(`${b}_Type`))
}

/** Whether `select` keeps the entity at `path` whole: a root wildcard, or the path or an ancestor named bare or with `/*` / `/**`. */
function keptWhole(select: readonly string[], path: string): boolean {
  if (select.includes('*') || select.includes('**')) return true
  if (path === '') return false
  const segments = path.split('/')
  for (let i = 1; i <= segments.length; i++) {
    const q = segments.slice(0, i).join('/')
    if (select.includes(q) || select.includes(`${q}/*`) || select.includes(`${q}/**`)) return true
  }
  return false
}

/**
 * The names of a `$select` / `$expand` list as 1С reads them from the URL: the
 * list's entries (`nonBlank`, as the URL writes them) joined by commas, so an
 * entry holding several (`'Ref_Key,Файл'`) is several.
 */
function names(list: readonly string[] | undefined): readonly string[] {
  return nonBlank(list).flatMap((n) =>
    n
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
  )
}

/**
 * What a `$select` name of a query on `typeName` becomes on the wire (#286):
 * a ValueStorage's base — of the row (`Файл`) or of an entity an `$expand`
 * path reaches through `EntitySchema.navigation` (`Владелец/Файл`) — as its two
 * halves (`Файл_Base64Data`, `Файл_Type`), since 1С returns a storage only as
 * those; any other name as given. Codegen declares the base alone, so a typed
 * `select` names it. `undefined` without an index or for a type it does not
 * hold: every name goes as given.
 */
export function selectWireNames(
  index: MetadataIndex | undefined,
  typeName: string | undefined,
): ((name: string) => readonly string[]) | undefined {
  const root = schemaOfType(index, typeName)
  if (index === undefined || root === undefined) return undefined
  return (name) => {
    const segments = name.split('/')
    const last = segments.pop() as string
    let schema: EntitySchema | undefined = root
    for (const segment of segments) schema = schemaOfType(index, typeNameOfNavigation(index, schema, segment.trim()))
    if (schema?.valueStorages?.includes(last.trim()) !== true) return [name]
    const at = segments.length === 0 ? '' : `${segments.join('/')}/`
    return [`${at}${last.trim()}_Base64Data`, `${at}${last.trim()}_Type`]
  }
}
