import { compareCyrillic } from '../util.js'

/**
 * Emit a per-kind `index.ts` re-exporting every entity file in the folder.
 * `tailNames` are the bare names (e.g. `Номенклатура`, `Валюты`) — emitter
 * sorts them in locale-aware order for deterministic output.
 */
export function emitKindIndex(tailNames: string[]): string {
  if (tailNames.length === 0) return 'export {}\n'
  const sorted = [...tailNames].sort(compareCyrillic)
  return `${sorted.map((n) => `export * from './${n}.js'`).join('\n')}\n`
}

export interface MasterIndexInput {
  populatedKinds: string[]
  hasComplexTypes: boolean
  hasFunctionImports: boolean
  hasEnums: boolean
}

/**
 * Emit the connection-root `index.ts` re-exporting every populated kind folder
 * plus optional `complex-types.ts`, `function-imports.ts`, and `enums.ts`
 * (re-exports `Functions` as a named type so it can be supplied to
 * `ODataV3Client<TFunctions>`).
 */
export function emitMasterIndex(input: MasterIndexInput): string {
  const lines: string[] = []
  for (const k of input.populatedKinds) {
    lines.push(`export * from './${k}/index.js'`)
  }
  if (input.hasComplexTypes) lines.push(`export * from './complex-types.js'`)
  if (input.hasFunctionImports) lines.push(`export type { Functions } from './function-imports.js'`)
  if (input.hasEnums) lines.push(`export * from './enums.js'`)
  if (lines.length === 0) return 'export {}\n'
  return `${lines.join('\n')}\n`
}
