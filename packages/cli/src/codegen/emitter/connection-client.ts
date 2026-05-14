/**
 * Emit `client.ts` — auto-generated convenience module per connection.
 *
 * The emitted file exposes a pre-typed `createClient(opts)` that auto-loads
 * the sibling `__metadata.json` and constructs a `ODataV3Client<Functions>`.
 * Users avoid manually wiring `<Functions>` generic and `loadMetadataIndex(path)`.
 *
 * The function is async because `loadMetadataIndex` is async. Path resolution
 * uses `import.meta.url` to find `__metadata.json` sibling at runtime —
 * survives bundling, build-step copying, and works under both Node and
 * compiled-down ESM.
 *
 * When no FunctionImports are in the schema, `function-imports.js` is not emitted.
 * In that case, Functions defaults to ODataV3FunctionsBase (the generic default on
 * ODataV3Client), so the import is omitted and createClient() is untyped. This allows
 * client.ts to compile even with zero Functions.
 */
export function emitConnectionClientFile(hasFunctionImports: boolean = false): string {
  const functionImportsImport = hasFunctionImports
    ? `import type { Functions } from './function-imports.js'
`
    : ``

  const functionsGeneric = hasFunctionImports ? '<Functions>' : ''

  return `import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadMetadataIndex, ODataV3Client, type ODataV3ClientOptions } from '@1c-odata/client'
${functionImportsImport}
const __metadataPath = join(dirname(fileURLToPath(import.meta.url)), '__metadata.json')

/**
 * Create an ODataV3Client pre-typed with Functions for this connection.
 * Auto-loads sibling __metadata.json.
 *
 * @public
 */
export async function createClient(
  opts: Omit<ODataV3ClientOptions, 'metadataIndex'>,
): Promise<ODataV3Client${functionsGeneric}> {
  return new ODataV3Client${functionsGeneric}({
    ...opts,
    metadataIndex: await loadMetadataIndex(__metadataPath),
  })
}
`
}
