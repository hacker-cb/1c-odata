// src/tenancy/db-connection-source.ts
/**
 * DB-backed {@link ConnectionSource} for the multi-tenant host. Descriptors from
 * `bases`; secrets decrypted from `base_secrets` at read time with AAD = base_name.
 * The SOLE place ciphertext becomes plaintext — which flows only into the pool's
 * client build, never a tool arg/response. One process-global instance backs the
 * process-global ConnectionPool; per-session scoping is layered by ScopedPool.
 * @internal
 */
import type { ConnectionSource, ListedConnection, SecretSource, StoredConnection } from '@1c-odata/mcp/internal'
import { DecryptionError, decrypt, type Keyring } from '../store/crypto.js'
import type { AuthDb } from '../store/db.js'
import { BaseRepo, SecretRepo } from '../store/repos.js'

export interface DbConnectionSourceOptions {
  db: AuthDb
  /** KEKs for decrypting stored secrets (see crypto.loadKeyring). */
  keyring: Keyring
  /**
   * Sink for decryption/audit failures. A DecryptionError (tampered/swapped/
   * wrong-key blob) is logged here — NOT surfaced to the model — while getSecret
   * returns null so the pool reports the generic "no password". Defaults to stderr.
   */
  onSecretError?(baseName: string, err: unknown): void
}

export class DbConnectionSource implements ConnectionSource {
  private readonly bases: BaseRepo
  private readonly secrets: SecretRepo
  private readonly keyring: Keyring
  private readonly onSecretError: (baseName: string, err: unknown) => void

  constructor(opts: DbConnectionSourceOptions) {
    this.bases = new BaseRepo(opts.db)
    this.secrets = new SecretRepo(opts.db)
    this.keyring = opts.keyring
    this.onSecretError =
      opts.onSecretError ?? ((name, err) => process.stderr.write(`secret error for "${name}": ${errMsg(err)}\n`))
  }

  getBase(name: string): Promise<StoredConnection | undefined> {
    return this.bases.get(name)
  }

  listBases(): Promise<ListedConnection[]> {
    return this.bases.list()
  }

  /**
   * Decrypted password or null. null when: no secret row, unknown key_id, or a
   * GCM auth failure (tampered / cross-base-swapped blob). A decryption failure
   * is logged and collapsed to null so the pool emits the SAME "No password" as
   * an unset secret — no oracle, no base-existence leak.
   */
  async getSecret(name: string): Promise<string | null> {
    const sealed = await this.secrets.get(name)
    if (sealed === null) return null
    try {
      return decrypt(this.keyring, name, sealed)
    } catch (err) {
      // The error sink is logging/audit only — it must never change control flow.
      // Guard it so a throwing sink can't turn a decrypt failure into a thrown
      // getSecret (which would break the "collapse to null, no oracle" contract).
      try {
        this.onSecretError(name, err)
      } catch {
        // ignore — a broken sink must not surface as a secret error
      }
      if (err instanceof DecryptionError) return null
      throw err // a truly unexpected (non-auth) error still surfaces
    }
  }

  /** 'db' when a secret row exists, else 'none' — never decrypts to probe (no oracle). */
  async secretSource(name: string): Promise<SecretSource> {
    return (await this.secrets.has(name)) ? 'db' : 'none'
  }

  missingSecretHint(name: string): string {
    return `Assign a 1С password to base "${name}" in the admin console.`
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
