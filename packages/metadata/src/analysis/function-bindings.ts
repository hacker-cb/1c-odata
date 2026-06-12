import type { EdmxFunctionImport } from '../parser/ast.js'

/**
 * Group FunctionImports by their `EntitySetPath` (the bound EntitySet name).
 * Unbound FIs (no `EntitySetPath`) land under the empty-string key `""`.
 *
 * 1C emits `<FunctionImport>` once per binding — for ten AccumulationRegisters,
 * `Balance` appears ten times with different `EntitySetPath`. We preserve order
 * so generated output is deterministic per snapshot.
 */
export function groupFunctionImportsByEntitySet(fis: EdmxFunctionImport[]): Map<string, EdmxFunctionImport[]> {
  const out = new Map<string, EdmxFunctionImport[]>()
  for (const fi of fis) {
    const k = fi.entitySetPath ?? ''
    const list = out.get(k) ?? []
    list.push(fi)
    out.set(k, list)
  }
  return out
}
