// src/http/admin/users.ts
import { fromNodeHeaders } from 'better-auth/node'
import type { Request, Response } from 'express'
import type { AdminUser } from '../../auth/better-auth.js'
import { countActiveAdmins, getUserById, hasAdminRole, type UserRow } from '../../store/repos.js'
import type { AdminDeps } from './router.js'
import { createdRow, flash, okFlashOob, page, partial, render } from './views.js'

/** YYYY-MM-DD from better-auth's createdAt (Date on live objects, string off JSON). */
function fmtCreated(v: Date | string | undefined): string {
  if (v === undefined) return ''
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

/**
 * The `_user_row` template's data bag. `self` drives the "(you)" marker + hides
 * self-Ban/Delete; `roleAdmin` selects the role dropdown the SAME way the rest of
 * the codebase reads roles (a comma/space list containing "admin"), so a
 * multi-role user like "admin,user" shows the right option instead of defaulting
 * to the first — which would misrepresent the server truth and invite an
 * accidental demotion.
 */
function rowData(user: AdminUser | UserRow, actorId: string): Record<string, unknown> {
  return { user, self: user.id === actorId, created: fmtCreated(user.createdAt), roleAdmin: hasAdminRole(user.role) }
}

function actorId(res: Response): string {
  return String((res.locals as { actorId?: string }).actorId ?? '')
}

/**
 * The precondition result for a destructive mutation. `ok:false` carries the
 * refusal the caller renders (each handler chooses flash vs row-snap-back); the
 * loaded `target` rides along on the last-admin case so the demote handler can
 * re-render the row without a second query. Nothing is sent from here — the guard
 * only decides, so a caller can never double-send.
 */
type Guard = { ok: true; target: UserRow } | { ok: false; status: number; message: string; target?: UserRow }

/**
 * Resolve the precondition for a destructive mutation on user `id`, run by every
 * ban/delete/demote handler so the "protect the acting user and the last usable
 * admin" invariant lives in ONE place. `blockSelf` is off for role changes:
 * self-demotion is legitimate (the UI keeps the role select enabled) and is
 * caught only by the last-admin count.
 */
async function guardTarget(
  deps: AdminDeps,
  actorId: string,
  id: string,
  action: string,
  opts: { blockSelf: boolean },
): Promise<Guard> {
  if (opts.blockSelf && id === actorId) {
    return { ok: false, status: 400, message: `You cannot ${action} your own account.` }
  }
  const target = await getUserById(deps.db, id)
  if (target === undefined) {
    return { ok: false, status: 404, message: 'No such user — reload the page.' }
  }
  // Last-admin lockout: this action strips the ONLY sign-in-capable admin. Count
  // ACTIVE (non-banned) admins — a banned admin can't log in, so it is not a
  // usable fallback. Fires only when the target itself is an active admin.
  if (hasAdminRole(target.role) && target.banned !== true && (await countActiveAdmins(deps.db)) <= 1) {
    return {
      ok: false,
      status: 400,
      message: `Cannot ${action} the last admin — the panel would be locked out.`,
      target,
    }
  }
  return { ok: true, target }
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
  // Validate explicitly: `String(undefined)` would coerce a missing field to the
  // literal "undefined" and create a bogus user. Enforce the 8-char minimum here
  // too (the form's minlength + set-password's server check), else a short
  // password falls through to better-auth and surfaces as a 500 from the error
  // middleware instead of a clean 400 toast.
  const email = req.body.email
  const password = req.body.password
  if (typeof email !== 'string' || email === '') {
    flash(res, 400, 'Email is required.')
    return
  }
  if (typeof password !== 'string' || password.length < 8) {
    flash(res, 400, 'Password must be at least 8 characters.')
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
  createdRow(res, '_user_row', rowData(user, actorId(res)), 'users-empty')
}

/** POST /admin/users/:id/role — set role (last-admin demotion refused). */
export async function setUserRole(req: Request, res: Response, deps: AdminDeps): Promise<void> {
  const id = String(req.params.id)
  const role = req.body.role === 'admin' ? 'admin' : 'user'
  if (role !== 'admin') {
    const g = await guardTarget(deps, actorId(res), id, 'demote', { blockSelf: false })
    if (!g.ok) {
      // The role <select> is showing the refused value; it must snap back to
      // server truth. When we have the target row (last-admin refusal), re-render
      // it (200) plus an OOB error toast — every cell is accurate (getUserById
      // selects them all). A 404 has no row to restore, so just flash.
      if (g.target !== undefined) {
        res
          .type('html')
          .send(
            render('_user_row', rowData(g.target, actorId(res))) +
              render('_flash', { kind: 'err', message: g.message }),
          )
      } else {
        flash(res, g.status, g.message)
      }
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
  okFlashOob(res, `Password for ${target.email} set — their sessions were revoked.`)
}

/** POST /admin/users/:id/ban — refuse self and the last admin; sessions are revoked. */
export async function banUser(req: Request, res: Response, deps: AdminDeps): Promise<void> {
  const id = String(req.params.id)
  const g = await guardTarget(deps, actorId(res), id, 'ban', { blockSelf: true })
  if (!g.ok) {
    flash(res, g.status, g.message)
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
  const g = await guardTarget(deps, actorId(res), id, 'delete', { blockSelf: true })
  if (!g.ok) {
    flash(res, g.status, g.message)
    return
  }
  const target = g.target
  // Clear grants BEFORE removing the user: if removeUser then fails, we've only
  // cleared an existing user's grants (retryable), not orphaned grant rows whose
  // owning user is already gone. The grants table has no FK into better-auth's
  // user table, so nothing cascades on its own.
  await deps.grantRepo.revokeAll(id)
  await deps.auth.api.removeUser({ headers: fromNodeHeaders(req.headers), body: { userId: id } })
  // OOB-only body: the row's outerHTML swap receives '' (row removed), the toast shows.
  okFlashOob(res, `User ${target.email} deleted.`)
}
