/**
 * Identifier type compatible with `crypto.randomUUID()` shape and 1C `Edm.Guid` strings.
 * @public
 */
export type Guid = `${string}-${string}-${string}-${string}-${string}`

/**
 * Empty reference value in 1C — what `ПустаяСсылка()` returns and what fills
 * default reference fields. Used for explicit comparisons: `if (key !== EMPTY_GUID) ...`.
 * @public
 */
export const EMPTY_GUID = '00000000-0000-0000-0000-000000000000' as const

/**
 * Canonical 1С `Edm.Guid` shape matcher (hex + hyphens, case-insensitive). The
 * single source of truth for "is this string a GUID" across the client — used
 * to decide when a value must be emitted as `guid'…'` (key URLs, function-import
 * refs, `whereIn` / `getByKeys` filters). Keep one copy so every path agrees.
 *
 * @internal
 */
export const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Default value for 1C `Edm.DateTime` (the 1C platform "дата начала отсчёта").
 * Used as the wire-level marker for "no date" in Nullable fields.
 * Library auto-maps this to `null` for Nullable Edm.DateTime fields by default;
 * see spec §2.4 «Значение по умолчанию `Edm.DateTime`».
 *
 * When writing WITHOUT a schema (no `metadataIndex`), `null` is not turned
 * into this sentinel automatically — pass it explicitly to clear a date:
 *
 * @example
 * ```ts
 * await client.entity('Document_X', key).patch({ ДатаОплаты: ONEC_EMPTY_DATE })
 * ```
 *
 * @public
 */
export const ONEC_EMPTY_DATE = '0001-01-01T00:00:00' as const

/**
 * Base shape for all 1C entities (catalog elements, documents, register records).
 * Spec §2.1 lists these as "системные поля единые для всех объектов".
 * @public
 */
export interface Entity {
  Ref_Key: Guid
  DataVersion: string
  DeletionMark: boolean
  Predefined: boolean
  PredefinedDataName: string
}

/**
 * Convenience row type for working WITHOUT codegen: typed 1C system fields
 * (`Ref_Key`, `DataVersion`, …) plus an open index signature for everything
 * else. For object entities (`Catalog_*`, `Document_*`, …) — register
 * recordsets have no system fields, use plain `Record<string, unknown>`
 * there.
 *
 * @example
 * ```ts
 * const { value } = await client.query<UntypedEntity>('Catalog_Номенклатура').top(10).get()
 * for (const row of value) {
 *   row.Ref_Key // Guid — typed, feeds client.entity(set, row.Ref_Key)
 *   row.Артикул // unknown — narrow as needed
 * }
 * ```
 *
 * @public
 */
export type UntypedEntity = Entity & Record<string, unknown>

/**
 * 1C `ХранилищеЗначения` reified as a typed object. Codegen groups the wire-level
 * triple `<X>: Edm.Stream` + `<X>_Base64Data: Edm.Binary` + `<X>_Type: Edm.String`
 * into this shape. Read via `client.entity(...).readStream(...)`;
 * `<X>` itself never arrives inline in JSON. See spec §2.4 + §5.3.
 * @public
 */
export interface ValueStorage {
  readonly contentType: string
  readonly base64Data: string
}
