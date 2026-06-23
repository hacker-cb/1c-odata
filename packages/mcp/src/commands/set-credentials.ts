import { join } from 'node:path'
import { InvalidArgumentError } from '@1c-odata/client'
import { loadConfig, type StoredConnection } from '../config.js'
import { type UpdateCredentialsResult, updateConnectionCredentials, verifyConnectivity } from '../connections.js'
import { errorText } from '../redact.js'
import { SecretStore } from '../secret-store.js'
import { promptConfirm, promptHidden, readPasswordStdin } from './_prompt.js'

export interface SetCredentialsOptions {
  dataDir: string
  name: string
  insecure?: boolean
  login?: string
  password?: string
  passwordStdin?: boolean
  noVerify?: boolean
}

/**
 * Resolve the new password: `--password-stdin` > `--password` > an interactive
 * no-echo prompt. When a login change was requested and no password flag was
 * given, returns `undefined` (login-only change, keeping the stored password).
 */
async function resolveNewPassword(
  opts: SetCredentialsOptions,
  loginFlagGiven: boolean,
): Promise<{ value: string; prompted: boolean } | undefined> {
  if (opts.passwordStdin === true) {
    return { value: await readPasswordStdin(), prompted: false }
  }
  if (opts.password !== undefined) {
    if (opts.password === '') throw new InvalidArgumentError('--password must not be empty', { argument: 'password' })
    return { value: opts.password, prompted: false }
  }
  // No password flag: a requested login change defaults to login-only; otherwise
  // prompt for the new password (the common rotation case). promptHidden errors
  // in a non-TTY context, pointing the caller at the env var / flags.
  if (loginFlagGiven) return undefined
  const value = await promptHidden('New password: ')
  if (value === '') throw new InvalidArgumentError('Password must not be empty', { argument: 'password' })
  return { value, prompted: true }
}

/**
 * Verify the effective credentials against `$metadata` before persisting. Skipped
 * by `--no-verify` or when no password resolves. Returns false to abort the
 * change: a flag-driven failure aborts hard, while an interactively-typed
 * password may be kept after an explicit confirmation (mirrors `add`).
 */
async function verifyBeforeSave(
  opts: SetCredentialsOptions,
  existing: StoredConnection,
  effectiveLogin: string,
  pw: { value: string; prompted: boolean } | undefined,
): Promise<boolean> {
  if (opts.noVerify === true) return true
  const store = new SecretStore({ dataDir: opts.dataDir, insecure: opts.insecure ?? false })
  const effectivePassword = pw?.value ?? (await store.read(opts.name))?.password
  if (effectivePassword === undefined) return true
  process.stdout.write('Verifying connection… ')
  try {
    await verifyConnectivity({ baseUrl: existing.baseUrl, login: effectiveLogin, password: effectivePassword })
    process.stdout.write('OK\n')
    return true
  } catch (err) {
    process.stdout.write('FAILED\n')
    // A flag-driven (non-interactive) failure aborts HARD — rethrow so automation
    // sees a non-zero exit, matching `add`. Only an interactively-typed password
    // may be saved past a failed verify, after an explicit confirmation.
    if (pw?.prompted !== true) throw err
    process.stderr.write(`  ${errorText(err)}\n`)
    if (await promptConfirm('Save the change anyway?')) return true
    process.stdout.write('Aborted — nothing changed.\n')
    return false
  }
}

/** Print the outcome of a credential change (or a no-op note). */
function reportCredentialChange(opts: SetCredentialsOptions, result: UpdateCredentialsResult): void {
  const changed = [result.loginUpdated ? 'login' : undefined, result.passwordUpdated ? 'password' : undefined]
    .filter(Boolean)
    .join(' + ')
  if (changed === '') {
    process.stdout.write(`No changes for "${opts.name}" — the supplied login matched the current one.\n`)
    return
  }
  process.stdout.write(`✓ Credentials for "${opts.name}" updated: ${changed}.\n`)
  if (result.passwordBackend !== undefined) {
    const where =
      result.passwordBackend === 'keychain' ? 'OS keychain' : `${join(opts.dataDir, 'credentials.json')} (0600)`
    process.stdout.write(`  password: ${where}\n`)
  }
}

/**
 * Change a stored connection's login and/or password, preserving its base URL,
 * timezone and label. The new credentials are verified against `$metadata`
 * before being persisted (skip with `--no-verify`); the password is stored via
 * {@link SecretStore}, never written to `config.json`.
 */
export async function runSetCredentials(opts: SetCredentialsOptions): Promise<void> {
  const existing = loadConfig(opts.dataDir).connections[opts.name]
  if (existing === undefined) {
    throw new InvalidArgumentError(`No connection named "${opts.name}"`, { argument: 'name' })
  }
  const newLogin = opts.login?.trim()
  const hasLogin = newLogin !== undefined && newLogin !== ''
  if (opts.login !== undefined && !hasLogin) {
    throw new InvalidArgumentError('--login must not be empty', { argument: 'login' })
  }
  const pw = await resolveNewPassword(opts, opts.login !== undefined)
  if (!hasLogin && pw === undefined) {
    throw new InvalidArgumentError('Nothing to change — pass --login and/or a new password', { argument: 'login' })
  }

  const effectiveLogin = hasLogin ? (newLogin as string) : existing.login
  if (!(await verifyBeforeSave(opts, existing, effectiveLogin, pw))) return

  const result = await updateConnectionCredentials({
    dataDir: opts.dataDir,
    name: opts.name,
    ...(hasLogin ? { login: newLogin } : {}),
    ...(pw !== undefined ? { password: pw.value } : {}),
    insecure: opts.insecure ?? false,
  })
  reportCredentialChange(opts, result)
}
