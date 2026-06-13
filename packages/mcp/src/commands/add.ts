import { connectionAuth, InvalidArgumentError } from '@1c-odata/client'
import { fetchMetadataXml } from '@1c-odata/metadata'
import { assertValidConnectionName, loadConfig } from '../config.js'
import { DEFAULT_METADATA_TIMEOUT_MS } from '../connection-pool.js'
import { upsertConnection } from '../connections.js'
import { errorText, stripUrlUserinfo } from '../redact.js'
import { passwordEnvVar } from '../secret-store.js'
import { promptConfirm, promptHidden, promptLine } from './_prompt.js'

export interface AddOptions {
  dataDir: string
  name?: string
  insecure?: boolean
  // ── non-interactive flags (presence of `url` selects non-interactive mode) ──
  url?: string
  login?: string
  password?: string
  passwordStdin?: boolean
  timezone?: string
  force?: boolean
  noVerify?: boolean
}

interface ResolvedFields {
  name: string
  baseUrl: string
  login: string
  /** Password value (for verify + optional persist). */
  password?: string
  /** Whether the password should be persisted (false when it came from the env var). */
  persistPassword: boolean
  serverTimezone: string
  overwrite: boolean
}

/** Read all of stdin (for `--password-stdin`). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function warnIfUrlHasUserinfo(input: string): void {
  try {
    const url = new URL(input)
    if (url.username !== '' || url.password !== '') {
      process.stderr.write('Note: credentials in the URL are ignored — the password is taken from the prompt / flag.\n')
    }
  } catch {
    // not a URL — upsertConnection will report the validation error
  }
}

/** Resolve the password for non-interactive mode: --password-stdin > --password > env var. */
async function resolveNonInteractivePassword(
  opts: AddOptions,
  name: string,
): Promise<{ value: string; persist: boolean } | undefined> {
  if (opts.passwordStdin === true) {
    const value = (await readStdin()).trim()
    if (value === '') {
      throw new InvalidArgumentError('--password-stdin received an empty password', { argument: 'password' })
    }
    return { value, persist: true }
  }
  if (opts.password !== undefined) {
    const value = opts.password.trim()
    if (value === '') throw new InvalidArgumentError('--password must not be empty', { argument: 'password' })
    return { value, persist: true }
  }
  // No explicit password — fall back to the env var if present. Env passwords
  // already resolve at runtime, so verify with them but don't copy to storage.
  const fromEnv = process.env[passwordEnvVar(name)]
  if (fromEnv !== undefined && fromEnv !== '') return { value: fromEnv.trim(), persist: false }
  return undefined
}

async function gatherNonInteractive(opts: AddOptions): Promise<ResolvedFields> {
  const name = (opts.name ?? '').trim()
  if (name === '')
    throw new InvalidArgumentError('Connection name is required (pass it as an argument)', { argument: 'name' })
  const login = (opts.login ?? '').trim()
  if (login === '') throw new InvalidArgumentError('--login is required in non-interactive mode', { argument: 'login' })
  warnIfUrlHasUserinfo((opts.url ?? '').trim())
  const resolved = await resolveNonInteractivePassword(opts, name)
  return {
    name,
    baseUrl: (opts.url ?? '').trim(),
    login,
    ...(resolved !== undefined ? { password: resolved.value } : {}),
    persistPassword: resolved?.persist ?? false,
    serverTimezone: opts.timezone ?? 'Europe/Moscow',
    overwrite: opts.force === true,
  }
}

async function gatherInteractive(opts: AddOptions): Promise<ResolvedFields | null> {
  const name = (opts.name ?? (await promptLine('Connection name: '))).trim()
  assertValidConnectionName(name)
  let overwrite = false
  if (loadConfig(opts.dataDir).connections[name] !== undefined) {
    if (!(await promptConfirm(`Connection "${name}" exists. Overwrite?`))) {
      process.stdout.write('Aborted.\n')
      return null
    }
    overwrite = true
  }
  const baseUrl = (await promptLine('Base URL: ')).trim()
  warnIfUrlHasUserinfo(baseUrl)
  const login = (await promptLine('Login: ')).trim()
  const password = (await promptHidden('Password: ')).trim()
  const serverTimezone = await promptLine('Server timezone [Europe/Moscow]: ', { default: 'Europe/Moscow' })
  return { name, baseUrl, login, password, persistPassword: true, serverTimezone, overwrite }
}

/** Verify connectivity when a password is available. Returns false to abort the add. */
async function verifyOrConfirm(fields: ResolvedFields, opts: AddOptions): Promise<boolean> {
  if (fields.password === undefined || fields.password === '' || opts.noVerify === true) return true
  process.stdout.write('Verifying connection… ')
  try {
    await fetchMetadataXml({
      baseUrl: stripUrlUserinfo(fields.baseUrl.trim()),
      auth: connectionAuth({ auth: { username: fields.login, password: fields.password } }),
      timeout: DEFAULT_METADATA_TIMEOUT_MS,
    })
    process.stdout.write('OK\n')
    return true
  } catch (err) {
    process.stdout.write('FAILED\n')
    process.stderr.write(`  ${errorText(err)}\n`)
    if (opts.url !== undefined) throw err // non-interactive: fail hard
    if (await promptConfirm('Save the connection anyway?')) return true
    process.stdout.write('Aborted — nothing saved.\n')
    return false
  }
}

function reportSaved(
  opts: AddOptions,
  fields: ResolvedFields,
  result: { overwritten: boolean; passwordBackend?: 'keychain' | 'file' },
): void {
  process.stdout.write(`\n✓ Connection "${fields.name}" ${result.overwritten ? 'updated' : 'saved'}.\n`)
  process.stdout.write(`  config:   ${opts.dataDir}/config.json\n`)
  if (result.passwordBackend !== undefined) {
    const where = result.passwordBackend === 'keychain' ? 'OS keychain' : `${opts.dataDir}/credentials.json (0600)`
    process.stdout.write(`  password: ${where}\n`)
  } else if (fields.password !== undefined && !fields.persistPassword) {
    process.stdout.write(`  password: ${passwordEnvVar(fields.name)} env var (not copied to storage)\n`)
  } else {
    process.stdout.write(`  password: not set — provide ${passwordEnvVar(fields.name)} or re-run with a password\n`)
  }
}

/**
 * Add (or overwrite) a connection. Interactive by default; non-interactive when
 * `--url` is given. In both modes the password is stored via {@link SecretStore}
 * — never written to `config.json`.
 */
export async function runAdd(opts: AddOptions): Promise<void> {
  const fields = opts.url !== undefined ? await gatherNonInteractive(opts) : await gatherInteractive(opts)
  if (fields === null) return
  if (!(await verifyOrConfirm(fields, opts))) return

  const result = await upsertConnection({
    dataDir: opts.dataDir,
    name: fields.name,
    baseUrl: fields.baseUrl,
    login: fields.login,
    serverTimezone: fields.serverTimezone,
    ...(fields.persistPassword && fields.password !== undefined && fields.password !== ''
      ? { password: fields.password }
      : {}),
    insecure: opts.insecure ?? false,
    overwrite: fields.overwrite,
  })
  reportSaved(opts, fields, result)
}
