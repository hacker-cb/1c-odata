// src/http/admin/health-job.ts
import { verifyConnectivity } from '@1c-odata/mcp/internal'
import { decrypt, type Keyring } from '../../store/crypto.js'
import type { BaseRepo, HealthRepo, SecretRepo } from '../../store/repos.js'
import { classifyProbe } from './bases.js'

export interface HealthJob {
  /** Run one sweep now (resolves when the sweep settles). For tests + startup seed. */
  runOnce(): Promise<void>
  stop(): void
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

  async function sweep(): Promise<void> {
    if (running) return // re-entrancy guard: a slow sweep must not stack
    running = true
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
      deps.log?.error({ err }, 'health sweep failed') // never let a sweep throw out of the timer
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => void sweep(), intervalMs)
  timer.unref?.() // don't keep the event loop alive
  return { runOnce: sweep, stop: () => clearInterval(timer) }
}
