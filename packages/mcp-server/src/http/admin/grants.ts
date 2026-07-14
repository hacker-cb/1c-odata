// src/http/admin/grants.ts
import { fromNodeHeaders } from 'better-auth/node'
import type { Request, Response } from 'express'
import type { GrantScope } from '../../store/repos.js'
import type { AdminDeps } from './router.js'
import { flash, page, partial } from './views.js'

/** GET /admin/grants — user × base matrix. */
export async function grantsPage(req: Request, res: Response, deps: AdminDeps): Promise<void> {
  const { users } = await deps.auth.api.listUsers({
    headers: fromNodeHeaders(req.headers),
    query: { limit: 200, sortBy: 'email', sortDirection: 'asc' },
  })
  const bases = (await deps.baseRepo.list()).map((b) => b.name)

  // matrix key = `${sub}|${base}` → scope. ONE query for every grant, not an
  // N+1 resolve() per user (up to 200 sequential queries for a 200-user list).
  const matrix: Record<string, GrantScope> = {}
  for (const g of await deps.grantRepo.listAll()) matrix[`${g.sub}|${g.baseName}`] = g.scope
  page(res, 'grants_editor', { users, bases, matrix }, 'Grants', 'grants')
}

/** POST /admin/grants/toggle — set/revoke one cell, return the swapped cell. */
export async function toggleGrant(req: Request, res: Response, deps: AdminDeps): Promise<void> {
  // Validate presence explicitly: `String(undefined)` would coerce a missing field
  // to the literal "undefined" and silently grant/revoke a bogus (sub, base).
  const sub = req.body.sub
  const base = req.body.base
  if (typeof sub !== 'string' || sub === '' || typeof base !== 'string' || base === '') {
    flash(res, 400, 'Missing sub or base.')
    return
  }
  const scope: GrantScope = req.body.scope === 'write' ? 'write' : 'read'
  const granted = req.body.granted === 'on'

  if (granted) await deps.grantRepo.grant(sub, base, scope)
  else await deps.grantRepo.revoke(sub, base)

  // The cell's aria-label needs only the base (the user comes from the row's
  // <th scope="row">), so nothing user-controlled rides in hx-vals.
  partial(res, '_grant_cell', { sub, base, granted, scope })
}
