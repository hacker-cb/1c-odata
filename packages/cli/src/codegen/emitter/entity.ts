import { detectValueStorage } from '../analysis/value-storage.js'
import type { EdmxEntityType, EdmxNavigationProperty } from '../parser/ast.js'
import { compareCyrillic } from '../util.js'
import { applyNullable, extractCustomSymbols, mapEdmxTypeToTs } from './type-mapper.js'

export interface EntityEmitInput {
  header: EdmxEntityType
  tabulars: EdmxEntityType[]
  schemaNamespace: string
  int64Mode: 'number' | 'bigint' | 'string'
  dateMode: 'date' | 'string'
}

interface EmitContext {
  schemaNamespace: string
  int64Mode: 'number' | 'bigint' | 'string'
  dateMode: 'date' | 'string'
  importsFromCore: Set<string>
  importsLocal: Set<string>
  /** Names of EntityType interfaces emitted in this same file (header + tabulars). */
  ownNames: Set<string>
  tabularNames: Set<string>
}

/**
 * Emit a single TS source file for an entity (header + its tabular parts).
 *
 * Header rules:
 *   - `extends Entity` only when key is exactly `["Ref_Key"]`.
 *   - ValueStorage triple → single `<X>?: ValueStorage | null` field.
 *   - Monotype ref `<X>_Key: Edm.Guid` paired with NavigationProperty `<X>` →
 *     keeps `<X>_Key` and adds optional `<X>?: Target` for `$expand` results.
 *
 * Tabular parts: emitted as plain interfaces in the same file (no `extends Entity`).
 */
export function emitEntityFile(input: EntityEmitInput): string {
  const tabularNames = new Set(input.tabulars.map((t) => t.name))
  const ownNames = new Set<string>([input.header.name, ...tabularNames])
  const ctx: EmitContext = {
    schemaNamespace: input.schemaNamespace,
    int64Mode: input.int64Mode,
    dateMode: input.dateMode,
    importsFromCore: new Set(),
    importsLocal: new Set(),
    ownNames,
    tabularNames,
  }

  const headerBody = renderEntityInterface(input.header, ctx, {
    extendsEntity: input.header.key.length === 1 && input.header.key[0] === 'Ref_Key',
  })

  const tabularBodies = input.tabulars.map((t) =>
    renderEntityInterface(t, ctx, {
      extendsEntity: false,
    }),
  )

  // Build imports block — one consolidated `import type` per source module so
  // we don't emit dozens of separate single-symbol lines (a header with 30+ nav
  // targets used to produce 30+ lines pointing at `../index.js`).
  const lines: string[] = []
  if (ctx.importsFromCore.size > 0) {
    const sorted = [...ctx.importsFromCore].sort()
    lines.push(`import type { ${sorted.join(', ')} } from '@1c-odata/client'`)
  }
  if (ctx.importsLocal.size > 0) {
    // Local imports — written by the index emitter via re-export. For inline target
    // types referenced by NavigationProperty `resolvedTargetType`, emit a TS
    // ambient reference: we declare the symbols via `import type` from the master
    // index. The coordinator builds `index.ts` so this resolves at tsc time.
    const sorted = [...ctx.importsLocal].sort(compareCyrillic)
    lines.push(`import type { ${sorted.join(', ')} } from '../index.js'`)
  }
  if (lines.length > 0) lines.push('')
  lines.push(headerBody)
  for (const tb of tabularBodies) {
    lines.push('')
    lines.push(tb)
  }
  return `${lines.join('\n')}\n`
}

interface RenderOpts {
  extendsEntity: boolean
}

/**
 * System fields declared by `Entity` in `@1c-odata/client`. When the emitted
 * interface extends `Entity`, these are inherited from the base type — DO NOT
 * redeclare them in the generated interface.
 *
 * Wire reality vs EDMX declaration:
 *   - `Ref_Key`: EDMX consistently `Nullable="false"` across all entity kinds.
 *     Matches wire behavior.
 *   - `DataVersion`, `DeletionMark`, `Predefined`, `PredefinedDataName`:
 *     EDMX declares `Nullable="true"` (the EDMX default) for ALL entity kinds,
 *     not just `ExchangePlan_*`. However, 1С wire reality is that these fields
 *     are NEVER returned as null for normal entity reads. `Entity` interface
 *     declares them as non-nullable.
 *
 * This is a deliberate pragmatic exception — wire-observable behavior trumps
 * EDMX declaration for system fields, matching Prisma's "zero dates not
 * supported" philosophy: opinionated typed clients reject impossible-in-practice
 * states from the type contract for user ergonomics.
 */
const ENTITY_SYSTEM_FIELDS = new Set(['Ref_Key', 'DataVersion', 'DeletionMark', 'Predefined', 'PredefinedDataName'])

function renderEntityInterface(e: EdmxEntityType, ctx: EmitContext, opts: RenderOpts): string {
  const valueStorages = detectValueStorage(e)
  // Drop the `_Base64Data` / `_Type` halves of ValueStorage triples. The base name
  // is NOT skipped — it's rendered as a `ValueStorage` field below.
  const skip = new Set<string>()
  for (const base of valueStorages) {
    skip.add(`${base}_Base64Data`)
    skip.add(`${base}_Type`)
  }
  // When extending `Entity`, the five system fields are inherited from core —
  // skip them at emit time. `Entity` declares them as non-nullable; see the JSDoc
  // on `ENTITY_SYSTEM_FIELDS` for the wire-vs-EDMX exception rationale.
  if (opts.extendsEntity) {
    for (const f of ENTITY_SYSTEM_FIELDS) skip.add(f)
  }

  const lines: string[] = []
  if (opts.extendsEntity) {
    ctx.importsFromCore.add('Entity')
    lines.push(`export interface ${e.name} extends Entity {`)
  } else {
    lines.push(`export interface ${e.name} {`)
  }

  for (const p of e.properties) {
    if (skip.has(p.name)) continue
    if (valueStorages.has(p.name)) {
      ctx.importsFromCore.add('ValueStorage')
      // ValueStorage triple — `<X>` (Edm.Stream) carries the canonical nullability.
      const optional = p.nullable ? '?' : ''
      lines.push(`  ${p.name}${optional}: ${applyNullable('ValueStorage', p.nullable)}`)
      continue
    }
    let ts = mapEdmxTypeToTs(p.type, {
      schemaNamespace: ctx.schemaNamespace,
      int64Mode: ctx.int64Mode,
      dateMode: ctx.dateMode,
    })
    // Collections of tabular row types are emitted with the `_RowType` suffix
    // by the mapper (it just strips the namespace prefix). For Collection fields
    // pointing at known tabulars, drop the suffix so we reference the actual
    // EntityType interface emitted in this same file.
    if (ts.endsWith('_RowType[]')) {
      const candidate = ts.slice(0, -'_RowType[]'.length)
      if (ctx.tabularNames.has(candidate)) ts = `${candidate}[]`
    }
    if (ts === 'Guid') ctx.importsFromCore.add('Guid')
    // Any remaining custom symbols (e.g. an InformationRegister `_RowType`
    // ComplexType referenced by the header's `RecordSet: Collection(...)`)
    // need a local re-export from the connection-root `index.ts`.
    for (const sym of extractCustomSymbols(ts)) {
      if (ctx.ownNames.has(sym)) continue // emitted in the same file
      ctx.importsLocal.add(sym)
    }
    // Edm.DateTime in dateMode='date' is always emitted as `Date | null` regardless
    // of the EDMX `Nullable` attribute. Wire reality: 1С returns the sentinel
    // "0001-01-01T00:00:00" for empty values even on Nullable="false" Edm.DateTime
    // fields (empirically 629 cases in InformationRegister_*.Period), and the
    // runtime parser maps that sentinel → null. In dateMode='string' (passthrough)
    // we stay strict EDMX — `applyNullable` produces `string` (no `| null`).
    // Scalar Edm.DateTime only — `Collection(Edm.DateTime)` deliberately not handled here:
    // 0 occurrences in real 1С EDMX (verified across trade_v11.5/bp_v3.0). Falls back
    // to `applyNullable(Date[], p.nullable)`. If a real case ever surfaces, the proper emit
    // would be `(Date | null)[] | null` (per-element + whole-collection nullable) plus
    // parser/write-transform recursion — out of scope for cluster A.
    const isDateTimeAuto = ctx.dateMode === 'date' && p.type === 'Edm.DateTime'
    if (p.maxLength !== undefined) {
      lines.push('  /**')
      lines.push(`   * @maxLength ${p.maxLength}`)
      lines.push('   */')
    }
    // Optionality follows the EDMX `Nullable` attribute. `<X>_Key` Edm.Guid
    // properties marked `Nullable="false"` stay required (matches spec §5.2 example).
    // Edm.DateTime in dateMode='date' is forced optional+nullable per the comment above.
    const optional = p.nullable || isDateTimeAuto ? '?' : ''
    const tsTyped = isDateTimeAuto ? `${ts} | null` : applyNullable(ts, p.nullable)
    lines.push(`  ${p.name}${optional}: ${tsTyped}`)
  }

  for (const np of e.navigationProperties) {
    appendNavigationProperty(np, ctx, lines)
  }

  lines.push('}')
  return lines.join('\n')
}

function appendNavigationProperty(np: EdmxNavigationProperty, ctx: EmitContext, lines: string[]): void {
  if (!np.resolvedTargetType) {
    lines.push(`  ${np.name}?: unknown`)
    return
  }
  const prefix = `${ctx.schemaNamespace}.`
  const targetTail = np.resolvedTargetType.startsWith(prefix)
    ? np.resolvedTargetType.slice(prefix.length)
    : np.resolvedTargetType
  // Skip self-imports — Catalog_Валюты has a NavigationProperty pointing back at
  // itself (`ОсновнаяВалюта_Key` ⇒ `ОсновнаяВалюта: Catalog_Валюты`). TS allows
  // self-referential interfaces; importing a symbol that's defined locally would
  // collide.
  if (!ctx.ownNames.has(targetTail)) ctx.importsLocal.add(targetTail)
  // Always emit `| null` — when the target ref is an empty Guid
  // (00000000-0000-0000-0000-000000000000), 1С returns `null` on $expand and
  // emits a sibling `<NP>@navigationLinkUrl` instead. Multiplicity '0..1' is
  // empirically total in real EDMX (e.g. 8547/8547 NavigationProperties in
  // trade_v11.5), so there's no `1..1` branch to preserve.
  lines.push(`  ${np.name}?: ${targetTail} | null`)
}
