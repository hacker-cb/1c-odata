import { type Connection, InvalidArgumentError, validateConnection } from '@1c-odata/client'
import { fetchMetadataIndex } from '@1c-odata/metadata'
import { loadConfig } from '../config.js'
import { passwordEnvVar, SecretStore } from '../secret-store.js'

export interface TestOptions {
  dataDir: string
  name: string
  insecure?: boolean
}

/** Verify a stored connection: resolve its password, fetch + parse `$metadata`. */
export async function runTest(opts: TestOptions): Promise<void> {
  const config = loadConfig(opts.dataDir)
  const stored = config.connections[opts.name]
  if (stored === undefined) {
    throw new InvalidArgumentError(`No connection named "${opts.name}"`, { argument: 'name' })
  }

  const store = new SecretStore({ dataDir: opts.dataDir, insecure: opts.insecure ?? false })
  const secret = await store.read(opts.name)
  if (secret === null) {
    throw new Error(
      `No password for "${opts.name}". Set ${passwordEnvVar(opts.name)} or run: 1c-odata-mcp add ${opts.name}`,
    )
  }

  const connection: Connection = {
    baseUrl: stored.baseUrl,
    auth: { username: stored.login, password: secret.password },
    serverTimezone: stored.serverTimezone,
  }
  validateConnection(connection)

  process.stdout.write(`Connecting to "${opts.name}" (${stored.baseUrl})…\n`)
  const index = await fetchMetadataIndex(connection, { timeout: 30_000 })
  const types = Object.keys(index.schemas).length
  const sets = Object.keys(index.entitySetToType).length
  process.stdout.write(`✓ Connected. Schema "${index.schemaNamespace}": ${types} entity types, ${sets} entity sets.\n`)
  process.stdout.write(`  password source: ${secret.source}\n`)
}
