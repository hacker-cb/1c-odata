import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

/** Where a connection's password was resolved from (or `none`). */
export type SecretSource = 'env' | 'keychain' | 'file' | 'none'

/** OS-keychain service name; the connection name is the account. */
const KEYCHAIN_SERVICE = '1c-odata'

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
          new mod.Entry(KEYCHAIN_SERVICE, name).setPassword(password)
          this.fileDelete(name) // drop any stale plaintext copy from a prior fallback
          return { backend: 'keychain' }
        } catch (err) {
          this.warn(
            `⚠ OS keychain unavailable (${errMessage(err)}); storing password in plaintext ${this.credentialsPath} (0600). ` +
              `Set ${passwordEnvVar(name)} or fix the keychain to avoid this.`,
          )
        }
      } else {
        this.warn(
          `⚠ @napi-rs/keyring not installed; storing password in plaintext ${this.credentialsPath} (0600). ` +
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
      const pwd = new mod.Entry(KEYCHAIN_SERVICE, name).getPassword()
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
      new mod.Entry(KEYCHAIN_SERVICE, name).deletePassword()
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
    // About to overwrite with 0600 — tolerate a pre-existing too-open/malformed file.
    const secrets = this.readFileSecrets(false)
    secrets[name] = password
    this.writeFileSecrets(secrets)
  }

  private fileDelete(name: string): void {
    const secrets = this.readFileSecrets(false)
    if (!(name in secrets)) {
      // `readFileSecrets(false)` returns {} for BOTH an empty/absent file and a
      // malformed one — and a malformed file may still hold stale plaintext we
      // couldn't parse. If the file exists yet yields no readable secrets, drop
      // it entirely so a keychain migration / removal leaves nothing on disk.
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
   * BEFORE reading (a too-open file's plaintext is never loaded) and rejects
   * malformed JSON — use it for reads. Write/delete pass `false`: they overwrite
   * with 0600, so they tolerate a too-open or corrupt existing file. Only string
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
      if (enforcePermissions) throw new Error(`Malformed JSON in ${this.credentialsPath} — fix or delete the file.`)
      return {}
    }
    if (parsed === null || typeof parsed !== 'object') return {}
    const result: FileSecrets = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') result[key] = value
    }
    return result
  }

  private writeFileSecrets(secrets: FileSecrets): void {
    mkdirSync(this.dataDir, { recursive: true })
    const tmp = `${this.credentialsPath}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(secrets, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    try {
      chmodSync(tmp, 0o600)
    } catch {
      // best-effort on platforms without POSIX modes (Windows)
    }
    try {
      renameSync(tmp, this.credentialsPath)
    } catch (err) {
      // Don't leave a temp file containing the password behind on failure.
      try {
        unlinkSync(tmp)
      } catch {
        // best effort — surface the original error
      }
      throw err
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
