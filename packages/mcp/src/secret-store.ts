import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { writeFileAtomic } from './atomic-write.js'
import { type StoredConnection, targetBaseUrl } from './config.js'

/**
 * Where a connection's password was resolved from (or `none`).
 *
 * `env`/`keychain`/`file` are the backends {@link SecretStore} itself reads; a
 * DB-backed {@link ConnectionSource} (a multi-tenant host)
 * reports `db` so `list_connections` names the real origin. {@link SecretStore}
 * never returns `db` — it is only produced by out-of-tree sources.
 */
export type SecretSource = 'env' | 'keychain' | 'file' | 'none' | 'db'

/**
 * OS-keychain service name, namespaced by the data directory: distinct dirs
 * (separate projects/agents) never share a secret, while two clients resolving
 * the SAME dir compute the same service and keep sharing — the same isolation
 * axis `config.json` / `credentials.json` already have (both live in the dir).
 * The connection name stays the human-readable account. A pre-namespacing flat
 * `1c-odata` entry is simply not found; re-add the password or set the env var.
 */
const KEYCHAIN_SERVICE_BASE = '1c-odata'

/** Canonical absolute data dir for hashing: collapse `.`/`..`/dup-seps; fold case on win32. */
function canonicalDataDir(dataDir: string): string {
  const dir = resolve(dataDir)
  return process.platform === 'win32' ? dir.toLowerCase() : dir
}

/**
 * Keychain service for `dataDir`: `1c-odata:<basename>:<first 8 hex of sha256(canonical dir)>`.
 * The basename is a human-readable hint — visible in Keychain Access / Credential
 * Manager — of which data dir a secret belongs to; the hash is the actual per-dir
 * discriminator (the basename alone is ambiguous: the default dir's basename is
 * always `1c-odata`). Same dir → same service (sharing preserved); different dirs
 * → different service (isolation).
 */
export function keychainServiceName(dataDir: string): string {
  const dir = canonicalDataDir(dataDir)
  const hash = createHash('sha256').update(dir).digest('hex').slice(0, 8)
  return `${KEYCHAIN_SERVICE_BASE}:${basename(dir)}:${hash}`
}

/** Minimal keytar-compatible subset of `@napi-rs/keyring`'s sync `Entry`. */
interface KeyringEntry {
  getPassword(): string | null
  setPassword(password: string): void
  deletePassword(): boolean
}
interface KeyringModule {
  Entry: new (service: string, account: string) => KeyringEntry
}

export interface SecretStoreOptions {
  /** Directory holding the fallback `credentials.json`. */
  dataDir: string
  /** Force the plaintext-file backend, bypassing the OS keychain (`--insecure-storage`). */
  insecure?: boolean
  /** Environment to read `ONEC_<NAME>_PASSWORD` from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Sink for the loud keychain-downgrade warning. Defaults to stderr. */
  warn?: (message: string) => void
}

export interface ReadResult {
  password: string
  source: SecretSource
}

/** Env var holding the password for `name`, e.g. `tvip-trade` → `ONEC_TVIP_TRADE_PASSWORD`. */
export function passwordEnvVar(name: string): string {
  const slug = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `ONEC_${slug}_PASSWORD`
}

/**
 * The password `ONEC_<NAME>_PASSWORD` holds for `name` in `env`, or `undefined`
 * where it is unset or empty. Where set it outranks a stored password on read —
 * the one rule {@link SecretStore} reads by and the connection guards check.
 */
export function envPassword(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = passwordEnvVar(name)
  // An own key only: an injected env is a plain object, whose prototype answers for names it never set.
  const value = Object.hasOwn(env, key) ? env[key] : undefined
  return value !== undefined && value !== '' ? value : undefined
}

/**
 * The password `ONEC_<NAME>_PASSWORD` gives connection `name` stored as `conn`
 * (`undefined` — not stored yet): as {@link envPassword}, except for a
 * connection whose target an agent chose (`addedBy: 'agent'`), which never takes
 * it — the variable was set for a server a person chose, and an MCP process
 * that does not hold it may have pointed the connection elsewhere (#253). The
 * one rule every read of a connection's password and every env guard goes by.
 */
export function connectionEnvPassword(
  name: string,
  conn: Pick<StoredConnection, 'addedBy'> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return conn?.addedBy === 'agent' ? undefined : envPassword(name, env)
}

/** What decides where a connection's password lives: who added it, its target, and its key's form. */
export type SecretOwner = Pick<StoredConnection, 'addedBy' | 'baseUrl' | 'passwordKey'>

/**
 * The owner whose key is the bare `<name>` — where a person's password lived
 * before #272, and still lives for a connection no change has moved yet.
 */
export const NAME_KEY_OWNER: SecretOwner = Object.freeze({ baseUrl: '' })

/**
 * The key connection `name`'s stored password lives under — the keychain
 * account and the `credentials.json` key — keyed to its target, so a password
 * is only ever read for the server it was stored for, what another process
 * failed to delete included:
 * - `name@<first 16 hex of sha256(its base URL as a target)>` for a connection
 *   an agent added (#253);
 * - `name+<the same hash>` for a person's connection marked
 *   `passwordKey: 'target'` (#272) — apart from an agent's, so an agent's
 *   connection never reads a person's password of that name;
 * - `name` for a person's connection from before #272, until a change moves it.
 * `@` and `+` are no part of a connection name, so the forms never meet.
 */
export function secretKey(name: string, conn: SecretOwner): string {
  if (conn.addedBy === 'agent') return `${name}@${targetHash(conn.baseUrl)}`
  if (conn.passwordKey === 'target') return `${name}+${targetHash(conn.baseUrl)}`
  return name
}

/** The first 16 hex of sha256 of `baseUrl` as a target ({@link targetBaseUrl}). */
function targetHash(baseUrl: string): string {
  return createHash('sha256').update(targetBaseUrl(baseUrl)).digest('hex').slice(0, 16)
}

interface FileSecrets {
  [name: string]: string
}

/**
 * Layered password store with the `gh` CLI model: read order is
 * **env → 0600 file → OS keychain**; writes prefer the keychain and fall back
 * to the file *loudly* when it refuses (headless Linux/CI, a locked keychain).
 * The file is read first because it holds a password only where the keychain
 * refused the newest write — a write the keychain takes deletes the file copy,
 * and fails where it cannot — so a copy the keychain still keeps, which another
 * process or a refusing keychain could not delete, never outranks it (#257). The keychain
 * backend (`@napi-rs/keyring`) is an optional dependency, loaded lazily — its
 * absence is not fatal, it just degrades to the file.
 *
 * Passwords are an internal value: they flow to {@link SecretStore.read} for
 * building a client, never to an MCP tool argument or response.
 */
export class SecretStore {
  private readonly dataDir: string
  private readonly insecure: boolean
  private readonly env: NodeJS.ProcessEnv
  private readonly warn: (message: string) => void
  /** The keychain backend: loaded, or why it did not load — what the downgrade warning names; `undefined` before the first try. */
  private keyring: KeyringModule | { unavailable: KeyringUnavailable } | undefined

  constructor(opts: SecretStoreOptions) {
    this.dataDir = opts.dataDir
    this.insecure = opts.insecure ?? false
    this.env = opts.env ?? process.env
    this.warn = opts.warn ?? ((message) => process.stderr.write(`${message}\n`))
  }

  private get credentialsPath(): string {
    return join(this.dataDir, 'credentials.json')
  }

  /** Keychain entry for `key` ({@link secretKey}) under this store's per-data-dir service. */
  private keychainEntry(mod: KeyringModule, key: string): KeyringEntry {
    return new mod.Entry(keychainServiceName(this.dataDir), key)
  }

  private async keyringModule(): Promise<KeyringModule | null> {
    if (this.keyring === undefined) {
      try {
        this.keyring = (await import('@napi-rs/keyring')) as unknown as KeyringModule
      } catch (err) {
        this.keyring = { unavailable: keyringLoadFailure(err) }
      }
    }
    return 'unavailable' in this.keyring ? null : this.keyring
  }

  /**
   * Read the password of connection `name`, stored as `conn`, following
   * env → file → keychain; `null` if none found — and for `conn` `undefined`,
   * no such connection. The stored connection is required: one an agent added
   * skips the env var ({@link connectionEnvPassword}), and every connection
   * reads only what was stored under its own key ({@link secretKey}).
   */
  async read(name: string, conn: SecretOwner | undefined): Promise<ReadResult | null> {
    if (conn === undefined) return null
    const fromEnv = connectionEnvPassword(name, conn, this.env)
    if (fromEnv !== undefined) return { password: fromEnv, source: 'env' }
    return this.storedUnder(secretKey(name, conn))
  }

  /** Where the password of `name` lives, WITHOUT revealing it (for `list`); `conn` as for {@link read}. */
  async source(name: string, conn: SecretOwner | undefined): Promise<SecretSource> {
    return (await this.read(name, conn))?.source ?? 'none'
  }

  /** The password stored for `name` as `conn` — the file, then the keychain; never the env var. */
  async stored(name: string, conn: SecretOwner): Promise<string | null> {
    return (await this.storedUnder(secretKey(name, conn)))?.password ?? null
  }

  private async storedUnder(key: string): Promise<ReadResult | null> {
    const fromFile = this.fileRead(key)
    if (fromFile !== null) return { password: fromFile, source: 'file' }
    if (!this.insecure) {
      const fromKeychain = await this.keychainRead(key)
      if (fromKeychain !== null) return { password: fromKeychain, source: 'keychain' }
    }
    return null
  }

  /**
   * Store a password for connection `name`, stored as `conn` once written —
   * under its {@link secretKey}. Prefers the keychain, then deletes the file
   * copy — which reads take first —, failing where it cannot. Where the keychain
   * refuses the password it falls back to the 0600 file loudly; that copy
   * outranks whatever the keychain still keeps, which is then deleted
   * best-effort.
   */
  async write(name: string, password: string, conn: SecretOwner): Promise<{ backend: 'keychain' | 'file' }> {
    // Before the keychain changes: a file it cannot tidy afterwards would leave the write half done.
    this.checkFile()
    const key = secretKey(name, conn)
    if (!this.insecure && (await this.keychainWrite(name, key, password, conn))) {
      this.fileDelete(key) // a copy left here would outrank the password just stored
      return { backend: 'keychain' }
    }
    this.fileWrite(key, password)
    await this.keychainDelete(key) // tidy: the file copy already outranks it
    return { backend: 'file' }
  }

  /** Store `password` under `key` in the keychain; `false`, warned about, where it is refused or absent. */
  private async keychainWrite(name: string, key: string, password: string, conn: SecretOwner): Promise<boolean> {
    // The env var is no way out for an agent's connection, which never reads it.
    const avoid = (fix: string) =>
      conn.addedBy === 'agent'
        ? `${fix[0]?.toUpperCase()}${fix.slice(1)} to avoid this.`
        : `Set ${passwordEnvVar(name)} or ${fix} to avoid this.`
    const mod = await this.keyringModule()
    if (mod === null) {
      const why = this.keyring !== undefined && 'unavailable' in this.keyring ? this.keyring.unavailable : undefined
      this.warn(
        `⚠ ${why?.reason ?? '@napi-rs/keyring not loaded'}; falling back to plaintext ${this.credentialsPath} (0600). ` +
          avoid(why?.fix ?? 'install the keychain backend'),
      )
      return false
    }
    try {
      this.keychainEntry(mod, key).setPassword(password)
      return true
    } catch (err) {
      this.warn(
        `⚠ OS keychain unavailable (${errMessage(err)}); falling back to plaintext ${this.credentialsPath} (0600). ` +
          avoid('fix the keychain'),
      )
      return false
    }
  }

  /**
   * Remove the password of `name` stored as `conn` ({@link secretKey}) from
   * every backend (file + keychain), regardless of preference — a secret may
   * have been written to either on an earlier run (e.g. keychain then later
   * `--insecure-storage`). Best-effort on the keychain — a copy a locked
   * keychain keeps stays under its own key, which only that target reads —
   * unless `strict`: then a keychain this store reads that fails to delete (an
   * error, not "no such entry") throws, for a key a connection still reads.
   * `--insecure-storage` never reads the keychain, so its delete stays
   * best-effort even then.
   */
  async remove(name: string, conn: SecretOwner, opts: { strict?: boolean } = {}): Promise<void> {
    this.checkFile()
    const key = secretKey(name, conn)
    await this.keychainDelete(key, opts.strict === true && !this.insecure ? name : undefined)
    this.fileDelete(key)
  }

  /**
   * Remove every copy a password of `name` on `conn`'s server may have left,
   * whoever stored it — `<name>` (a person's before #272), `<name>+<hash>` (a
   * person's), `<name>@<hash>` (an agent's): a copy a cut-short move or a
   * locked keychain left under any of them must not outlive the connection,
   * to be read when the name is added again. Best-effort on the keychain.
   */
  async removeEveryKey(name: string, conn: SecretOwner): Promise<void> {
    this.checkFile()
    const keys = new Set([
      name,
      secretKey(name, { baseUrl: conn.baseUrl, passwordKey: 'target' }),
      secretKey(name, { baseUrl: conn.baseUrl, addedBy: 'agent' }),
    ])
    for (const key of keys) await this.keychainDelete(key)
    this.fileDeleteKeys([...keys])
  }

  /**
   * Throw where `credentials.json` exists but cannot be read or parsed — the
   * error a delete from it would give — so a change checks it before it alters
   * anything else, rather than fail halfway.
   */
  checkFile(): void {
    this.readFileSecretsForChange()
  }

  /**
   * Copy the password stored for `name` as `from` under `to`'s key, in the
   * backend it is in — a file copy stays a file copy, so a process reading only
   * the file (`--insecure-storage`) still finds it. `false` where nothing was
   * copied: none found where this store can look (it never looks into the
   * keychain under `--insecure-storage`, nor finds one the keychain refuses to
   * read), or the keychain refused the copy.
   */
  async carry(name: string, from: SecretOwner, to: SecretOwner): Promise<boolean> {
    try {
      this.checkFile()
      const found = await this.storedUnder(secretKey(name, from))
      if (found === null) return false
      const key = secretKey(name, to)
      if (found.source === 'file') {
        this.fileWrite(key, found.password)
        return true
      }
      const mod = await this.keyringModule()
      if (mod === null) return false
      this.keychainEntry(mod, key).setPassword(found.password)
      this.fileDelete(key) // a file copy under the new key would outrank the one carried
      return true
    } catch {
      // A credentials file that cannot be read or written, a keychain that refuses: nothing carried.
      return false
    }
  }

  private async keychainRead(key: string): Promise<string | null> {
    const mod = await this.keyringModule()
    if (mod === null) return null
    try {
      const pwd = this.keychainEntry(mod, key).getPassword()
      return pwd !== null && pwd !== '' ? pwd : null
    } catch {
      // NoEntry or keychain unreachable — treat as "not found"
      return null
    }
  }

  /**
   * Delete the keychain entry under `key`. "No such entry" is not an error (the
   * backend answers `false`); a keychain that fails otherwise is ignored — what
   * it keeps stays under its own key — unless `strictFor` names the connection,
   * when it throws.
   */
  private async keychainDelete(key: string, strictFor?: string): Promise<void> {
    const mod = await this.keyringModule()
    if (mod === null) return
    try {
      this.keychainEntry(mod, key).deletePassword()
    } catch (err) {
      if (strictFor !== undefined) {
        throw new Error(
          `Could not delete the stored password of "${strictFor}" from the OS keychain (${errMessage(err)}); nothing was changed. Fix the keychain and retry.`,
        )
      }
    }
  }

  // ── plaintext-file backend (0600, modelled on ~/.pgpass) ──

  /** The file's secrets for a change, or the error naming a file that cannot be read or parsed. */
  private readFileSecretsForChange(): FileSecrets {
    try {
      return this.readFileSecrets(false)
    } catch (err) {
      throw new Error(
        `Could not remove a password from ${this.credentialsPath}: ${errMessage(err)} Nothing was deleted from it — fix the file, or delete it by hand to drop every password it holds.`,
      )
    }
  }

  private fileRead(key: string): string | null {
    const pwd = this.readFileSecrets(true)[key]
    return typeof pwd === 'string' && pwd !== '' ? pwd : null
  }

  private fileWrite(key: string, password: string): void {
    // Read existing secrets (tolerates too-open perms; throws on malformed JSON so a
    // write never clobbers unparseable siblings), add ours, then rewrite at 0600.
    const secrets = this.readFileSecrets(false)
    secrets[key] = password
    this.writeFileSecrets(secrets)
  }

  private fileDelete(key: string): void {
    this.fileDeleteKeys([key])
  }

  /**
   * Delete each of `keys` from the file, read and written once. A file that
   * cannot be read or parsed is left as it is and the delete throws: it may
   * hold the newest password of every other connection (#257), and dropping it
   * whole would bring older copies out of the keychain in their place (#271).
   * An empty `{}` file is dropped; one still holding other connections'
   * secrets is rewritten without these.
   */
  private fileDeleteKeys(keys: string[]): void {
    const secrets = this.readFileSecretsForChange()
    const present = keys.filter((key) => key in secrets)
    for (const key of present) delete secrets[key]
    if (Object.keys(secrets).length === 0) {
      if (existsSync(this.credentialsPath)) this.fileUnlink()
      return
    }
    // Untouched where none of the keys was in it.
    if (present.length > 0) this.writeFileSecrets(secrets)
  }

  private fileUnlink(): void {
    try {
      unlinkSync(this.credentialsPath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  /**
   * Load the credentials file. With `enforcePermissions` it checks the 0600 rule
   * BEFORE reading (a too-open file's plaintext is never loaded) — use it for
   * reads. Write/delete pass `false`: they overwrite with 0600, so they tolerate
   * a too-open existing file. Malformed JSON ALWAYS throws: neither a write nor
   * a delete may clobber unparseable siblings (#271). Only string
   * values are kept (a hand-edited file may contain other types).
   */
  private readFileSecrets(enforcePermissions: boolean): FileSecrets {
    let mode: number
    try {
      mode = statSync(this.credentialsPath).mode & 0o777
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw err
    }
    if (enforcePermissions && process.platform !== 'win32' && (mode & 0o077) !== 0) {
      throw new Error(
        `Credentials file ${this.credentialsPath} has insecure permissions ${mode.toString(8).padStart(4, '0')} ` +
          `(expected 0600). Run: chmod 600 ${this.credentialsPath}`,
      )
    }
    let raw: string
    try {
      raw = readFileSync(this.credentialsPath, 'utf8')
    } catch (err) {
      // Gone since the stat: a keychain write in another process took its last copy away.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw err
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // Malformed JSON always throws (read, write and delete alike): nothing may
      // silently clobber unparseable siblings.
      throw new Error(`Malformed JSON in ${this.credentialsPath} — fix or delete the file.`)
    }
    if (parsed === null || typeof parsed !== 'object') return {}
    const result: FileSecrets = Object.create(null)
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') result[key] = value
    }
    return result
  }

  private writeFileSecrets(secrets: FileSecrets): void {
    mkdirSync(this.dataDir, { recursive: true })
    writeFileAtomic(this.credentialsPath, `${JSON.stringify(secrets, null, 2)}\n`)
  }
}

/** Why the keychain backend did not load, and what fixes it — the two halves of the downgrade warning. */
export interface KeyringUnavailable {
  reason: string
  fix: string
}

/**
 * What stopped `@napi-rs/keyring` from loading: not installed (an optional
 * dependency the install skipped), or installed and failing — a native binary
 * built for another platform or Node ABI, say — which reinstalling fixes and
 * "not installed" would hide. The error's first line, and its loader's first
 * cause where it wraps them (`Cannot find native binding`), keep the one-line
 * warning one line.
 */
export function keyringLoadFailure(err: unknown): KeyringUnavailable {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  // The package itself, quoted as Node names it — not a platform package of it (`@napi-rs/keyring-linux-x64-gnu`).
  const missing =
    (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') &&
    /['"]@napi-rs\/keyring['"]/.test(errMessage(err))
  if (missing) return { reason: '@napi-rs/keyring not installed', fix: 'install the keychain backend' }
  const cause = (err as { cause?: unknown } | undefined)?.cause
  const first = Array.isArray(cause) ? cause[0] : cause
  const detail = [firstLine(errMessage(err)), ...(first !== undefined ? [firstLine(errMessage(first))] : [])].join(': ')
  return {
    reason: `@napi-rs/keyring could not be loaded (${detail})`,
    fix: 'reinstall @napi-rs/keyring for this platform and Node version',
  }
}

function firstLine(text: string): string {
  return text.split('\n', 1)[0] ?? text
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
