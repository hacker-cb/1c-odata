// src/http/admin/users.ts
import { fromNodeHeaders } from 'better-auth/node'
import type { Request, Response } from 'express'
import type { AdminUser } from '../../auth/better-auth.js'
import { countAdmins, getUserById, hasAdminRole } from '../../store/repos.js'
import type { AdminDeps } from './router.js'
import { flash, page, partial, render } from './views.js'

/** YYYY-MM-DD from better-auth's createdAt (Date on live objects, string off JSON). */
function fmtCreated(v: Date | string | undefined): string {
  if (v === undefined) return ''
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

/** The `_user_row` template's data bag. `self` drives the "(you)" marker + hides self-Ban/Delete. */
function rowData(user: AdminUser, actorId: string): Record<string, unknown> {
  return { user, self: user.id === actorId, created: fmtCreated(user.createdAt) }
}

function actorId(res: Response): string {
  return String((res.locals as { actorId?: string }).actorId ?? '')
}

/**
 * Last-admin lockout guard: demoting, banning or deleting the ONLY admin would
 * leave the panel with no one able to sign in (self-service sign-up is off).
 * Returns the refusal message, or null when the mutation is safe.
 */
async function lastAdminGuard(deps: AdminDeps, targetRole: string | null, action: string): Promise<string | null> {
  if (!hasAdminRole(targetRole)) return null
  if ((await countAdmins(deps.db)) > 1) return null
  return `Cannot ${action} the last admin — the panel would be locked out.`
}

/** GET /admin/users — list + create form. */
export async function usersPage(req: Request, res: Response, deps: AdminDeps): Promise<void> {
  const { users } = await deps.auth.api.listUsers({
    headers: fromNodeHeaders(req.headers),
    query: { limit: 200, sortBy: 'email', sortDirection: 'asc' },
  })
  const actor = actorId(res)
  page(res, 'users_list', { users: users.map((u) => rowData(u, actor)) }, 'Users', 'users')
}

/** POST /admin/users — create (admin session authorizes; role defaults to 'user'). */
export async function createUser(req: Request, res: Response, deps: AdminDeps): Promise<void> {
  // Validate presence explicitly: `String(undefined)` would coerce a missing field
  // to the literal "undefined" and create a bogus user (or surface as a 500 from
  // the admin error middleware). Mirror toggleGrant's 400 + flash-toast contract.
  const email = req.body.email
  const password = req.body.password
  if (typeof email !== 'string' || email === '' || typeof password !== 'string' || password === '') {
    flash(res, 400, 'Missing email or password.')
    return
  }
  const { user } = await deps.auth.api.createUser({
    headers: fromNodeHeaders(req.headers),
    body: {
      email,
      password,
      name: String(req.body.name ?? ''),
      role: req.body.role === 'admin' ? 'admin' : 'user',
    },
  })
  partial(res, '_user_row', rowData(user, actorId(res)))
}

/** POST /admin/users/:id/role — set role (last-admin demotion refused). */
export async function setUserRole(req: Request, res: Response, deps: AdminDeps): Promise<void> {
  const id = String(req.params.id)
  const role = req.body.role === 'admin' ? 'admin' : 'user'
  if (role !== 'admin') {
    const target = await getUserById(deps.db, id)
    if (target === undefined) {
      flash(res, 404, 'No such user — reload the page.')
      return
    }
    const guard = await lastAdminGuard(deps, target.role, 'demote')
    if (guard !== null) {
      // 200 + the CURRENT row + an OOB error toast: the select must snap back to
      // the server-side truth (a bare 4xx flash would leave it showing the
      // refused value).
      res
        .type('html')
        .send(
          render('_user_row', rowData(toAdminUser(target), actorId(res))) +
            render('_flash', { kind: 'err', message: guard }),
        )
      return
    }
  }
  const { user } = await deps.auth.api.setRole({
    headers: fromNodeHeaders(req.headers),
    body: { userId: id, role },
  })
  partial(res, '_user_row', rowData(user, actorId(res)))
}

/** GET /admin/users/:id/password — the set-password form (into #user-form-slot). */
export async function passwordForm(req: Request, res: Response, deps: AdminDeps): Promise<void> {
  const id = String(req.params.id)
  const target = await getUserById(deps.db, id)
  if (target === undefined) {
    flash(res, 404, 'No such user — reload the page.')
    return
  }
  partial(res, '_user_password_form', { id, email: target.email })
}

/** POST /admin/users/:id/password — set it, then revoke the user's sessions. */
export async function setUserPassword(req: Request, res: Response, deps: AdminDeps): Promise<void> {
  const id = String(req.params.id)
  const target = await getUserById(deps.db, id)
  if (target === undefined) {
    flash(res, 404, 'No such user — reload the page.')
    return
  }
  const password = req.body.password
  if (typeof password !== 'string' || password.length < 8) {
    partial(res, '_user_password_form', { id, email: target.email, error: 'Password must be at least 8 characters.' })
    return
  }
  const headers = fromNodeHeaders(req.headers)
  await deps.auth.api.setUserPassword({ headers, body: { userId: id, newPassword: password } })
  // A password reset must invalidate whoever held the old credential's sessions.
  await deps.auth.api.revokeUserSessions({ headers, body: { userId: id } })
  // OOB-only body: the slot's innerHTML swap receives '' (form closes), the toast shows.
  res
    .type('html')
    .send(render('_flash', { kind: 'ok', message: `Password for ${target.email} set — their sessions were revoked.` }))
}

/** POST /admin/users/:id/ban — refuse self and the last admin; sessions are revoked. */
export async function banUser(req: Request, res: Response, deps: AdminDeps): Promise<void> {
  const id = String(req.params.id)
  if (id === actorId(res)) {
    flash(res, 400, 'You cannot ban your own account.')
    return
  }
  const target = await getUserById(deps.db, id)
  if (target === undefined) {
    flash(res, 404, 'No such user — reload the page.')
    return
  }
  const guard = await lastAdminGuard(deps, target.role, 'ban')
  if (guard !== null) {
    flash(res, 400, guard)
    return
  }
  const headers = fromNodeHeaders(req.headers)
  const { user } = await deps.auth.api.banUser({ headers, body: { userId: id } })
  // banUser already revokes sessions in better-auth; keep the explicit call so the
  // invariant doesn't silently depend on plugin-internal behavior.
  await deps.auth.api.revokeUserSessions({ headers, body: { userId: id } })
  partial(res, '_user_row', rowData(user, actorId(res)))
}

/** POST /admin/users/:id/unban. */
export async function unbanUser(req: Request, res: Response, deps: AdminDeps): Promise<void> {
  const id = String(req.params.id)
  const { user } = await deps.auth.api.unbanUser({
    headers: fromNodeHeaders(req.headers),
    body: { userId: id },
  })
  partial(res, '_user_row', rowData(user, actorId(res)))
}

/** DELETE /admin/users/:id — refuse self and the last admin; grants are cleaned up. */
export async function deleteUser(req: Request, res: Response, deps: AdminDeps): Promise<void> {
  const id = String(req.params.id)
  if (id === actorId(res)) {
    flash(res, 400, 'You cannot delete your own account.')
    return
  }
  const target = await getUserById(deps.db, id)
  if (target === undefined) {
    flash(res, 404, 'No such user — reload the page.')
    return
  }
  const guard = await lastAdminGuard(deps, target.role, 'delete')
  if (guard !== null) {
    flash(res, 400, guard)
    return
  }
  await deps.auth.api.removeUser({ headers: fromNodeHeaders(req.headers), body: { userId: id } })
  // The grants table has no FK into better-auth's user table — clean up explicitly
  // so a future user with a recycled sub can't inherit orphaned grants.
  await deps.grantRepo.revokeAll(id)
  // OOB-only body: the row's outerHTML swap receives '' (row removed), the toast shows.
  res.type('html').send(render('_flash', { kind: 'ok', message: `User ${target.email} deleted.` }))
}

/** Widen a users-table DB row to the template's AdminUser shape. */
function toAdminUser(row: {
  id: string
  email: string
  name?: string | null
  role: string | null
  banned?: boolean | null
  createdAt?: Date | string
}): AdminUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name ?? '',
    role: row.role,
    banned: row.banned ?? null,
    ...(row.createdAt !== undefined ? { createdAt: row.createdAt } : {}),
  }
}
