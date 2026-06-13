import { type Connection, connectionAuth, normalizeBaseUrl, validateConnection } from '@1c-odata/client'
import { fetchMetadataXml } from '@1c-odata/metadata'
import { assertValidConnectionName, loadConfig, type StoredConnection, saveConfig } from '../config.js'
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

/** Strip any `user:password@` userinfo from a URL; the password is collected via the no-echo prompt instead. */
function baseUrlWithoutUserinfo(input: string): string {
  try {
    const url = new URL(input)
    if (url.username !== '' || url.password !== '') {
      process.stderr.write('Note: credentials in the URL are ignored — enter the password at the prompt below.\n')
      url.username = ''
      url.password = ''
    }
    return normalizeBaseUrl(`${url.protocol}//${url.host}${url.pathname}${url.search}`)
  } catch {
    return normalizeBaseUrl(input)
  }
}

/**
 * Interactively add (or overwrite) a connection. The password is ALWAYS read
 * with a no-echo prompt and stored via {@link SecretStore} — it never touches
 * argv, env, the echoed URL prompt, or the persisted `config.json`.
 */
export async function runAdd(opts: AddOptions): Promise<void> {
  const config = loadConfig(opts.dataDir)

  const name = (opts.name ?? (await promptLine('Connection name: '))).trim()
  assertValidConnectionName(name)
  if (config.connections[name] !== undefined && !(await promptConfirm(`Connection "${name}" exists. Overwrite?`))) {
    process.stdout.write('Aborted.\n')
    return
  }

  const baseUrl = baseUrlWithoutUserinfo((await promptLine('Base URL: ')).trim())
  const username = (await promptLine('Login: ')).trim()
  // The password is intentionally NOT trimmed — surrounding spaces may be part
  // of it — but a stray space from a paste is a likely mistake, so flag it.
  const password = await promptHidden('Password: ')
  if (password !== password.trim()) {
    process.stderr.write(
      'Note: the password has leading/trailing whitespace — kept as-is. If that came from a paste, re-run and re-enter it.\n',
    )
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
