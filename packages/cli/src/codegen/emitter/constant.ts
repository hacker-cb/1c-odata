import type { EdmxEntityType } from '../parser/ast.js'
import { compareCyrillic } from '../util.js'
import { applyNullable, mapEdmxTypeToTs } from './type-mapper.js'

export interface ConstantEmitInput {
  entity: EdmxEntityType
  schemaNamespace: string
  int64Mode: 'number' | 'bigint' | 'string'
  dateMode: 'date' | 'string'
}

/**
 * Emit a `Constant_*` file. 1C constants are special — they have no `Ref_Key`
 * (single SurrogateKey: 0) and no DataVersion / DeletionMark / Predefined.
 * The actual value sits behind a `Value` NavigationProperty (V3 nav link).
 *
 * See spec §5.1 — Constants are NOT extends-Entity and live in their own folder.
 */
export function emitConstantFile(input: ConstantEmitInput): string {
  const importsFromCore = new Set<string>()
  const importsLocal = new Set<string>()
  const lines: string[] = [`export interface ${input.entity.name} {`]
  for (const p of input.entity.properties) {
    const ts = mapEdmxTypeToTs(p.type, {
      schemaNamespace: input.schemaNamespace,
      int64Mode: input.int64Mode,
      dateMode: input.dateMode,
    })
    if (ts === 'Guid') importsFromCore.add('Guid')

    // Scalar Edm.DateTime only — `Collection(Edm.DateTime)` 0 occurrences empirically
    // (see entity.ts for full rationale).
    const isDateTimeAuto = input.dateMode === 'date' && p.type === 'Edm.DateTime'

    const optional = p.nullable || isDateTimeAuto ? '?' : ''
    const tsTyped = isDateTimeAuto ? `${ts} | null` : applyNullable(ts, p.nullable)
    lines.push(`  ${p.name}${optional}: ${tsTyped}`)
  }
  for (const np of input.entity.navigationProperties) {
    if (!np.resolvedTargetType) {
      lines.push(`  ${np.name}?: unknown`)
      continue
    }
    const prefix = `${input.schemaNamespace}.`
    const target = np.resolvedTargetType.startsWith(prefix)
      ? np.resolvedTargetType.slice(prefix.length)
      : np.resolvedTargetType
    importsLocal.add(target)
    // Always `| null` — when the target ref is an empty Guid
    // (00000000-0000-0000-0000-000000000000), 1С returns `null` on $expand and
    // emits a sibling `<NP>@navigationLinkUrl` instead. Symmetric with
    // entity.ts appendNavigationProperty.
    lines.push(`  ${np.name}?: ${target} | null`)
  }
  lines.push('}')

  const headParts: string[] = []
  if (importsFromCore.size > 0) {
    headParts.push(`import type { ${[...importsFromCore].sort().join(', ')} } from '@1c-odata/client'`)
  }
  if (importsLocal.size > 0) {
    const sorted = [...importsLocal].sort(compareCyrillic)
    headParts.push(`import type { ${sorted.join(', ')} } from '../index.js'`)
  }
  const head = headParts.length > 0 ? `${headParts.join('\n')}\n\n` : ''
  return `${head}${lines.join('\n')}\n`
}
