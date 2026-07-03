// src/http/admin/dashboard.ts
import type { Request, Response } from 'express'
import type { AdminDeps } from './router.js'
import { adminServerInfo } from './server-info.js'
import { page, partial } from './views.js'

function toRows(health: { baseName: string; status: string; lastCheck: Date; error: string | null }[]) {
  return health.map((h) => ({
    baseName: h.baseName,
    status: h.status,
    lastCheck: h.lastCheck.toISOString().replace('T', ' ').slice(0, 19),
    error: h.error ?? '',
  }))
}

/** GET /admin — dashboard shell. */
export async function dashboardPage(_req: Request, res: Response, deps: AdminDeps): Promise<void> {
  const [serverInfo, health] = await Promise.all([adminServerInfo(deps), deps.healthRepo.list()])
  page(res, 'dashboard', { serverInfo, rows: toRows(health) }, 'Dashboard')
}

/** GET /admin/health/table — htmx poll target. */
export async function healthTable(_req: Request, res: Response, deps: AdminDeps): Promise<void> {
  partial(res, '_health_rows', { rows: toRows(await deps.healthRepo.list()) })
}
