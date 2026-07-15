// src/http/admin/health-job.ts
import { verifyConnectivity } from '@1c-odata/mcp/internal'
import { decrypt, type Keyring } from '../../store/crypto.js'
import type { BaseRepo, HealthRepo, SecretRepo } from '../../store/repos.js'
import { classifyProbe } from './bases.js'

export interface HealthJob {
  /** Run one sweep now (resolves when the sweep settles). For tests + startup seed. */
  runOnce(): Promise<void>
  /**
   * Stop the timer AND await any in-flight sweep, so a probe/HealthRepo write can't
   * race the DB handle closing during shutdown. Idempotent.
   */
  stop(): Promise<void>
}

export interface HealthSweepDeps {
  baseRepo: BaseRepo
  secretRepo: SecretRepo
  healthRepo: HealthRepo
  keyring: Keyring
  probeTimeoutMs?: number
  log?: { error(obj: unknown, msg?: string): void }
}

export interface HealthJobDeps extends HealthSweepDeps {
  intervalMs?: number
}

/**
 * Probe every base once with verifyConnectivity and record ok / auth_failed /
 * unreachable in HealthRepo. The shared body of the periodic job (below) AND the
 * admin panel's on-demand "check now" button. Never throws — a sweep-level failure
 * is logged, not propagated (so the timer / the request handler can't crash).
 */
export async function runHealthSweep(deps: HealthSweepDeps): Promise<void> {
  const probeTimeoutMs = deps.probeTimeoutMs ?? 10_000
  try {
    const bases = await deps.baseRepo.list()
    for (const base of bases) {
      const sealed = await deps.secretRepo.get(base.name)
      if (sealed === null) {
        await deps.healthRepo.upsert(base.name, 'auth_failed', 'No password assigned')
        continue
      }
      let password: string
      try {
        password = decrypt(deps.keyring, base.name, sealed)
      } catch {
        await deps.healthRepo.upsert(base.name, 'auth_failed', 'Secret decryption failed')
        continue
      }
      try {
        await verifyConnectivity({ baseUrl: base.baseUrl, login: base.login, password, timeout: probeTimeoutMs })
        await deps.healthRepo.upsert(base.name, 'ok')
      } catch (err) {
        const { status, message } = classifyProbe(err)
        await deps.healthRepo.upsert(base.name, status, message)
      }
    }
  } catch (err) {
    // Log a serializable shape: a bare Error stringifies to `{}` under the JSON
    // sink, dropping the message. Never let a sweep throw out of the caller.
    deps.log?.error({ err: err instanceof Error ? err.message : String(err) }, 'health sweep failed')
  }
}

/**
 * Single-instance periodic health job: every intervalMs, run {@link runHealthSweep}.
 * No cross-replica coordination — one writer assumed (pglite is single-process;
 * multi-replica pg would multiply probe load — tracked separately).
 */
export function startHealthJob(deps: HealthJobDeps): HealthJob {
  const intervalMs = deps.intervalMs ?? 60_000
  let running = false
  // The currently-running sweep (or a settled promise). `stop()` awaits it so an
  // in-flight probe/write can't race the DB handle closing at shutdown.
  let inflight: Promise<void> = Promise.resolve()

  /** Start a sweep, or return the in-flight one — a slow sweep must not stack (re-entrancy guard). */
  function sweep(): Promise<void> {
    if (running) return inflight
    running = true
    inflight = runHealthSweep(deps).finally(() => {
      running = false
    })
    return inflight
  }

  const timer = setInterval(() => void sweep(), intervalMs)
  timer.unref?.() // don't keep the event loop alive
  return {
    runOnce: sweep,
    async stop() {
      clearInterval(timer)
      await inflight
    },
  }
}
