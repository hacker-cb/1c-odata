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
import { connectionLabel, type StoredConnection } from './config.js'
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
  /**
   * `'agent'` where an agent added the connection (`add_connection`): its
   * password never comes from `ONEC_<NAME>_PASSWORD`, set or not.
   */
  addedBy?: 'agent'
  /** Whether the schema has already been fetched into the in-memory cache. */
  loaded: boolean
}

/**
 * The read-facing slice of {@link ConnectionPool} that the tool registrators
 * depend on. A per-session scoping wrapper in a multi-tenant host implements
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
 * What a cached entry was built from: the descriptor fields that reach the
 * client or its schema, and the password it authenticates with. `label` is
 * cosmetic and `addedBy` only decides which password is read — both stay out.
 */
interface BuiltFrom {
  /** `baseUrl`, `login`, `serverTimezone` and `shape`, serialized. */
  descriptor: string
  /** Held exactly as the client already holds it — never logged, listed or put in an error. */
  password: string
}

/** A cache slot: the entry (built or building) and what it was built from. */
interface CacheSlot {
  entry: Promise<PoolEntry>
  builtFrom: BuiltFrom
}

/** The part of {@link BuiltFrom} a descriptor alone decides. */
function descriptorKey(stored: StoredConnection): string {
  return JSON.stringify([stored.baseUrl, stored.login, stored.serverTimezone, stored.shape ?? null])
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
 *
 * Every {@link get} re-reads the connection from its source and checks it
 * against what the cached entry was built from (#274): another process — the
 * CLI `remove` / `add --force`, or another MCP server on the same config — may
 * have changed or removed it since. A changed descriptor or password rebuilds
 * the entry; a removed connection, or one left with no password, drops it and
 * fails as an unknown or password-less one would.
 */
export class ConnectionPool implements ReadPool {
  private readonly source: ConnectionSource
  private readonly fetchTimeout: number
  private readonly cache = new Map<string, CacheSlot>()
  /** The signal of the `$metadata` downloads started since the last {@link abortDownloads}. */
  private downloads = new AbortController()
  /** The builds still in flight — what {@link abortDownloads} drops from the cache. */
  private readonly building = new Set<Promise<PoolEntry>>()

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
        passwordSource: await this.source.secretSource(c.name, c),
        ...(c.addedBy === 'agent' ? { addedBy: c.addedBy } : {}),
        loaded: this.cache.get(c.name)?.builtFrom.descriptor === descriptorKey(c),
      })),
    )
    return summaries.sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * Resolve a ready entry, fetching + building the schema on first access. The
   * in-flight Promise is cached, so concurrent calls for the same uncached
   * connection share ONE `$metadata` download instead of racing. Each call
   * first re-reads the connection and its password from the source; an entry
   * built from anything else is replaced (see the class doc, #274).
   */
  async get(name: string): Promise<PoolEntry> {
    // Taken before the source reads: a call still reading when abortDownloads runs fails with the rest.
    const signal = this.downloads.signal
    const stored = await this.source.getBase(name)
    if (stored === undefined) {
      this.cache.delete(name)
      throw new InvalidArgumentError(`No connection named "${name}"`, { argument: 'connection' })
    }
    // The descriptor read above: the password is resolved for the target it goes to.
    const secret = await this.source.getSecret(name, stored)
    if (secret === null) {
      this.cache.delete(name)
      const hint = this.source.missingSecretHint?.(name, stored)
      throw new InvalidArgumentError(`No password for "${name}".${hint !== undefined ? ` ${hint}` : ''}`, {
        argument: 'connection',
      })
    }
    signal.throwIfAborted()

    // From here to the cache write nothing awaits: concurrent calls see one slot.
    const builtFrom: BuiltFrom = { descriptor: descriptorKey(stored), password: secret }
    const cached = this.cache.get(name)
    if (cached !== undefined && sameBuild(cached.builtFrom, builtFrom)) return cached.entry

    const pending = this.build(name, stored, secret, signal)
    const slot: CacheSlot = { entry: pending, builtFrom }
    this.cache.set(name, slot)
    this.building.add(pending)
    try {
      return await pending
    } catch (err) {
      // Never cache a failed build — let the next call retry.
      if (this.cache.get(name) === slot) this.cache.delete(name)
      throw err
    } finally {
      this.building.delete(pending)
    }
  }

  /**
   * Build an entry from the descriptor and password {@link get} read; `signal`
   * aborts its `$metadata` download.
   */
  private async build(name: string, stored: StoredConnection, secret: string, signal: AbortSignal): Promise<PoolEntry> {
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
      signal,
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

  /**
   * Abort every `$metadata` download in flight — which no single call's cancel
   * does, a download being shared by every call waiting on its connection — and
   * drop the entries still building, so the calls waiting on them fail and the
   * next {@link get} builds anew. For a host whose server closed; the entries
   * already built stay, and the pool stays usable.
   */
  abortDownloads(): void {
    this.downloads.abort()
    this.downloads = new AbortController()
    for (const [name, slot] of this.cache) if (this.building.has(slot.entry)) this.cache.delete(name)
  }
}

/** Whether a cached entry built from `a` is still what `b` — the source's current answer — builds. */
function sameBuild(a: BuiltFrom, b: BuiltFrom): boolean {
  return a.descriptor === b.descriptor && a.password === b.password
}
