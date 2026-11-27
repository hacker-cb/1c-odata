import type { DataShape, DateMode } from './connection.js'
import { ODataError, type ODataErrorOptions } from './errors.js'

/**
 * Per-property constraints emitted by codegen into `__metadata.json`.
 * Produced by `buildMetadataIndex` in `@1c-odata/metadata` (see
 * `index-builder.ts`).
 *
 * @public
 */
export interface PropertySchema {
  type: string
  nullable: boolean
  maxLength?: number
}

/**
 * Per-EntityType constraint record. Keyed by property name.
 *
 * @public
 */
export interface EntitySchema {
  properties: Record<string, PropertySchema>
  /** ValueStorage bases (group `<X>` + `<X>_Base64Data` + `<X>_Type` into ValueStorage). */
  valueStorages?: string[]
  /**
   * Navigation properties by name — what an `$expand` of that name brings
   * into the row. Absent where the type has none, and in an index built
   * before it was recorded: an expanded entity is then read schema-less.
   */
  navigation?: Record<string, NavigationSchema>
}

/**
 * A navigation property of an {@link EntitySchema}: the EntityType its
 * `$expand` brings — a local name, keyed like `MetadataIndex.schemas` — and
 * `collection: true` where it brings a collection of them (absent for a single
 * entity, the only kind 1С declares). A `type` the index holds no schema for
 * reads the expanded value schema-less.
 *
 * @public
 */
export interface NavigationSchema {
  type: string
  collection?: true
}

/**
 * Runtime schema index consumed by `ODataV3Client` for schema-driven parsing
 * and write validation. This is a structural contract — the source is not
 * specified: typically the codegen-emitted `__metadata.json`
 * (`loadMetadataIndex`), an index built at runtime from a live `$metadata`
 * (`buildMetadataIndex` / `fetchMetadataIndex` in `@1c-odata/metadata`), or
 * a revived cache entry (`parseMetadataIndex`). Keyed by EntityType *local*
 * name (no `<schema>.` prefix), matching the codegen convention.
 *
 * @public
 */
export interface MetadataIndex {
  /** Schema namespace from EDMX (e.g. 'StandardODATA'). Used for runtime type-reference resolution. */
  schemaNamespace: string
  /** EntityType localName -> property schemas. */
  schemas: Record<string, EntitySchema>
  /** EntitySet name -> EntityType localName. */
  entitySetToType: Record<string, string>
  /** Mirror of codegen-time DataShape decisions. Used by runtime parser. */
  shape?: DataShape
  /**
   * Enum catalog from EDMX. Each entry: list of members (1С EDMX doesn't emit
   * explicit `Value=` attributes, but member order is the canonical 0-indexed
   * mapping). Wire format on V3 OData uses member names as string literals on
   * `Edm.String`-typed properties (1С does NOT type enum-valued fields with
   * `Type="<schema>.<EnumName>"`). See cluster G for typed narrowing helpers
   * built on this catalog.
   *
   * @public
   */
  enums?: Record<string, { underlyingType: string; members: { name: string; value?: number }[] }>
}

/**
 * One issue produced by `validateEntity`.
 *
 * - `maxLength`: a string field exceeded its declared `maxLength`.
 * - `required`: a `nullable: false` field was missing or set to `null`/`undefined`.
 *
 * @public
 */
export type ValidationIssue =
  | { kind: 'maxLength'; field: string; value: string; max: number }
  | { kind: 'required'; field: string }

/**
 * Result of `validateEntity`. Either `{ ok: true }` or `{ ok: false, errors }`.
 *
 * @public
 */
export type ValidationResult = { ok: true } | { ok: false; errors: ValidationIssue[] }

/**
 * Options for {@link validateEntity}. The defaults check a payload as a whole
 * entity, as before they existed.
 *
 * @public
 */
export interface ValidateEntityOptions {
  /**
   * What a non-nullable field the payload does not carry is: `'required'`
   * (default) — read as before, an `undefined` value an issue; `'ignore'` — a
   * field that is not an own enumerable one of the payload (what a write
   * sends), or is `undefined`, is not checked. 1С fills a field a write leaves
   * out itself (`Ref_Key`, `Code` / `Number`, `DataVersion`, dates…) and a
   * `patch()` keeps it, so `Nullable="false"` in its EDMX is no write
   * requirement — `validateOnWrite` checks `create()` / `patch()` with
   * `'ignore'`, and `put()`, which 1С requires to carry every property (docs
   * 17.4: «Для PUT-запроса необходимо указывать значения всех свойств»), with
   * `'required'`.
   */
  missing?: 'required' | 'ignore'
  /**
   * The `dateMode` the payload is written in. Under `'date'` a `null` in a
   * non-nullable `Edm.DateTime` is no issue — the write path sends it as the
   * empty date of 1С (`ONEC_EMPTY_DATE`), the usual way to clear a date; under
   * `'string'` it goes as `null`, and is one. Absent: such a `null` is an
   * issue, as before.
   */
  dateMode?: DateMode
}

/**
 * Validate an entity-shaped object against its schema. Pure function — no I/O.
 *
 * Rules:
 * - Strings exceeding `maxLength` produce a `maxLength` issue.
 * - Missing fields (or `null`/`undefined`) where `nullable: false` produce a
 *   `required` issue.
 * - Unknown fields are ignored (forward-compat with newer server schemas).
 * - Type-shape coercion (Guid/Boolean/numeric) is NOT validated — server is
 *   the source of truth for those.
 * - With `missing: 'ignore'` a field the payload does not carry — not an own
 *   enumerable field of it, or `undefined` — is not checked; one it carries
 *   is: `null` where `nullable: false` is still a `required` issue (save an
 *   `Edm.DateTime` with `dateMode: 'date'`), a string past `maxLength` a
 *   `maxLength` one.
 * - ValueStorage triple members (`<base>`, `<base>_Base64Data`, `<base>_Type`)
 *   are NOT validated. The user-facing grouped form is a single `<base>:
 *   { contentType, base64Data }` object that the write transform splits into
 *   the two wire halves, so the per-half `nullable` flags don't map to it (a
 *   non-nullable `<base>_Type` would otherwise reject a perfectly valid grouped
 *   payload). Binary content presence/format is server-validated.
 *
 * @public
 */
export function validateEntity(
  entity: Record<string, unknown>,
  schema: EntitySchema,
  opts: ValidateEntityOptions = {},
): ValidationResult {
  const errors: ValidationIssue[] = []
  const valueStorageMembers = collectValueStorageMembers(schema)
  const ignoreMissing = opts.missing === 'ignore'
  for (const [name, prop] of Object.entries(schema.properties)) {
    if (valueStorageMembers.has(name)) continue
    // A name `Object.prototype` carries (`__proto__`, `constructor`, …) counts only as the payload's own field:
    // one the payload lacks would read `Object.prototype` / `Object` and pass a `required` check. Every other
    // name reads as before — a getter or a field a `toJSON` adds included.
    // With `missing: 'ignore'` a payload carries only its own enumerable fields — what `JSON.stringify` sends — so
    // an inherited getter is no field of it.
    if (ignoreMissing && !Object.prototype.propertyIsEnumerable.call(entity, name)) continue
    const v = Object.hasOwn(Object.prototype, name) && !Object.hasOwn(entity, name) ? undefined : entity[name]
    if (v === undefined && ignoreMissing) continue
    if (v === null && prop.type === 'Edm.DateTime' && opts.dateMode === 'date') continue
    if (v === undefined || v === null) {
      if (!prop.nullable) errors.push({ kind: 'required', field: name })
      continue
    }
    if (typeof v === 'string' && prop.maxLength !== undefined && v.length > prop.maxLength) {
      errors.push({ kind: 'maxLength', field: name, value: v, max: prop.maxLength })
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}

/** Property names belonging to a ValueStorage triple — excluded from validation. */
function collectValueStorageMembers(schema: EntitySchema): Set<string> {
  const members = new Set<string>()
  for (const base of schema.valueStorages ?? []) {
    members.add(base)
    members.add(`${base}_Base64Data`)
    members.add(`${base}_Type`)
  }
  return members
}

/**
 * Options for ValidationError.
 * @public
 */
export interface ValidationErrorOptions extends ODataErrorOptions {
  issues: ValidationIssue[]
}

/**
 * Thrown by the v3 client (when `validateOnWrite: true`) before a write
 * request is dispatched, when the payload fails `validateEntity`.
 *
 * @public
 */
export class ValidationError extends ODataError {
  override readonly name = 'ValidationError'
  public readonly issues: ValidationIssue[]
  constructor(message: string, opts: ValidationErrorOptions) {
    super(message, opts)
    this.issues = opts.issues
  }
}
