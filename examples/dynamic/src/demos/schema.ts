import type { ODataV3Client } from '@1c-odata/client'

/**
 * Runtime schema introspection — the index that codegen would write to disk
 * is right here on the client. Counts entity sets per 1С kind prefix; this
 * is exactly the kind of discovery a multi-base tool (e.g. an MCP server)
 * does before issuing queries.
 */
export function describeSchema<F>(client: ODataV3Client<F>): void {
  const sets = Object.keys(client.metadataIndex?.entitySetToType ?? {})
  const byPrefix = new Map<string, number>()
  for (const set of sets) {
    const prefix = set.split('_', 1)[0] ?? '?'
    byPrefix.set(prefix, (byPrefix.get(prefix) ?? 0) + 1)
  }
  process.stdout.write(`Schema: ${sets.length} entity sets fetched at runtime\n`)
  for (const [prefix, count] of [...byPrefix.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    process.stdout.write(`  ${prefix}: ${count}\n`)
  }
}
