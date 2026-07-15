// src/http/admin/dashboard.ts
import type { Request, Response } from 'express'
import type { AdminDeps } from './router.js'
import { adminServerInfo } from './server-info.js'
import { page, partial } from './views.js'

interface HealthRow {
  baseName: string
  status: string
  lastCheck: string
  error: string
  /** Being re-probed in the current sweep (lastCheck predates the sweep start) → spinner. */
  checking: boolean
}

/**
 * Every base joined to its latest health row (a base with no row yet shows
 * `unknown`). `checking` marks a base still being probed in the active on-demand
 * sweep: `optimisticAll` (the button's own response) shows every base as checking
 * up front; the follow-up polls derive it per base from `since` (the sweep start) —
 * a base whose last probe predates it, or that has no row yet, is still checking.
 * Listing BASES (not health rows) makes a never-probed base visible with its spinner.
 */
async function buildRows(deps: AdminDeps, since: Date | null, optimisticAll: boolean): Promise<HealthRow[]> {
  const [bases, health] = await Promise.all([deps.baseRepo.list(), deps.healthRepo.list()])
  const byName = new Map(health.map((h) => [h.baseName, h]))
  return bases.map((b) => {
    const h = byName.get(b.name)
    return {
      baseName: b.name,
      status: h?.status ?? 'unknown',
      lastCheck: h !== undefined ? h.lastCheck.toISOString().replace('T', ' ').slice(0, 19) : '',
      error: h?.error ?? '',
      checking: optimisticAll || (since !== null && (h === undefined || h.lastCheck < since)),
    }
  })
}

/** GET /admin — dashboard shell. */
export async function dashboardPage(_req: Request, res: Response, deps: AdminDeps): Promise<void> {
  const [serverInfo, rows] = await Promise.all([adminServerInfo(deps), buildRows(deps, deps.checkingSince(), false)])
  page(res, 'dashboard', { serverInfo, rows, anyChecking: rows.some((r) => r.checking) }, 'Dashboard', 'dashboard')
}

/** GET /admin/health/table — htmx poll target (also the fast poll while a sweep runs). */
export async function healthTable(_req: Request, res: Response, deps: AdminDeps): Promise<void> {
  const rows = await buildRows(deps, deps.checkingSince(), false)
  partial(res, '_health_rows', { rows, anyChecking: rows.some((r) => r.checking) })
}

/**
 * POST /admin/health/check — the "check connections now" button. Kicks the guarded
 * sweep in the BACKGROUND (startOnDemandCheck does NOT await) so the response returns
 * immediately showing EVERY base as "checking" (optimistic); the fast poll (a
 * self-triggering row the fragment emits while `anyChecking`) then flips each base to
 * its result as the sweep writes it, and stops once the on-demand check settles.
 */
export async function checkHealthNow(_req: Request, res: Response, deps: AdminDeps): Promise<void> {
  deps.startOnDemandCheck() // marks the check active + launches the sweep (fire-and-forget)
  const rows = await buildRows(deps, deps.checkingSince(), true)
  partial(res, '_health_rows', { rows, anyChecking: rows.some((r) => r.checking) })
}
