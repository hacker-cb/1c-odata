import {
  type Connection,
  clientOptionsFromConnection,
  connectionAuth,
  InvalidArgumentError,
  type MetadataIndex,
  ODataV3Client,
} from '@1c-odata/client'
import { buildMetadataIndex, type EdmxModel, fetchMetadataXml, parseEdmx } from '@1c-odata/metadata'
import { loadConfig } from './config.js'
import { passwordEnvVar, type SecretSource, SecretStore } from './secret-store.js'

/** A fully-resolved connection: schema artifacts + a ready client, cached together. */
export interface PoolEntry {
  name: string
  connection: Connection
  /** Parsed EDMX — source of keys + navigation properties for `describe_entity`. */
  edmx: EdmxModel
  /** Runtime index — entity sets, property schemas, enums. */
  index: MetadataIndex
  /** Client wired with the index (date/Int64/ValueStorage handling). */
  client: ODataV3Client
}

export interface ConnectionSummary {
  name: string
  baseUrl: string
  login: string
  serverTimezone: string
  /** Where the password resolves from — never the password itself. */
  passwordSource: SecretSource
  /** Whether the schema has already been fetched into the in-memory cache. */
  loaded: boolean
}

export interface ConnectionPoolOptions {
  dataDir: string
  insecure?: boolean
  /** `$metadata` download timeout (ms). 1С EDMX is 10+ MB on real bases. */
  fetchTimeout?: number
}

/**
 * Lazily resolves connections into ready clients and caches the schema in
 * memory. The first access to a connection downloads `$metadata` ONCE and
 * derives both the {@link EdmxModel} (keys/navigation) and the
 * {@link MetadataIndex} (sets/properties/enums) from the same XML — no double
 * fetch of a multi-megabyte payload.
 */
export class ConnectionPool {
  private readonly dataDir: string
  private readonly store: SecretStore
  private readonly fetchTimeout: number
  private readonly cache = new Map<string, PoolEntry>()

  constructor(opts: ConnectionPoolOptions) {
    this.dataDir = opts.dataDir
    this.store = new SecretStore({ dataDir: opts.dataDir, insecure: opts.insecure ?? false })
    this.fetchTimeout = opts.fetchTimeout ?? 120_000
  }

  /** Configured connections (no secrets), each annotated with its password source. */
  async list(): Promise<ConnectionSummary[]> {
    const config = loadConfig(this.dataDir)
    const summaries: ConnectionSummary[] = []
    for (const name of Object.keys(config.connections).sort()) {
      const c = config.connections[name]
      if (c === undefined) continue
      summaries.push({
        name,
        baseUrl: c.baseUrl,
        login: c.login,
        serverTimezone: c.serverTimezone,
        passwordSource: await this.store.source(name),
        loaded: this.cache.has(name),
      })
    }
    return summaries
  }

  /** Resolve a ready entry, fetching + building the schema on first access. */
  async get(name: string): Promise<PoolEntry> {
    const cached = this.cache.get(name)
    if (cached !== undefined) return cached

    const config = loadConfig(this.dataDir)
    const stored = config.connections[name]
    if (stored === undefined) {
      throw new InvalidArgumentError(`No connection named "${name}"`, { argument: 'connection' })
    }

    const secret = await this.store.read(name)
    if (secret === null) {
      throw new InvalidArgumentError(
        `No password for "${name}". Set ${passwordEnvVar(name)} or run: 1c-odata-mcp add ${name}`,
        { argument: 'connection' },
      )
    }

    const connection: Connection = {
      baseUrl: stored.baseUrl,
      auth: { username: stored.login, password: secret.password },
      serverTimezone: stored.serverTimezone,
      ...(stored.shape !== undefined ? { shape: stored.shape } : {}),
    }

    const xml = await fetchMetadataXml({
      baseUrl: connection.baseUrl,
      auth: connectionAuth(connection),
      timeout: this.fetchTimeout,
    })
    const edmx = parseEdmx(xml)
    const index = buildMetadataIndex(edmx, stored.shape !== undefined ? { shape: stored.shape } : {})
    const client = new ODataV3Client({ ...clientOptionsFromConnection(connection), metadataIndex: index })

    const entry: PoolEntry = { name, connection, edmx, index, client }
    this.cache.set(name, entry)
    return entry
  }

  /** Drop a cached entry so the next {@link get} re-downloads `$metadata`. */
  refresh(name: string): void {
    this.cache.delete(name)
  }
}
