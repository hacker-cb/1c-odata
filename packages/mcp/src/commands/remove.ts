import { InvalidArgumentError } from '@1c-odata/client'
import { loadConfig, saveConfig } from '../config.js'
import { SecretStore } from '../secret-store.js'
import { promptConfirm } from './_prompt.js'

export interface RemoveOptions {
  dataDir: string
  name: string
  insecure?: boolean
  /** Skip the confirmation prompt. */
  yes?: boolean
}

/** Remove a connection from `config.json` and delete its stored password. */
export async function runRemove(opts: RemoveOptions): Promise<void> {
  const config = loadConfig(opts.dataDir)
  if (config.connections[opts.name] === undefined) {
    throw new InvalidArgumentError(`No connection named "${opts.name}"`, { argument: 'name' })
  }

  if (opts.yes !== true && !(await promptConfirm(`Remove connection "${opts.name}" and its stored password?`))) {
    process.stdout.write('Aborted.\n')
    return
  }

  delete config.connections[opts.name]
  saveConfig(opts.dataDir, config)

  const store = new SecretStore({ dataDir: opts.dataDir, insecure: opts.insecure ?? false })
  await store.remove(opts.name)

  process.stdout.write(`✓ Connection "${opts.name}" removed.\n`)
}
