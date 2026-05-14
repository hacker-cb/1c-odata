import type { DataShape } from './connection.js'
import { ODataError, type ODataErrorOptions } from './errors.js'

/**
 * Per-property constraints emitted by codegen into `__metadata.json`.
 * Mirrors `PropertySchema` in `@1c-odata/cli/codegen` (see `normalize.ts`).
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
}

/**
 * Runtime schema index loaded from the codegen-emitted `__metadata.json` and
 * passed to the `ODataV3Client` when `validateOnWrite: true`. Keyed by
 * EntityType *local* name (no `<schema>.` prefix), matching the codegen
 * convention.
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
 * Validate an entity-shaped object against its schema. Pure function — no I/O.
 *
 * Rules:
 * - Strings exceeding `maxLength` produce a `maxLength` issue.
 * - Missing fields (or `null`/`undefined`) where `nullable: false` produce a
 *   `required` issue.
 * - Unknown fields are ignored (forward-compat with newer server schemas).
 * - Type-shape coercion (Guid/Boolean/numeric) is NOT validated — server is
 *   the source of truth for those.
 *
 * @public
 */
export function validateEntity(entity: Record<string, unknown>, schema: EntitySchema): ValidationResult {
  const errors: ValidationIssue[] = []
  for (const [name, prop] of Object.entries(schema.properties)) {
    const v = entity[name]
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
