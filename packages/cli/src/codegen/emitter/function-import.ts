import { groupFunctionImportsByEntitySet } from '../analysis/function-bindings.js'
import type { EdmxFunctionImport, EdmxParameter } from '../parser/ast.js'
import { compareCyrillic } from '../util.js'
import { applyNullable, extractCustomSymbols, mapEdmxTypeToTs } from './type-mapper.js'

export interface FunctionImportEmitInput {
  fis: EdmxFunctionImport[]
  schemaNamespace: string
  int64Mode: 'number' | 'bigint' | 'string'
  dateMode: 'date' | 'string'
}

/**
 * Emit `function-imports.ts` — one TypeScript interface `Functions` whose top-level
 * keys are EntitySet names, each containing per-FI methods.
 *
 * The emitted `Functions` type is the type parameter of `ODataV3Client<TFunctions>`:
 *   `import type { Functions } from './generated/<connection>'`
 *   `new ODataV3Client<Functions>({...})`
 *
 * Read FI return type: `Promise<Item[]>` for `Collection(...)` returns,
 *                      `Promise<Item>` for scalar returns,
 *                      `Promise<unknown>` if no `ReturnType`.
 * Write FI return type: `Promise<void>`.
 */
export function emitFunctionImportsFile(input: FunctionImportEmitInput): string {
  if (input.fis.length === 0) return 'export {}\n'

  const importsFromCore = new Set<string>()
  const importsLocal = new Set<string>()
  const grouped = groupFunctionImportsByEntitySet(input.fis)
  // Drop unbound FIs (rare; spec §4.5 lists only bound FIs)
  grouped.delete('')

  const sets = [...grouped.keys()].sort()
  const setBlocks: string[] = []
  for (const setName of sets) {
    const methods = grouped.get(setName)!
    const methodLines: string[] = []
    for (const fi of methods) {
      methodLines.push(renderFiSignature(fi, input, importsFromCore, importsLocal))
    }
    setBlocks.push(`  ${setName}: {\n${methodLines.join('\n')}\n  }`)
  }

  const interfaceBody = `export interface Functions {\n${setBlocks.join('\n')}\n}`

  const headParts: string[] = []
  if (importsFromCore.size > 0) {
    headParts.push(`import type { ${[...importsFromCore].sort().join(', ')} } from '@1c-odata/client'`)
  }
  if (importsLocal.size > 0) {
    const sorted = [...importsLocal].sort(compareCyrillic)
    headParts.push(`import type { ${sorted.join(', ')} } from './index.js'`)
  }
  const head = headParts.length > 0 ? `${headParts.join('\n')}\n\n` : ''
  return `${head}${interfaceBody}\n`
}

function renderFiSignature(
  fi: EdmxFunctionImport,
  input: FunctionImportEmitInput,
  importsFromCore: Set<string>,
  importsLocal: Set<string>,
): string {
  const argsType = renderArgsType(fi.parameters, input, importsFromCore)
  const ret = renderReturnType(fi, input, importsFromCore, importsLocal)
  return `    ${fi.name}(args: ${argsType}): ${ret}`
}

function renderArgsType(params: EdmxParameter[], input: FunctionImportEmitInput, importsFromCore: Set<string>): string {
  // 1C/EDMX V3 emits a `bindingParameter` Parameter on bound FIs — the binding
  // is implicit from the EntitySet at the call site, so it's redundant in the
  // user-facing args type. Drop it. (Synthetic fixtures with `EntitySetPath`
  // never have this parameter, so they're unaffected.)
  const userParams = params.filter((p) => p.name !== 'bindingParameter')
  if (userParams.length === 0) return '{}'
  const fields: string[] = []
  for (const p of userParams) {
    const ts = mapEdmxTypeToTs(p.type, {
      schemaNamespace: input.schemaNamespace,
      int64Mode: input.int64Mode,
      dateMode: input.dateMode,
    })
    if (ts === 'Guid') importsFromCore.add('Guid')

    // Edm.DateTime in dateMode='date' is auto-nullable: the 1C sentinel
    // `"0001-01-01T00:00:00"` is mapped to `null` by the runtime parser, so
    // the FI param can always be omitted / passed as null.
    // Scalar Edm.DateTime only — `Collection(Edm.DateTime)` 0 occurrences empirically
    // (see entity.ts for full rationale).
    const isDateTimeAuto = input.dateMode === 'date' && p.type === 'Edm.DateTime'

    const optional = p.nullable || isDateTimeAuto ? '?' : ''
    const tsTyped = isDateTimeAuto ? `${ts} | null` : applyNullable(ts, p.nullable)
    fields.push(`${p.name}${optional}: ${tsTyped}`)
  }
  return `{ ${fields.join('; ')} }`
}

function renderReturnType(
  fi: EdmxFunctionImport,
  input: FunctionImportEmitInput,
  importsFromCore: Set<string>,
  importsLocal: Set<string>,
): string {
  if (fi.httpMethod === 'POST') return 'Promise<void>'
  if (!fi.returnType) return 'Promise<unknown>'
  const ts = mapEdmxTypeToTs(fi.returnType, {
    schemaNamespace: input.schemaNamespace,
    int64Mode: input.int64Mode,
    dateMode: input.dateMode,
  })
  if (ts === 'Guid') importsFromCore.add('Guid')
  // If the return type references a custom symbol (e.g. AccumulationRegister_X_Balance)
  // queue a local import. mapEdmxTypeToTs already strips the schema prefix.
  // Heuristic: any token that doesn't match TS primitive or `unknown[]` etc.
  for (const sym of extractCustomSymbols(ts)) importsLocal.add(sym)

  // Scalar Edm.DateTime in dateMode='date' may carry the 1C sentinel as a
  // return value — the parser maps it to `null`, so widen to `T | null`.
  // `Collection(Edm.DateTime)` deliberately not handled — 0 occurrences in real
  // 1С EDMX (see entity.ts for rationale).
  const isDateTimeAuto = input.dateMode === 'date' && fi.returnType === 'Edm.DateTime'
  const tsTyped = isDateTimeAuto ? `${ts} | null` : ts

  return `Promise<${tsTyped}>`
}
