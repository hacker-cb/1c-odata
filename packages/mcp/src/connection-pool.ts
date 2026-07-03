import {
  type Connection,
  clientOptionsFromConnection,
  connectionAuth,
  InvalidArgumentError,
  type MetadataIndex,
  ODataV3Client,
  validateConnection,
} from '@1c-odata/client'
import { buildMetadataIndex, type EdmxModel, fetchMetadataXml, parseEdmx } from '@1c-odata/metadata'
import { connectionLabel } from './config.js'
import type { ConnectionSource } from './connection-source.js'
import { DEFAULT_METADATA_TIMEOUT_MS } from './constants.js'
import type { SecretSource } from './secret-store.js'

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
  /** Human-readable display label; the connection `name` when none was set. */
  label: string
  baseUrl: string
  login: string
  serverTimezone: string
  /** Where the password resolves from — never the password itself. */
  passwordSource: SecretSource
  /** Whether the schema has already been fetched into the in-memory cache. */
  loaded: boolean
}

/**
 * The read-facing slice of {@link ConnectionPool} that the tool registrators
 * depend on. A per-session scoping wrapper (`@1c-odata/mcp-server`) implements
 * this same interface to gate access to a subset of bases without re-fetching
 * `$metadata`, so registrators take a `ReadPool` rather than the concrete pool.
 *
 * @internal Not part of the semver-stable surface — see STABILITY.md.
 */
export interface ReadPool {
  get(name: string): Promise<PoolEntry>
  list(): Promise<ConnectionSummary[]>
  refresh(name: string): void
}

export interface ConnectionPoolOptions {
  /** `$metadata` download timeout (ms). 1С EDMX is 10+ MB on real bases. */
  fetchTimeout?: number
}

/**
 * Lazily resolves connections into ready clients and caches the schema in
 * memory. The first access to a connection downloads `$metadata` ONCE and
 * derives both the {@link EdmxModel} (keys/navigation) and the
 * {@link MetadataIndex} (sets/properties/enums) from the same XML — no double
 * fetch of a multi-megabyte payload.
 *
 * Where connections and secrets come from is abstracted behind a
 * {@link ConnectionSource}: the local stdio server injects a
 * {@link FileConnectionSource} (config.json + keychain), a multi-tenant host a
 * DB-backed one. The cache is keyed on the connection name and is process-global
 * for the pool's lifetime, so it can be shared across sessions.
 */
export class ConnectionPool implements ReadPool {
  private readonly source: ConnectionSource
  private readonly fetchTimeout: number
  private readonly cache = new Map<string, Promise<PoolEntry>>()

  constructor(source: ConnectionSource, opts: ConnectionPoolOptions = {}) {
    this.source = source
    this.fetchTimeout = opts.fetchTimeout ?? DEFAULT_METADATA_TIMEOUT_MS
  }

  /** Configured connections (no secrets), each annotated with its password source. */
  async list(): Promise<ConnectionSummary[]> {
    const bases = await this.source.listBases()
    // Sort here (not in the source) so every source yields a stable ordering.
    // Each password source may hit the keychain/DB independently — fan out.
    const summaries = await Promise.all(
      bases.map(async (c) => ({
        name: c.name,
        label: connectionLabel(c.name, c),
        baseUrl: c.baseUrl,
        login: c.login,
        serverTimezone: c.serverTimezone,
        passwordSource: await this.source.secretSource(c.name),
        loaded: this.cache.has(c.name),
      })),
    )
    return summaries.sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * Resolve a ready entry, fetching + building the schema on first access. The
   * in-flight Promise is cached, so concurrent calls for the same uncached
   * connection share ONE `$metadata` download instead of racing.
   */
  async get(name: string): Promise<PoolEntry> {
    const cached = this.cache.get(name)
    if (cached !== undefined) return cached

    const pending = this.build(name)
    this.cache.set(name, pending)
    try {
      return await pending
    } catch (err) {
      // Never cache a failed build — let the next call retry.
      if (this.cache.get(name) === pending) this.cache.delete(name)
      throw err
    }
  }

  private async build(name: string): Promise<PoolEntry> {
    const stored = await this.source.getBase(name)
    if (stored === undefined) {
      throw new InvalidArgumentError(`No connection named "${name}"`, { argument: 'connection' })
    }

    const secret = await this.source.getSecret(name)
    if (secret === null) {
      const hint = this.source.missingSecretHint?.(name)
      throw new InvalidArgumentError(`No password for "${name}".${hint !== undefined ? ` ${hint}` : ''}`, {
        argument: 'connection',
      })
    }

    const connection: Connection = {
      baseUrl: stored.baseUrl,
      auth: { username: stored.login, password: secret },
      serverTimezone: stored.serverTimezone,
      ...(stored.shape !== undefined ? { shape: stored.shape } : {}),
    }
    // Validate the loaded connection (incl. IANA timezone) BEFORE the multi-MB
    // $metadata download, so a bad hand-edited config.json fails instantly with a
    // clear message instead of after a full fetch. upsertConnection validates on
    // the add path; a hand-edited / migrated config.json bypasses that, and the
    // client constructor would otherwise only reject it post-download.
    validateConnection(connection)

    // Inline fetch→parse→build (rather than metadata's fetchMetadataIndex) so we
    // keep the intermediate EdmxModel for describe_entity (keys/navigation) —
    // fetchMetadataIndex discards it, and reusing it would force a second parse.
    const xml = await fetchMetadataXml({
      baseUrl: connection.baseUrl,
      auth: connectionAuth(connection),
      timeout: this.fetchTimeout,
    })
    const edmx = parseEdmx(xml)
    const index = buildMetadataIndex(edmx, stored.shape !== undefined ? { shape: stored.shape } : {})
    const client = new ODataV3Client({ ...clientOptionsFromConnection(connection), metadataIndex: index })

    return { name, connection, edmx, index, client }
  }

  /** Drop a cached entry so the next {@link get} re-downloads `$metadata`. */
  refresh(name: string): void {
    this.cache.delete(name)
  }
}
