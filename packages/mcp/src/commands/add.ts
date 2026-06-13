import {
  type Connection,
  connectionAuth,
  InvalidArgumentError,
  normalizeBaseUrl,
  parseConnectionUrl,
  validateConnection,
} from '@1c-odata/client'
import { fetchMetadataXml } from '@1c-odata/metadata'
import { loadConfig, type StoredConnection, saveConfig } from '../config.js'
import { errorText } from '../redact.js'
import { passwordEnvVar, SecretStore } from '../secret-store.js'
import { promptConfirm, promptHidden, promptLine } from './_prompt.js'

export interface AddOptions {
  dataDir: string
  /** Connection name; prompted interactively when omitted. */
  name?: string
  /** Force the plaintext-file secret backend. */
  insecure?: boolean
}

/**
 * Interactively add (or overwrite) a connection. The password is read with a
 * no-echo prompt and stored via {@link SecretStore} — it never touches argv,
 * env, or the persisted `config.json`.
 */
export async function runAdd(opts: AddOptions): Promise<void> {
  const config = loadConfig(opts.dataDir)

  const name = (opts.name ?? (await promptLine('Connection name: '))).trim()
  if (name === '') throw new InvalidArgumentError('Connection name is required', { argument: 'name' })
  if (config.connections[name] !== undefined && !(await promptConfirm(`Connection "${name}" exists. Overwrite?`))) {
    process.stdout.write('Aborted.\n')
    return
  }

  const urlInput = (await promptLine('Base URL (you may include user:password@): ')).trim()
  let baseUrl: string
  let username: string
  let password: string
  try {
    // URL carries userinfo — split it into baseUrl + credentials.
    const parsed = parseConnectionUrl(urlInput)
    baseUrl = parsed.baseUrl
    username = parsed.auth.username
    password = parsed.auth.password
  } catch {
    // No userinfo — ask for login and password separately.
    baseUrl = normalizeBaseUrl(urlInput)
    username = (await promptLine('Login: ')).trim()
    password = await promptHidden('Password: ')
  }

  const serverTimezone = await promptLine('Server timezone [Europe/Moscow]: ', { default: 'Europe/Moscow' })

  const connection: Connection = { baseUrl, auth: { username, password }, serverTimezone }
  validateConnection(connection)

  process.stdout.write('Verifying connection… ')
  try {
    await fetchMetadataXml({ baseUrl, auth: connectionAuth(connection), timeout: 30_000 })
    process.stdout.write('OK\n')
  } catch (err) {
    process.stdout.write('FAILED\n')
    process.stderr.write(`  ${errorText(err)}\n`)
    if (!(await promptConfirm('Save the connection anyway?'))) {
      process.stdout.write('Aborted — nothing saved.\n')
      return
    }
  }

  const stored: StoredConnection = { baseUrl, login: username, serverTimezone }
  config.connections[name] = stored
  saveConfig(opts.dataDir, config)

  const store = new SecretStore({ dataDir: opts.dataDir, insecure: opts.insecure ?? false })
  const { backend } = await store.write(name, password)

  process.stdout.write(`\n✓ Connection "${name}" saved.\n`)
  process.stdout.write(`  config:   ${opts.dataDir}/config.json\n`)
  process.stdout.write(
    `  password: ${backend === 'keychain' ? 'OS keychain' : `${opts.dataDir}/credentials.json (0600)`}\n`,
  )
  process.stdout.write(`  override: ${passwordEnvVar(name)} env var takes precedence\n`)
}
