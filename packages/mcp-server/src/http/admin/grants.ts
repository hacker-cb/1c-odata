// src/http/admin/grants.ts
import { fromNodeHeaders } from 'better-auth/node'
import type { Request, Response } from 'express'
import type { GrantScope } from '../../store/repos.js'
import type { AdminDeps } from './router.js'
import { flash, page, partial, render } from './views.js'

/**
 * Postgres `foreign_key_violation`. `grants.sub` FKs `user.id` and
 * `grants.base_name` FKs `bases.name`, so granting against a user/base that was
 * deleted while the matrix was on screen raises this instead of inserting. Both
 * dialects are Postgres (pg + pglite), so the SQLSTATE is the reliable signal —
 * message text is not.
 */
const PG_FOREIGN_KEY_VIOLATION = '23503'

/**
 * Walk the `cause` chain, not just the thrown error: drizzle re-throws driver
 * failures wrapped in its own `DrizzleQueryError` ("Failed query: …"), which carries
 * no SQLSTATE — the pg/pglite error holding `code` sits underneath. The depth cap is
 * a cheap guard against a self-referential chain.
 */
function isForeignKeyViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e !== null && e !== undefined && depth < 5; depth++) {
    if (typeof e === 'object' && (e as { code?: unknown }).code === PG_FOREIGN_KEY_VIOLATION) return true
    e = (e as { cause?: unknown }).cause
  }
  return false
}

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

  try {
    if (granted) await deps.grantRepo.grant(sub, base, scope)
    else await deps.grantRepo.revoke(sub, base)
  } catch (err) {
    // The user or base was deleted while this matrix was open, so the grant INSERT
    // hit an FK. Snap the checkbox back to server truth (NOT granted — nothing was
    // written) and toast "reload", instead of a generic 500 that leaves the box
    // looking applied. A revoke can't hit this (a DELETE of an already-cascaded row
    // is a no-op), so only the grant path lands here.
    //
    // 200, like the last-admin snap-back in users.ts: when the body IS server truth
    // for the request's own target, it must swap. (4xx would swap too — shell.ts
    // overrides htmx's responseHandling to make error bodies swappable — but the
    // status carries no meaning htmx acts on here, and matching the existing idiom
    // keeps this independent of that config.)
    if (!isForeignKeyViolation(err)) throw err
    res
      .type('html')
      .send(
        render('_grant_cell', { sub, base, granted: false, scope }) +
          render('_flash', { kind: 'err', message: 'That user or base no longer exists — reload the page.' }),
      )
    return
  }

  // The cell's aria-label needs only the base (the user comes from the row's
  // <th scope="row">), so nothing user-controlled rides in hx-vals.
  partial(res, '_grant_cell', { sub, base, granted, scope })
}
