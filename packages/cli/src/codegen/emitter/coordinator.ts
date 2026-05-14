import type { DataShape } from '@1c-odata/client'
import { computeClosure } from '../analysis/closure.js'
import { linkTabularParts } from '../analysis/tabular-parts.js'
import { buildNameFilter } from '../name-filter.js'
import { normalizeModel } from '../normalize.js'
import type { EdmxComplexType, EdmxEntityType } from '../parser/ast.js'
import { classifyEntity, KIND_ORDER, KIND_TO_FOLDER, type Kind, tailName } from '../parser/classifier.js'
import { parseEdmx } from '../parser/edmx-parser.js'
import { emitComplexTypesFile } from './complex.js'
import { emitConnectionClientFile } from './connection-client.js'
import { emitConstantFile } from './constant.js'
import { emitEntityFile } from './entity.js'
import { emitEnumsFile } from './enums.js'
import { emitFunctionImportsFile } from './function-import.js'
import { emitKindIndex, emitMasterIndex } from './index-emitter.js'

export interface GenerateOptions extends DataShape {
  /** Whitelist of entity-type names. Globs supported. Closure auto-expands. */
  include?: string[]
}

export interface GenerateInput extends GenerateOptions {
  metadata: string
  /**
   * Per-connection input fingerprint embedded verbatim in `__metadata.json`.
   * Computed by the CLI orchestrator (`runGenerate`) and threaded through
   * unchanged. Codegen does not interpret it; it only embeds it.
   */
  inputs?: {
    metadata: string
    options: string
    cliVersion: string
  }
}

export interface GenerateResult {
  files: Map<string, string>
}

/**
 * Generate TypeScript files from a 1C OData EDMX XML string. Pure — no I/O.
 *
 * Output layout (Map keys are POSIX paths relative to the connection root):
 *   <kind-folder>/<TailName>.ts        — one per header entity (Ref_Key-only key)
 *   <kind-folder>/index.ts             — re-exports for the folder (always present)
 *   complex-types.ts                   — if any standalone ComplexTypes
 *   function-imports.ts                — if any FunctionImports
 *   index.ts                           — master re-export
 *   __metadata.json                    — normalized index for debugging
 */
export function generate(input: GenerateInput): GenerateResult {
  if (typeof input.metadata !== 'string') throw new TypeError('metadata must be a string')

  const model = parseEdmx(input.metadata)
  const filter = buildNameFilter({
    ...(input.include !== undefined ? { include: input.include } : {}),
  })

  const opts = {
    int64Mode: input.int64Mode ?? 'number',
    dateMode: input.dateMode ?? 'date',
  }

  const files = new Map<string, string>()

  // 1. Group entities by kind + filter by name (using dependency closure)
  const closure = computeClosure(model, filter)
  const kept = model.entityTypes.filter((e) => closure.entities.has(e.name))

  // 2. Link tabular parts to their headers
  const { headerToTabulars, tabularToHeader } = linkTabularParts(kept)
  const keptByName = new Map(kept.map((e) => [e.name, e]))

  // 3. Emit each header entity (or constant) → one file
  const populatedKinds = new Set<Kind>()
  const headerCountsByKind: Record<Kind, number> = Object.fromEntries(KIND_ORDER.map((k) => [k, 0])) as Record<
    Kind,
    number
  >
  for (const e of kept) {
    if (tabularToHeader.has(e.name)) continue // emitted as nested in parent
    const kind = classifyEntity(e.name)
    if (!kind) continue
    const folder = KIND_TO_FOLDER[kind]
    const fileName = tailName(e.name)
    let body: string
    if (kind === 'constant') {
      body = emitConstantFile({
        entity: e,
        schemaNamespace: model.schemaNamespace,
        int64Mode: opts.int64Mode,
        dateMode: opts.dateMode,
      })
    } else {
      const tabularNames = headerToTabulars.get(e.name) ?? []
      const tabulars = tabularNames.map((n) => keptByName.get(n)).filter((t): t is EdmxEntityType => t !== undefined)
      body = emitEntityFile({
        header: e,
        tabulars,
        schemaNamespace: model.schemaNamespace,
        int64Mode: opts.int64Mode,
        dateMode: opts.dateMode,
      })
    }
    files.set(`${folder}/${fileName}.ts`, body)
    populatedKinds.add(kind)
    headerCountsByKind[kind] += 1
  }

  // 4. Per-kind index.ts (always emit all 14 — empty ones get `export {}`)
  for (const kind of KIND_ORDER) {
    const folder = KIND_TO_FOLDER[kind]
    const tails: string[] = []
    for (const [path] of files) {
      const prefix = `${folder}/`
      if (!path.startsWith(prefix)) continue
      if (path === `${prefix}index.ts`) continue
      const tail = path.slice(prefix.length).replace(/\.ts$/, '')
      tails.push(tail)
    }
    files.set(`${folder}/index.ts`, emitKindIndex(tails))
  }

  // 5. Standalone ComplexTypes (skip _RowType — those are emitted nested)
  const standaloneComplex = filterStandaloneComplexTypes(
    model.complexTypes.filter((ct) => closure.complexTypes.has(ct.name)),
    tabularToHeader,
  )
  if (standaloneComplex.length > 0) {
    files.set(
      'complex-types.ts',
      emitComplexTypesFile({
        types: standaloneComplex,
        schemaNamespace: model.schemaNamespace,
        int64Mode: opts.int64Mode,
        dateMode: opts.dateMode,
      }),
    )
  }

  // 6. FunctionImports (from closure — bound to kept EntitySets)
  const filteredFis = closure.functionImports
  if (filteredFis.length > 0) {
    files.set(
      'function-imports.ts',
      emitFunctionImportsFile({
        fis: filteredFis,
        schemaNamespace: model.schemaNamespace,
        int64Mode: opts.int64Mode,
        dateMode: opts.dateMode,
      }),
    )
  }

  // 6b. Enums (one file with all EDMX-declared enums)
  const enumsToEmit = model.enumTypes
  let hasEnums = false
  if (enumsToEmit.length > 0) {
    const enumsResult = emitEnumsFile(enumsToEmit)
    for (const w of enumsResult.warnings) {
      process.stderr.write(`@1c-odata/cli: ${w}\n`)
    }
    files.set('enums.ts', enumsResult.code)
    hasEnums = true
  }

  // 7. Master index.ts
  files.set(
    'index.ts',
    emitMasterIndex({
      populatedKinds: KIND_ORDER.filter((k) => populatedKinds.has(k)).map((k) => KIND_TO_FOLDER[k]),
      hasComplexTypes: standaloneComplex.length > 0,
      hasFunctionImports: filteredFis.length > 0,
      hasEnums,
    }),
  )

  // 8. __metadata.json
  // __metadata.json shape — ALWAYS persist resolved values, not conditional spread.
  // Without this: user without explicit shape → metadataIndex.shape lacks the field →
  // runtime parser sees undefined → no conversion → wire string returned, while
  // generated TS says 'number' (default applied at codegen). Type contract broken.
  const shape: DataShape = {
    int64Mode: opts.int64Mode,
    dateMode: opts.dateMode,
  }
  files.set('__metadata.json', normalizeModel(model, headerCountsByKind, closure, shape, input.inputs))
  files.set('client.ts', emitConnectionClientFile(filteredFis.length > 0))

  return { files }
}

/**
 * Drop ComplexTypes that are tabular `_RowType` companions of a tabular
 * EntityType — those are emitted as nested interfaces inside the parent
 * header entity file. Information registers also have an `_RowType`
 * ComplexType, but the matching entity is the HEADER (single-key), not a
 * tabular child — those should be kept in `complex-types.ts` so the header
 * file's `RecordSet: Collection(...)` reference resolves.
 */
function filterStandaloneComplexTypes(
  complexTypes: EdmxComplexType[],
  tabularToHeader: Map<string, string>,
): EdmxComplexType[] {
  return complexTypes.filter((ct) => {
    if (!ct.name.endsWith('_RowType')) return true
    const stripped = ct.name.slice(0, -'_RowType'.length)
    // Only filter when the stripped name is a known tabular EntityType.
    return !tabularToHeader.has(stripped)
  })
}
