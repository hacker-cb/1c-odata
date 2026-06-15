import type { DataShape } from '@1c-odata/client'
import { buildMetadataIndex, type ClosureResult, type EdmxModel, KIND_ORDER, type Kind } from '@1c-odata/metadata'

/**
 * Build the `__metadata.json` payload — the runtime `MetadataIndex` (built by
 * `@1c-odata/metadata`, the single source of truth shared with runtime
 * consumers) plus CLI-only debug sections useful for diffing snapshots and
 * tracking schema drift (type counts, header counts, closure stats, input
 * hashes).
 *
 * For an `include` run, the same `filter` that drives `.ts` emission is
 * threaded into `buildMetadataIndex` so the runtime index is narrowed to the
 * SAME dependency closure as the generated TypeScript. Without this, an
 * `include` run emitted narrowed `.ts` files but a full-base `__metadata.json`
 * — diverging from both the generated types and `fetchMetadataIndex(conn, {
 * filter })`, and breaking the "all sources produce identical behavior"
 * invariant. For a full-base run `filter` is `undefined`: the index is built
 * unfiltered (byte-identical to the narrowed match-all build, pinned by
 * `metadata-parity`) and the redundant closure walk is skipped.
 *
 * Key order is fixed explicitly so the emitted JSON stays byte-stable across
 * refactors — `metadata-parity` and `metadata-json-schema` tests pin it.
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
  filter: ((entityTypeName: string) => boolean) | undefined,
  shape: DataShape,
  inputs?: { metadata: string; options: string; cliVersion: string },
): string {
  const idx = buildMetadataIndex(model, { shape, ...(filter !== undefined ? { filter } : {}) })
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
    schemaNamespace: idx.schemaNamespace,
    ...(inputs !== undefined ? { inputs } : {}),
    entityTypeCount: model.entityTypes.length,
    complexTypeCount: model.complexTypes.length,
    enumTypeCount: model.enumTypes.length,
    associationCount: model.associations.length,
    entitySetCount: model.entityContainer.entitySets.length,
    functionImportCount: model.entityContainer.functionImports.length,
    headerCounts,
    closure: closureSection,
    schemas: idx.schemas,
    entitySetToType: idx.entitySetToType,
    enums: idx.enums,
    shape: idx.shape,
  }
  return JSON.stringify(payload, null, 2)
}
