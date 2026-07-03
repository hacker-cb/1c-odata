// src/http/admin/grants.ts
import { fromNodeHeaders } from 'better-auth/node'
import type { Request, Response } from 'express'
import type { GrantScope } from '../../store/repos.js'
import type { AdminDeps } from './router.js'
import { page, partial } from './views.js'

/** GET /admin/grants — user × base matrix. */
export async function grantsPage(req: Request, res: Response, deps: AdminDeps): Promise<void> {
  const { users } = await deps.auth.api.listUsers({
    headers: fromNodeHeaders(req.headers),
    query: { limit: 200, sortBy: 'email', sortDirection: 'asc' },
  })
  const bases = (await deps.baseRepo.list()).map((b) => b.name)

  // matrix key = `${sub}|${base}` → scope. One resolve() per user (small N).
  const matrix: Record<string, GrantScope> = {}
  for (const u of users) {
    const g = await deps.grantRepo.resolve(u.id)
    for (const [base, scope] of g) matrix[`${u.id}|${base}`] = scope
  }
  page(res, 'grants_editor', { users, bases, matrix }, 'Grants')
}

/** POST /admin/grants/toggle — set/revoke one cell, return the swapped cell. */
export async function toggleGrant(req: Request, res: Response, deps: AdminDeps): Promise<void> {
  const sub = String(req.body.sub)
  const base = String(req.body.base)
  const scope: GrantScope = req.body.scope === 'write' ? 'write' : 'read'
  const granted = req.body.granted === 'on'

  if (granted) await deps.grantRepo.grant(sub, base, scope)
  else await deps.grantRepo.revoke(sub, base)

  partial(res, '_grant_cell', { sub, base, granted, scope })
}
