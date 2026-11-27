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

/** What decides where a connection's password lives: whether an agent added it, and its target. */
export type SecretOwner = Pick<StoredConnection, 'addedBy' | 'baseUrl'>

/**
 * The key connection `name`'s stored password lives under — the keychain
 * account and the `credentials.json` key: `name` for a connection a person
 * added; `name@<first 16 hex of sha256(its base URL as a target)>` for one an
 * agent added. An agent's connection thus never reads a password stored for a
 * person's connection of that name, nor one stored under another server — what
 * another process failed to delete included (#253). `@` is no part of a
 * connection name, so the two forms never meet.
 */
export function secretKey(name: string, conn: SecretOwner | undefined): string {
  if (conn?.addedBy !== 'agent') return name
  const hash = createHash('sha256').update(targetBaseUrl(conn.baseUrl)).digest('hex').slice(0, 16)
  return `${name}@${hash}`
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
  private keyring: KeyringModule | null | undefined

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
      } catch {
        this.keyring = null
      }
    }
    return this.keyring
  }

  /**
   * Read a password following env → file → keychain. `null` if none found.
   * Pass the stored connection: one an agent added skips the env var
   * ({@link connectionEnvPassword}) and reads only what was stored for its
   * target ({@link secretKey}).
   */
  async read(name: string, conn?: SecretOwner): Promise<ReadResult | null> {
    const fromEnv = connectionEnvPassword(name, conn, this.env)
    if (fromEnv !== undefined) return { password: fromEnv, source: 'env' }
    const key = secretKey(name, conn)
    const fromFile = this.fileRead(key)
    if (fromFile !== null) return { password: fromFile, source: 'file' }
    if (!this.insecure) {
      const fromKeychain = await this.keychainRead(key)
      if (fromKeychain !== null) return { password: fromKeychain, source: 'keychain' }
    }
    return null
  }

  /** Where the password for `name` lives, WITHOUT revealing it (for `list`); `conn` as for {@link read}. */
  async source(name: string, conn?: SecretOwner): Promise<SecretSource> {
    if (connectionEnvPassword(name, conn, this.env) !== undefined) return 'env'
    const key = secretKey(name, conn)
    if (this.fileRead(key) !== null) return 'file'
    if (!this.insecure && (await this.keychainRead(key)) !== null) return 'keychain'
    return 'none'
  }

  /**
   * Store a password for connection `name`, stored as `conn` once written —
   * under its {@link secretKey}. Prefers the keychain, then deletes the file
   * copy — which reads take first —, failing where it cannot. Where the keychain
   * refuses the password it falls back to the 0600 file loudly; that copy
   * outranks whatever the keychain still keeps, which is then deleted
   * best-effort.
   */
  async write(name: string, password: string, conn?: SecretOwner): Promise<{ backend: 'keychain' | 'file' }> {
    const key = secretKey(name, conn)
    if (!this.insecure && (await this.keychainWrite(name, key, password, conn))) {
      this.fileDelete(key) // a copy left here would outrank the password just stored
      return { backend: 'keychain' }
    }
    this.fileWrite(key, password)
    await this.keychainDelete(key, false, name) // tidy: the file copy already outranks it
    return { backend: 'file' }
  }

  /** Store `password` under `key` in the keychain; `false`, warned about, where it is refused or absent. */
  private async keychainWrite(name: string, key: string, password: string, conn?: SecretOwner): Promise<boolean> {
    // The env var is no way out for an agent's connection, which never reads it.
    const avoid = (fix: string) =>
      conn?.addedBy === 'agent'
        ? `${fix[0]?.toUpperCase()}${fix.slice(1)} to avoid this.`
        : `Set ${passwordEnvVar(name)} or ${fix} to avoid this.`
    const mod = await this.keyringModule()
    if (mod === null) {
      this.warn(
        `⚠ @napi-rs/keyring not installed; falling back to plaintext ${this.credentialsPath} (0600). ` +
          avoid('install the keychain backend'),
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
   * Remove a password from every backend (file + keychain), regardless of
   * preference — a secret may have been written to either on an earlier run
   * (e.g. keychain then later `--insecure-storage`). Best-effort on the
   * keychain unless `strict`: then a keychain this store reads that fails to
   * delete (an error, not "no such entry") throws, as a password left there
   * would be read again once the keychain answers. `--insecure-storage` never
   * reads the keychain, so its delete stays best-effort even then. `conn` as
   * for {@link read}: it names the key removed.
   */
  async remove(name: string, opts: { strict?: boolean } = {}, conn?: SecretOwner): Promise<void> {
    const key = secretKey(name, conn)
    await this.keychainDelete(key, opts.strict === true && !this.insecure, name)
    this.fileDelete(key)
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
   * Delete the keychain entry under `key`, connection `name`'s. "No such entry"
   * is not an error (the backend answers `false`); a keychain that fails
   * otherwise is ignored — nothing reachable to delete — unless `strict`, when
   * it throws.
   */
  private async keychainDelete(key: string, strict: boolean, name: string): Promise<void> {
    const mod = await this.keyringModule()
    if (mod === null) return
    try {
      this.keychainEntry(mod, key).deletePassword()
    } catch (err) {
      if (strict) {
        throw new Error(
          `Could not delete the stored password of "${name}" from the OS keychain (${errMessage(err)}); nothing was changed. Fix the keychain and retry.`,
        )
      }
    }
  }

  // ── plaintext-file backend (0600, modelled on ~/.pgpass) ──

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
    let secrets: FileSecrets
    try {
      secrets = this.readFileSecrets(false)
    } catch {
      // Malformed/unreadable file: we can't surgically drop one entry and it may
      // hold stale plaintext we couldn't parse — remove it whole (it held no
      // recoverable secrets) so a keychain migration / removal leaves nothing.
      this.fileUnlink()
      return
    }
    if (!(key in secrets)) {
      // An empty `{}` file that exists is harmless to drop; a file still holding
      // other connections' secrets is left untouched.
      if (Object.keys(secrets).length === 0 && existsSync(this.credentialsPath)) this.fileUnlink()
      return
    }
    delete secrets[key]
    if (Object.keys(secrets).length === 0) {
      this.fileUnlink()
      return
    }
    this.writeFileSecrets(secrets)
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
   * a too-open existing file. Malformed JSON ALWAYS throws (a write must not
   * clobber unparseable siblings; fileDelete catches it and unlinks). Only string
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
      // Malformed JSON always throws (both read and write paths) — a write must
      // not silently clobber unparseable siblings; fileDelete catches & unlinks.
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

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
