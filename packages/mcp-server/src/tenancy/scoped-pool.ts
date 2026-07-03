// src/tenancy/scoped-pool.ts
/**
 * A {@link ReadPool} that fronts ONE shared ConnectionPool (so the multi-MB
 * $metadata cache is reused across tenants) but restricts every operation to the
 * bases the session's user is granted.
 *
 * Freshness: `grants()` is invoked on EVERY get/list — never snapshotted — so
 * revoking a grant row stops the user's NEXT tool-call.
 *
 * No-existence-leak: an ungranted base throws the IDENTICAL error the shared pool
 * throws for a base that does not exist at all — we mint the canonical
 * InvalidArgumentError (re-exported from @1c-odata/mcp/internal), so a scoped-out
 * base and an absent base are indistinguishable to the caller.
 */
import { type ConnectionSummary, InvalidArgumentError, type PoolEntry, type ReadPool } from '@1c-odata/mcp/internal'
import type { GrantMap } from './grants.js'

export class ScopedPool implements ReadPool {
  constructor(
    private readonly shared: ReadPool,
    /** Resolves this session's live grants. Called per-op — do NOT memoize the map. */
    private readonly grants: () => Promise<GrantMap>,
  ) {}

  async get(name: string): Promise<PoolEntry> {
    const granted = await this.grants()
    if (!granted.has(name)) {
      // Byte-identical to ConnectionPool.get's absent-base throw — no leak, no fetch.
      throw new InvalidArgumentError(`No connection named "${name}"`, { argument: 'connection' })
    }
    return this.shared.get(name)
  }

  async list(): Promise<ConnectionSummary[]> {
    const granted = await this.grants()
    const all = await this.shared.list()
    return all.filter((c) => granted.has(c.name))
  }

  /**
   * refresh is sync in the interface; bridge the async grant read with a guarded
   * fire-and-forget so a refresh on an ungranted base is a silent no-op (never a
   * leak, never a way to bust another tenant's cache).
   */
  refresh(name: string): void {
    // The `.catch` is load-bearing, not decorative: `grants()` is a live DB query,
    // and this promise is detached (refresh is sync/void, so the caller never
    // awaits it). Without a handler a transient grant-resolution rejection becomes
    // an unhandledRejection, which terminates the whole multi-tenant process under
    // Node's default policy — a cross-tenant DoS from one tenant's cache refresh.
    // refresh is best-effort (a stale $metadata entry self-heals on the next get),
    // so a failed grant read is safely swallowed.
    void this.grants()
      .then((granted) => {
        if (granted.has(name)) this.shared.refresh(name)
      })
      .catch(() => {})
  }
}
