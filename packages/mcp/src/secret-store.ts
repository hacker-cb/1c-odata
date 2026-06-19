import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { writeFileAtomic } from './atomic-write.js'

/** Where a connection's password was resolved from (or `none`). */
export type SecretSource = 'env' | 'keychain' | 'file' | 'none'

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

/** Keychain service for `dataDir`: `1c-odata:<first 16 hex of sha256(canonical dir)>`. */
export function keychainServiceName(dataDir: string): string {
  const hash = createHash('sha256').update(canonicalDataDir(dataDir)).digest('hex').slice(0, 16)
  return `${KEYCHAIN_SERVICE_BASE}:${hash}`
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

interface FileSecrets {
  [name: string]: string
}

/**
 * Layered password store with the `gh` CLI model: read order is
 * **env → OS keychain → 0600 file**; writes prefer the keychain and fall back
 * to the file *loudly* when it is unavailable (headless Linux/CI). The keychain
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

  /** Keychain entry for `name` under this store's per-data-dir service. */
  private keychainEntry(mod: KeyringModule, name: string): KeyringEntry {
    return new mod.Entry(keychainServiceName(this.dataDir), name)
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

  /** Read a password following env → keychain → file. `null` if none found. */
  async read(name: string): Promise<ReadResult | null> {
    const fromEnv = this.env[passwordEnvVar(name)]
    if (fromEnv !== undefined && fromEnv !== '') return { password: fromEnv, source: 'env' }
    if (!this.insecure) {
      const fromKeychain = await this.keychainRead(name)
      if (fromKeychain !== null) return { password: fromKeychain, source: 'keychain' }
    }
    const fromFile = this.fileRead(name)
    if (fromFile !== null) return { password: fromFile, source: 'file' }
    return null
  }

  /** Where the password for `name` lives, WITHOUT revealing it (for `list`). */
  async source(name: string): Promise<SecretSource> {
    const fromEnv = this.env[passwordEnvVar(name)]
    if (fromEnv !== undefined && fromEnv !== '') return 'env'
    if (!this.insecure && (await this.keychainRead(name)) !== null) return 'keychain'
    if (this.fileRead(name) !== null) return 'file'
    return 'none'
  }

  /** Store a password. Prefers the keychain; falls back to the 0600 file loudly. */
  async write(name: string, password: string): Promise<{ backend: 'keychain' | 'file' }> {
    if (!this.insecure) {
      const mod = await this.keyringModule()
      if (mod !== null) {
        try {
          this.keychainEntry(mod, name).setPassword(password)
          this.fileDelete(name) // drop any stale plaintext copy from a prior fallback
          return { backend: 'keychain' }
        } catch (err) {
          this.warn(
            `⚠ OS keychain unavailable (${errMessage(err)}); falling back to plaintext ${this.credentialsPath} (0600). ` +
              `Set ${passwordEnvVar(name)} or fix the keychain to avoid this.`,
          )
        }
      } else {
        this.warn(
          `⚠ @napi-rs/keyring not installed; falling back to plaintext ${this.credentialsPath} (0600). ` +
            `Set ${passwordEnvVar(name)} or install the keychain backend to avoid this.`,
        )
      }
    }
    // File backend — also drop any stale keychain copy so a later read can't pick it up.
    await this.keychainDelete(name)
    this.fileWrite(name, password)
    return { backend: 'file' }
  }

  /** Remove a password from every backend (file + keychain), regardless of preference. */
  async remove(name: string): Promise<void> {
    // Best-effort delete from BOTH backends — a secret may have been written to
    // either on an earlier run (e.g. keychain then later `--insecure-storage`).
    await this.keychainDelete(name)
    this.fileDelete(name)
  }

  private async keychainRead(name: string): Promise<string | null> {
    const mod = await this.keyringModule()
    if (mod === null) return null
    try {
      const pwd = this.keychainEntry(mod, name).getPassword()
      return pwd !== null && pwd !== '' ? pwd : null
    } catch {
      // NoEntry or keychain unreachable — treat as "not found"
      return null
    }
  }

  private async keychainDelete(name: string): Promise<void> {
    const mod = await this.keyringModule()
    if (mod === null) return
    try {
      this.keychainEntry(mod, name).deletePassword()
    } catch {
      // no entry / keychain unreachable — nothing to delete
    }
  }

  // ── plaintext-file backend (0600, modelled on ~/.pgpass) ──

  private fileRead(name: string): string | null {
    const pwd = this.readFileSecrets(true)[name]
    return typeof pwd === 'string' && pwd !== '' ? pwd : null
  }

  private fileWrite(name: string, password: string): void {
    // Read existing secrets (tolerates too-open perms; throws on malformed JSON so a
    // write never clobbers unparseable siblings), add ours, then rewrite at 0600.
    const secrets = this.readFileSecrets(false)
    secrets[name] = password
    this.writeFileSecrets(secrets)
  }

  private fileDelete(name: string): void {
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
    if (!(name in secrets)) {
      // An empty `{}` file that exists is harmless to drop; a file still holding
      // other connections' secrets is left untouched.
      if (Object.keys(secrets).length === 0 && existsSync(this.credentialsPath)) this.fileUnlink()
      return
    }
    delete secrets[name]
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
    const raw = readFileSync(this.credentialsPath, 'utf8')
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
