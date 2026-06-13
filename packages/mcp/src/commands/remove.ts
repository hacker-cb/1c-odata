import { InvalidArgumentError } from '@1c-odata/client'
import { loadConfig } from '../config.js'
import { removeConnection } from '../connections.js'
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
  if (loadConfig(opts.dataDir).connections[opts.name] === undefined) {
    throw new InvalidArgumentError(`No connection named "${opts.name}"`, { argument: 'name' })
  }
  if (opts.yes !== true && !(await promptConfirm(`Remove connection "${opts.name}" and its stored password?`))) {
    process.stdout.write('Aborted.\n')
    return
  }
  await removeConnection({ dataDir: opts.dataDir, name: opts.name, insecure: opts.insecure ?? false })
  process.stdout.write(`✓ Connection "${opts.name}" removed.\n`)
}
