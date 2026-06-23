import { connectionLabel, loadConfig } from '../config.js'
import { SecretStore } from '../secret-store.js'

export interface ListOptions {
  dataDir: string
  insecure?: boolean
}

/** Print configured connections — never any passwords, only where each lives. */
export async function runList(opts: ListOptions): Promise<void> {
  const config = loadConfig(opts.dataDir)
  const names = Object.keys(config.connections).sort()
  if (names.length === 0) {
    process.stdout.write('No connections configured. Add one with:  1c-odata-mcp add\n')
    return
  }

  const store = new SecretStore({ dataDir: opts.dataDir, insecure: opts.insecure ?? false })
  process.stdout.write(`Connections (${names.length}):\n\n`)
  for (const name of names) {
    const c = config.connections[name]
    if (c === undefined) continue
    const source = await store.source(name)
    const label = connectionLabel(name, c)
    process.stdout.write(`  ${name}\n`)
    if (label !== name) process.stdout.write(`    label:    ${label}\n`)
    process.stdout.write(`    url:      ${c.baseUrl}\n`)
    process.stdout.write(`    login:    ${c.login}\n`)
    process.stdout.write(`    timezone: ${c.serverTimezone}\n`)
    process.stdout.write(`    password: ${source}\n\n`)
  }
}
