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
 * Default value for 1C `Edm.DateTime` (the 1C platform "дата начала отсчёта").
 * Used as the wire-level marker for "no date" in Nullable fields.
 * Library auto-maps this to `null` for Nullable Edm.DateTime fields by default;
 * see spec §2.4 «Значение по умолчанию `Edm.DateTime`».
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
