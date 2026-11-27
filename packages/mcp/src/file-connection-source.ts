import { loadConfig, type StoredConnection } from './config.js'
import type { ConnectionSource, ListedConnection } from './connection-source.js'
import { passwordEnvVar, type SecretSource, SecretStore } from './secret-store.js'

export interface FileConnectionSourceOptions {
  /** Directory holding `config.json` + the fallback `credentials.json`. */
  dataDir: string
  /** Force the plaintext-file secret backend, bypassing the OS keychain. */
  insecure?: boolean
}

/**
 * File-backed {@link ConnectionSource}: descriptors from `<dataDir>/config.json`,
 * secrets via {@link SecretStore} (env → keychain → 0600 file). This is exactly
 * the behavior the local stdio server had before the source seam existed, so its
 * UX is unchanged.
 *
 * @internal Not part of the semver-stable surface — see STABILITY.md.
 */
export class FileConnectionSource implements ConnectionSource {
  private readonly dataDir: string
  private readonly store: SecretStore

  constructor(opts: FileConnectionSourceOptions) {
    this.dataDir = opts.dataDir
    this.store = new SecretStore({ dataDir: opts.dataDir, insecure: opts.insecure ?? false })
  }

  async getBase(name: string): Promise<StoredConnection | undefined> {
    return loadConfig(this.dataDir).connections[name]
  }

  async listBases(): Promise<ListedConnection[]> {
    return Object.entries(loadConfig(this.dataDir).connections).map(([name, c]) => ({ name, ...c }))
  }

  /** The password `name` resolves to — none from `ONEC_<NAME>_PASSWORD` for a connection an agent added. */
  async getSecret(name: string, base?: StoredConnection): Promise<string | null> {
    return (await this.store.read(name, base ?? (await this.getBase(name))))?.password ?? null
  }

  async secretSource(name: string, base?: StoredConnection): Promise<SecretSource> {
    return this.store.source(name, base ?? (await this.getBase(name)))
  }

  missingSecretHint(name: string, base?: StoredConnection): string {
    if (base?.addedBy === 'agent') {
      return `An agent added it, so ${passwordEnvVar(name)} is not used: set a password with set_credentials, or re-add it with the CLI: 1c-odata-mcp add ${name} --force`
    }
    return `Set ${passwordEnvVar(name)} or run: 1c-odata-mcp add ${name}`
  }
}
