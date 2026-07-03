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

export interface HealthJobDeps {
  baseRepo: BaseRepo
  secretRepo: SecretRepo
  healthRepo: HealthRepo
  keyring: Keyring
  intervalMs?: number
  probeTimeoutMs?: number
  log?: { error(obj: unknown, msg?: string): void }
}

/**
 * Single-instance periodic health job: every intervalMs, probe each base with
 * verifyConnectivity and record ok/auth_failed/unreachable in HealthRepo. No
 * cross-replica coordination — one writer assumed (pglite is single-process;
 * multi-replica pg would multiply probe load — tracked separately).
 */
export function startHealthJob(deps: HealthJobDeps): HealthJob {
  const intervalMs = deps.intervalMs ?? 60_000
  const probeTimeoutMs = deps.probeTimeoutMs ?? 10_000
  let running = false
  // The currently-running sweep (or a settled promise). `stop()` awaits it so an
  // in-flight probe/write can't race the DB handle closing at shutdown.
  let inflight: Promise<void> = Promise.resolve()

  async function runSweep(): Promise<void> {
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
      // sink, dropping the message. Never let a sweep throw out of the timer.
      deps.log?.error({ err: err instanceof Error ? err.message : String(err) }, 'health sweep failed')
    }
  }

  /** Start a sweep, or return the in-flight one — a slow sweep must not stack (re-entrancy guard). */
  function sweep(): Promise<void> {
    if (running) return inflight
    running = true
    inflight = runSweep().finally(() => {
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
