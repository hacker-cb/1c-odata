import { ConnectionPool } from '../connection-pool.js'

export interface TestOptions {
  dataDir: string
  name: string
  insecure?: boolean
}

/** Verify a stored connection by resolving its password and fetching `$metadata`. */
export async function runTest(opts: TestOptions): Promise<void> {
  const pool = new ConnectionPool({ dataDir: opts.dataDir, insecure: opts.insecure ?? false })
  process.stdout.write(`Connecting to "${opts.name}"…\n`)
  const { connection, index } = await pool.get(opts.name)
  const types = Object.keys(index.schemas).length
  const sets = Object.keys(index.entitySetToType).length
  process.stdout.write(
    `✓ Connected to ${connection.baseUrl}. Schema "${index.schemaNamespace}": ${types} entity types, ${sets} entity sets.\n`,
  )
}
