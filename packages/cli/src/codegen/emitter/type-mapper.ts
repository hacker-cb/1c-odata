export interface TypeMapperOptions {
  schemaNamespace: string
  int64Mode: 'number' | 'bigint' | 'string'
  dateMode: 'date' | 'string'
}

/**
 * Translate an EDMX type literal into a TypeScript type expression.
 * Throws on unrecognised `Edm.*` types — silent `'unknown'` fallback hides
 * codegen drift (e.g. 1С adding `Edm.Decimal`). Schema-namespaced types
 * (`<schemaNamespace>.X`) still resolve by stripping the prefix.
 */
export function mapEdmxTypeToTs(edmxType: string, opts: TypeMapperOptions): string {
  // Collection(...) wraps an inner type — recurse and append `[]`
  const collectionMatch = /^Collection\((.+)\)$/.exec(edmxType)
  if (collectionMatch) return `${mapEdmxTypeToTs(collectionMatch[1]!, opts)}[]`

  switch (edmxType) {
    case 'Edm.String':
      return 'string'
    case 'Edm.Boolean':
      return 'boolean'
    case 'Edm.Int16':
    case 'Edm.Int32':
    case 'Edm.Double':
      return 'number'
    case 'Edm.Int64':
      return opts.int64Mode // 'string' | 'number' | 'bigint'
    case 'Edm.Guid':
      return 'Guid'
    case 'Edm.DateTime':
      return opts.dateMode === 'string' ? 'string' : 'Date'
    case 'Edm.Binary':
      // V3 wire: base64-encoded string
      return 'string'
    case 'Edm.Stream':
      // Raw Edm.Stream surfaces as `string` in mapper output; ValueStorage detection
      // (Task 10) replaces the whole triple with the `ValueStorage` symbol upstream.
      return 'string'
    default: {
      const prefix = `${opts.schemaNamespace}.`
      if (edmxType.startsWith(prefix)) return edmxType.slice(prefix.length)
      throw new Error(`Unmapped EDM type: "${edmxType}". Add a case in mapEdmxTypeToTs.`)
    }
  }
}

/** Wrap a TS type with `| null` if the property is nullable. */
export function applyNullable(tsType: string, nullable: boolean): string {
  return nullable ? `${tsType} | null` : tsType
}

const TS_PRIMITIVES: ReadonlySet<string> = new Set(['string', 'number', 'boolean', 'unknown', 'Date', 'bigint', 'null'])

const CORE_SYMBOLS: ReadonlySet<string> = new Set(['Entity', 'Guid', 'ValueStorage'])

/**
 * Tokenize a TS type expression and return the list of custom (non-primitive,
 * non-core) symbols. Used by emitters to figure out which entity-local imports
 * to write at the top of an emitted file.
 *
 * Strips array brackets, splits on union/intersection, drops empty tokens, then
 * filters out TS primitives (`string`, `number`, …) and `@1c-odata/client` symbols
 * (`Entity`, `Guid`, `ValueStorage`) which are imported separately.
 */
export function extractCustomSymbols(tsType: string): string[] {
  return tsType
    .replace(/\[\]/g, '')
    .split(/\s*[|&]\s*/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .filter((t) => !TS_PRIMITIVES.has(t))
    .filter((t) => !CORE_SYMBOLS.has(t))
}
