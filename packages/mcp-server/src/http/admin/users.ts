// src/http/admin/users.ts
import { fromNodeHeaders } from 'better-auth/node'
import type { Request, Response } from 'express'
import type { AdminUser } from '../../auth/better-auth.js'
import { logger } from '../../logger.js'
import { countActiveAdmins, getUserById, hasAdminRole, type UserRow } from '../../store/repos.js'
import type { AdminDeps } from './router.js'
import { closeDrawer, drawerFormError, flash, okFlashOob, page, partial, render } from './views.js'

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

/** OOB drawer-close + ok-toast appended after a create/edit row fragment. */
function savedChrome(message: string): string {
  return render('_drawer_close') + render('_flash', { kind: 'ok', message })
}

/**
 * Allowlist for a user id before it is hand-spliced into an HTML attribute / CSS
 * selector. better-auth generates plain [A-Za-z0-9] ids; the schema column is
 * free-form `text`, so we don't trust that locally — the caller checks this first.
 */
const SAFE_USER_ID = /^[A-Za-z0-9_-]+$/

/**
 * A `_user_row` rewritten to replace the live row by id (edit success; form swaps
 * none). The caller validates `id` with {@link SAFE_USER_ID} first, so splicing it
 * into the hx-swap-oob selector/attribute is injection-safe (Eta's escaping doesn't
 * reach this hand-built attribute).
 */
function userRowOob(id: string, row: Record<string, unknown>): string {
  return render('_user_row', row).replace('<tr ', `<tr hx-swap-oob="outerHTML:#user-${id}" `)
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
 * Serializes the admin-count-affecting mutations (demote / ban / delete). Each one
 * is a read ({@link guardTarget}'s "is another active admin left?" count) followed
 * by a write, two separate round-trips — so two concurrent admins can both read `2`,
 * both pass the gate, and both commit, leaving ZERO sign-in-capable admins (a
 * permanent lockout). Chaining them through one in-process promise makes read+write
 * atomic within this process.
 *
 * LIMIT: process-local, and therefore only as strong as the single-writer deployment
 * it assumes — the same assumption the health job already documents for its sweep.
 * It closes the realistic race (two admins clicking in one server), NOT a
 * multi-replica Postgres one, which would need a DB-level lock (`SELECT … FOR
 * UPDATE` / advisory lock).
 */
let adminMutations: Promise<void> = Promise.resolve()

function withAdminLock<T>(fn: () => Promise<T>): Promise<T> {
  // `adminMutations` is kept never-rejecting by the parked link below, so a plain
  // `.then(fn)` always runs the next holder — no onRejected branch needed.
  const run = adminMutations.then(fn)
  // Park a link that swallows this run's outcome. It does two jobs: keeps the chain
  // never-rejecting (a failed mutation must not wedge the next one), and stops
  // `run`'s rejection — which belongs to the caller below — from ALSO surfacing here
  // as an unhandledRejection.
  adminMutations = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * Resolve the precondition for a destructive mutation on user `id`, run by every
 * ban/delete/demote handler so the "protect the acting user and the last usable
 * admin" invariant lives in ONE place. `blockSelf` is off for role changes:
 * self-demotion is legitimate (the UI keeps the role select enabled) and is
 * caught only by the last-admin count.
 *
 * Callers MUST run this and their mutation inside {@link withAdminLock} — the count
 * it reads is only meaningful if nothing else mutates before the write lands.
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

/** GET /admin/users/new — the create-user form (into the drawer's #drawer-body). */
export function newUserForm(_req: Request, res: Response): void {
  partial(res, '_user_create_form', {})
}

/**
 * Re-render the create-user form OOB into the drawer with an inline error, echoing
 * the typed identity (never the password — it lives client-side only). Used instead
 * of a #flash toast because the drawer's top layer would hide the toast.
 */
function recreate(res: Response, req: Request, error: string): void {
  drawerFormError(res, '_user_create_form', {
    // Echo the TRIMMED email so a whitespace-only value re-renders as empty,
    // consistent with the trim-then-required check (not a spaces-filled field).
    email: typeof req.body.email === 'string' ? req.body.email.trim() : '',
    name: String(req.body.name ?? ''),
    role: req.body.role === 'admin' ? 'admin' : 'user',
    error,
  })
}

/** POST /admin/users — create (admin session authorizes; role defaults to 'user'). */
export async function createUser(req: Request, res: Response, deps: AdminDeps): Promise<void> {
  // Validate explicitly: `String(undefined)` would coerce a missing field to the
  // literal "undefined" and create a bogus user. Enforce the 8-char minimum here
  // too (the form's minlength + set-password's server check), else a short
  // password falls through to better-auth and surfaces as a 500 from the error
  // middleware instead of a clean inline error.
  // Trim before the emptiness check (parity with updateUser): a whitespace-only
  // email must fail here with a clear "required", not slip through to better-auth.
  const email = typeof req.body.email === 'string' ? req.body.email.trim() : ''
  const password = req.body.password
  if (email === '') {
    recreate(res, req, 'Email is required.')
    return
  }
  if (typeof password !== 'string' || password.length < 8) {
    recreate(res, req, 'Password must be at least 8 characters.')
    return
  }
  let created: { user: AdminUser }
  try {
    created = await deps.auth.api.createUser({
      headers: fromNodeHeaders(req.headers),
      body: {
        email,
        password,
        name: String(req.body.name ?? ''),
        role: req.body.role === 'admin' ? 'admin' : 'user',
      },
    })
  } catch (err) {
    // Passed the local checks but better-auth rejected it (most often a duplicate
    // email). Re-render the form inline in the drawer rather than letting the
    // rejection hit the router's OOB #flash, which renders behind the open dialog's
    // top layer — the drawer would sit open with no visible error.
    logger.warn({ err: err instanceof Error ? err.message : String(err), email }, 'admin createUser failed')
    recreate(res, req, 'Could not create — the email may already be in use, or was rejected.')
    return
  }
  // Row appended via beforeend (the empty-state placeholder hides itself via CSS
  // :only-child once a real row exists), then OOB drawer-close + ok-toast.
  res
    .type('html')
    .send(render('_user_row', rowData(created.user, actorId(res))) + savedChrome(`User ${created.user.email} created.`))
}

/** GET /admin/users/:id/edit — the identity (email + name) form (into the drawer). */
export async function editUserForm(req: Request, res: Response, deps: AdminDeps): Promise<void> {
  const id = String(req.params.id)
  const target = await getUserById(deps.db, id)
  if (target === undefined) {
    flash(res, 404, 'No such user — reload the page.')
    return
  }
  partial(res, '_user_edit_form', { id, email: target.email, name: target.name })
}

/** POST /admin/users/:id — update the user's email/name (role is edited inline). */
export async function updateUser(req: Request, res: Response, deps: AdminDeps): Promise<void> {
  const id = String(req.params.id)
  const email = typeof req.body.email === 'string' ? req.body.email.trim() : ''
  const name = String(req.body.name ?? '')
  const reform = (error: string): void => {
    // Echo the already-trimmed `email` (what we validate + send), so a whitespace-
    // only value re-renders as empty rather than as a spaces-filled field.
    drawerFormError(res, '_user_edit_form', { id, email, name, error })
  }
  const target = await getUserById(deps.db, id)
  if (target === undefined) {
    // Submitted from the OPEN drawer — a plain flash would hide behind the dialog's
    // top layer, so close the drawer (OOB) and show the error as the surfacing toast.
    res.status(404)
    closeDrawer(res, 'No such user — reload the page.', 'err')
    return
  }
  if (email === '') {
    reform('Email is required.')
    return
  }
  try {
    await deps.auth.api.adminUpdateUser({
      headers: fromNodeHeaders(req.headers),
      body: { userId: id, data: { email, name } },
    })
  } catch (err) {
    // The likely failure is a duplicate email (unique constraint) or a rejected
    // format. Surface it as a clean inline error in the drawer instead of letting
    // it bubble to the router's opaque 500 flash — mirroring the create path.
    logger.warn({ err: err instanceof Error ? err.message : String(err), userId: id }, 'admin updateUser failed')
    reform('Could not save — the email may already be in use, or is invalid.')
    return
  }
  // Re-read the row (adminUpdateUser's return shape isn't relied upon) and replace
  // it OOB, then close the drawer + toast.
  const fresh = (await getUserById(deps.db, id)) ?? { ...target, email, name }
  if (!SAFE_USER_ID.test(id)) {
    // A row exists for this id, so a real better-auth id is always a plain token —
    // this is a can't-happen guard against splicing an unexpected id into the OOB
    // attribute. Degrade to a reload hint instead of hand-building an unsafe target.
    closeDrawer(res, `User ${email} updated — reload to see the row.`)
    return
  }
  res.type('html').send(userRowOob(id, rowData(fresh, actorId(res))) + savedChrome(`User ${email} updated.`))
}

/** POST /admin/users/:id/role — set role (last-admin demotion refused). */
export async function setUserRole(req: Request, res: Response, deps: AdminDeps): Promise<void> {
  const id = String(req.params.id)
  const role = req.body.role === 'admin' ? 'admin' : 'user'
  // Demotion is the lockout-capable direction, so its last-admin count and the
  // setRole that acts on it must be atomic. Promotion only ADDS an admin and can
  // never lock the panel out; it rides the same lock purely for simplicity (admin
  // mutations are rare, so the serialization costs nothing).
  const outcome = await withAdminLock(async () => {
    if (role !== 'admin') {
      const g = await guardTarget(deps, actorId(res), id, 'demote', { blockSelf: false })
      if (!g.ok) return { refused: g }
    }
    const { user } = await deps.auth.api.setRole({
      headers: fromNodeHeaders(req.headers),
      body: { userId: id, role },
    })
    return { user }
  })
  if ('refused' in outcome) {
    const g = outcome.refused
    // The role <select> is showing the refused value; it must snap back to
    // server truth. When we have the target row (last-admin refusal), re-render
    // it (200) plus an OOB error toast — every cell is accurate (getUserById
    // selects them all). A 404 has no row to restore, so just flash.
    if (g.target !== undefined) {
      res
        .type('html')
        .send(
          render('_user_row', rowData(g.target, actorId(res))) + render('_flash', { kind: 'err', message: g.message }),
        )
    } else {
      flash(res, g.status, g.message)
    }
    return
  }
  partial(res, '_user_row', rowData(outcome.user, actorId(res)))
}

/** GET /admin/users/:id/password — the set-password form (into the drawer). */
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
    // Submitted from the OPEN drawer — close it (OOB) so the error toast is visible
    // rather than hidden behind the dialog's top layer.
    res.status(404)
    closeDrawer(res, 'No such user — reload the page.', 'err')
    return
  }
  const password = req.body.password
  if (typeof password !== 'string' || password.length < 8) {
    // Re-render the form OOB into the drawer with the inline error (the form swaps
    // #users-tbody with none, so a plain body would be dropped).
    drawerFormError(res, '_user_password_form', {
      id,
      email: target.email,
      error: 'Password must be at least 8 characters.',
    })
    return
  }
  const headers = fromNodeHeaders(req.headers)
  await deps.auth.api.setUserPassword({ headers, body: { userId: id, newPassword: password } })
  // A password reset must invalidate whoever held the old credential's sessions.
  await deps.auth.api.revokeUserSessions({ headers, body: { userId: id } })
  // No row changes — just close the drawer (OOB) and toast.
  closeDrawer(res, `Password for ${target.email} set — their sessions were revoked.`)
}

/** POST /admin/users/:id/ban — refuse self and the last admin; sessions are revoked. */
export async function banUser(req: Request, res: Response, deps: AdminDeps): Promise<void> {
  const id = String(req.params.id)
  const outcome = await withAdminLock(async () => {
    const g = await guardTarget(deps, actorId(res), id, 'ban', { blockSelf: true })
    if (!g.ok) return { refused: g }
    const headers = fromNodeHeaders(req.headers)
    const { user } = await deps.auth.api.banUser({ headers, body: { userId: id } })
    // banUser already revokes sessions in better-auth; keep the explicit call so the
    // invariant doesn't silently depend on plugin-internal behavior.
    await deps.auth.api.revokeUserSessions({ headers, body: { userId: id } })
    return { user }
  })
  if ('refused' in outcome) {
    flash(res, outcome.refused.status, outcome.refused.message)
    return
  }
  partial(res, '_user_row', rowData(outcome.user, actorId(res)))
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
  const outcome = await withAdminLock(async () => {
    const g = await guardTarget(deps, actorId(res), id, 'delete', { blockSelf: true })
    if (!g.ok) return { refused: g }
    // `grants.sub` FKs `user.id` ON DELETE CASCADE, so removeUser would clear this
    // user's grants on its own; clearing them explicitly FIRST keeps the cleanup
    // independent of that cascade and ordered — if removeUser then fails we've only
    // dropped an existing user's grants (retryable), never orphaned rows.
    await deps.grantRepo.revokeAll(id)
    await deps.auth.api.removeUser({ headers: fromNodeHeaders(req.headers), body: { userId: id } })
    return { target: g.target }
  })
  if ('refused' in outcome) {
    flash(res, outcome.refused.status, outcome.refused.message)
    return
  }
  // OOB-only body: the row's outerHTML swap receives '' (row removed), the toast shows.
  okFlashOob(res, `User ${outcome.target.email} deleted.`)
}
