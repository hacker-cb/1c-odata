import type { EdmxComplexType } from '../parser/ast.js'
import { applyNullable, mapEdmxTypeToTs } from './type-mapper.js'

export interface ComplexEmitInput {
  types: EdmxComplexType[]
  schemaNamespace: string
  int64Mode: 'number' | 'bigint' | 'string'
  dateMode: 'date' | 'string'
}

/**
 * Emit `complex-types.ts` — one file holding all standalone ComplexTypes
 * (TypeDescription, NumberQualifiers, …). `_RowType` ComplexTypes are NOT
 * passed in here — those are emitted as nested tabulars in the parent entity
 * file by the coordinator (see Task 19).
 */
export function emitComplexTypesFile(input: ComplexEmitInput): string {
  if (input.types.length === 0) return 'export {}\n'

  const importsFromCore = new Set<string>()
  const blocks: string[] = []
  for (const ct of input.types) {
    const lines: string[] = [`export interface ${ct.name} {`]
    for (const p of ct.properties) {
      const ts = mapEdmxTypeToTs(p.type, {
        schemaNamespace: input.schemaNamespace,
        int64Mode: input.int64Mode,
        dateMode: input.dateMode,
      })
      // Tokenize the TS type expression — strip array brackets, split on union/intersection,
      // and only add the `Guid` import when it appears as a discrete token. Substring matching
      // would false-positive on custom symbols like `MyGuidWrapper`.
      const tokens = ts
        .replace(/\[\]/g, '')
        .split(/\s*[|&]\s*/)
        .map((t) => t.trim())
      if (tokens.includes('Guid')) importsFromCore.add('Guid')

      // Scalar Edm.DateTime only — `Collection(Edm.DateTime)` 0 occurrences empirically
      // (see entity.ts for full rationale).
      const isDateTimeAuto = input.dateMode === 'date' && p.type === 'Edm.DateTime'

      if (p.maxLength !== undefined) {
        lines.push('  /**')
        lines.push(`   * @maxLength ${p.maxLength}`)
        lines.push('   */')
      }

      const optional = p.nullable || isDateTimeAuto ? '?' : ''
      const tsTyped = isDateTimeAuto ? `${ts} | null` : applyNullable(ts, p.nullable)
      lines.push(`  ${p.name}${optional}: ${tsTyped}`)
    }
    lines.push('}')
    blocks.push(lines.join('\n'))
  }

  const head =
    importsFromCore.size > 0
      ? `import type { ${[...importsFromCore].sort().join(', ')} } from '@1c-odata/client'\n\n`
      : ''
  return `${head}${blocks.join('\n\n')}\n`
}
