import { join } from 'node:path'
import { InvalidArgumentError } from '@1c-odata/client'
import { assertValidConnectionName, configPath, loadConfig } from '../config.js'
import {
  assertAddable,
  assertAddFieldsOnAdd,
  assertAddTargetAllowedOnAdd,
  upsertConnection,
  verifyConnectivity,
} from '../connections.js'
import { errorText } from '../redact.js'
import { envPassword, passwordEnvVar } from '../secret-store.js'
import { promptConfirm, promptHidden, promptLine, readPasswordStdin } from './_prompt.js'

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
  label?: string
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
  /** Omitted only where an overwrite keeps the base URL, and with it the stored zone. */
  serverTimezone?: string
  /** Optional display label (omitted ⇒ falls back to the name). */
  label?: string
  overwrite: boolean
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
    return { value: await readPasswordStdin(), persist: true }
  }
  if (opts.password !== undefined) {
    if (opts.password === '') throw new InvalidArgumentError('--password must not be empty', { argument: 'password' })
    return { value: opts.password, persist: true }
  }
  // No explicit password — fall back to the env var if present. Env passwords
  // resolve verbatim at runtime, so verify with them verbatim but don't store them.
  const fromEnv = envPassword(name)
  if (fromEnv !== undefined) return { value: fromEnv, persist: false }
  return undefined
}

async function gatherNonInteractive(opts: AddOptions): Promise<ResolvedFields> {
  const name = (opts.name ?? '').trim()
  if (name === '')
    throw new InvalidArgumentError('Connection name is required (pass it as an argument)', { argument: 'name' })
  // Validate name / duplicate / env-var collision BEFORE resolving the env
  // password or verifying — an invalid name would otherwise resolve the wrong
  // ONEC_<NAME>_PASSWORD and fail late after a network round-trip.
  assertAddable(opts.dataDir, name, opts.force === true)
  const login = (opts.login ?? '').trim()
  if (login === '') throw new InvalidArgumentError('--login is required in non-interactive mode', { argument: 'login' })
  // Required unless --force keeps the base URL (then the stored zone stays): runAdd's preflight decides.
  const serverTimezone = opts.timezone?.trim()
  warnIfUrlHasUserinfo((opts.url ?? '').trim())
  const resolved = await resolveNonInteractivePassword(opts, name)
  const label = opts.label?.trim()
  return {
    name,
    baseUrl: (opts.url ?? '').trim(),
    login,
    ...(resolved !== undefined ? { password: resolved.value } : {}),
    persistPassword: resolved?.persist ?? false,
    ...(serverTimezone !== undefined && serverTimezone !== '' ? { serverTimezone } : {}),
    ...(label !== undefined && label !== '' ? { label } : {}),
    overwrite: opts.force === true,
  }
}

/** How many blank or unknown answers the timezone question takes before giving up (stdin may have run dry). */
const TIMEZONE_ATTEMPTS = 3

/** Whether `zone` is an IANA timezone — the check `validateConnection` makes. */
function isIanaTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/**
 * Ask for the server timezone — no default offered: a wrong one silently
 * shifts every DateTime. A blank or unknown zone is asked again, before the
 * answers that follow are spent.
 */
async function promptTimezone(): Promise<string> {
  for (let attempt = 0; attempt < TIMEZONE_ATTEMPTS; attempt++) {
    const answer = (await promptLine('Server timezone (IANA, e.g. Europe/Moscow): ')).trim()
    if (answer !== '' && isIanaTimezone(answer)) return answer
    process.stdout.write(
      answer === ''
        ? 'A timezone is required — there is no default.\n'
        : `"${answer}" is not an IANA timezone (e.g. Europe/Moscow, Asia/Yekaterinburg).\n`,
    )
  }
  throw new InvalidArgumentError('Server timezone is required (an IANA zone, e.g. Europe/Moscow)', {
    argument: 'timezone',
  })
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
  const password = await promptHidden('Password: ')
  const serverTimezone = await promptTimezone()
  const label = (await promptLine('Label (optional, shown in lists): ')).trim()
  return {
    name,
    baseUrl,
    login,
    password,
    persistPassword: true,
    serverTimezone,
    ...(label !== '' ? { label } : {}),
    overwrite,
  }
}

/** Verify connectivity when a password is available. Returns false to abort the add. */
async function verifyOrConfirm(fields: ResolvedFields, opts: AddOptions): Promise<boolean> {
  if (fields.password === undefined || fields.password === '' || opts.noVerify === true) return true
  process.stdout.write('Verifying connection… ')
  try {
    await verifyConnectivity({ baseUrl: fields.baseUrl, login: fields.login, password: fields.password })
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
  result: { overwritten: boolean; passwordBackend?: 'keychain' | 'file'; passwordCleared?: boolean },
): void {
  process.stdout.write(`\n✓ Connection "${fields.name}" ${result.overwritten ? 'updated' : 'saved'}.\n`)
  process.stdout.write(`  config:   ${configPath(opts.dataDir)}\n`)
  if (fields.label !== undefined) process.stdout.write(`  label:    ${fields.label}\n`)
  if (result.passwordBackend !== undefined) {
    const where =
      result.passwordBackend === 'keychain' ? 'OS keychain' : `${join(opts.dataDir, 'credentials.json')} (0600)`
    process.stdout.write(`  password: ${where}\n`)
  } else if (result.passwordCleared === true) {
    process.stdout.write(
      `  password: previous cleared (auth target changed) — provide ${passwordEnvVar(fields.name)} or re-run with a password\n`,
    )
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
  // A missing or mistyped zone (or URL) fails here, not after a multi-MB $metadata download.
  assertAddFieldsOnAdd(opts.dataDir, fields.name, fields)
  // Before verifying, which would already send an env password to the new target.
  assertAddTargetAllowedOnAdd(opts.dataDir, fields.name, fields, {
    byAgent: false,
    storesPassword: fields.persistPassword && fields.password !== undefined && fields.password !== '',
  })
  if (!(await verifyOrConfirm(fields, opts))) return

  const result = await upsertConnection({
    dataDir: opts.dataDir,
    name: fields.name,
    baseUrl: fields.baseUrl,
    login: fields.login,
    ...(fields.serverTimezone !== undefined ? { serverTimezone: fields.serverTimezone } : {}),
    ...(fields.label !== undefined ? { label: fields.label } : {}),
    ...(fields.persistPassword && fields.password !== undefined && fields.password !== ''
      ? { password: fields.password }
      : {}),
    insecure: opts.insecure ?? false,
    overwrite: fields.overwrite,
  })
  reportSaved(opts, fields, result)
}
