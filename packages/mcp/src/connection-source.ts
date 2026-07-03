import type { StoredConnection } from './config.js'
import type { SecretSource } from './secret-store.js'

/** A configured base plus its name, as returned by {@link ConnectionSource.listBases}. */
export interface ListedConnection extends StoredConnection {
  /** Connection alias — the key it is stored under. */
  name: string
}

/**
 * Pluggable origin of connection descriptors + secrets for a {@link ConnectionPool}.
 *
 * The local stdio server uses {@link FileConnectionSource} (config.json + keychain),
 * so its UX is unchanged. A multi-tenant host (`@1c-odata/mcp-server`) supplies a
 * DB-backed implementation whose secrets are decrypted at read time. The pool only
 * ever talks to this seam — it never learns WHERE bases or passwords live.
 *
 * The interface is fully async so a DB/network-backed source fits without shape
 * changes; the file source resolves synchronously behind the Promises.
 *
 * @internal Not part of the semver-stable surface — see STABILITY.md.
 */
export interface ConnectionSource {
  /** Non-secret descriptor for one base, or `undefined` when unknown. */
  getBase(name: string): Promise<StoredConnection | undefined>
  /** Every configured base (no secrets), each tagged with its name. */
  listBases(): Promise<ListedConnection[]>
  /**
   * Resolved/decrypted password for `name`, or `null` when none is available.
   * Never surfaced to a tool argument or response — it flows only into building
   * the client.
   */
  getSecret(name: string): Promise<string | null>
  /** Where `name`'s secret resolves from, WITHOUT revealing it (for listings). */
  secretSource(name: string): Promise<SecretSource>
  /**
   * Optional actionable hint appended to the pool's "no password" error. Lets a
   * source phrase its own remediation (the file source points at the env var / CLI)
   * while the pool stays source-agnostic. Omit to keep the bare error.
   */
  missingSecretHint?(name: string): string
}
