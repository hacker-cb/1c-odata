// src/http/admin/users.ts
import { fromNodeHeaders } from 'better-auth/node'
import type { Request, Response } from 'express'
import type { AdminDeps } from './router.js'
import { flash, page, partial } from './views.js'

/** GET /admin/users — list + create form. */
export async function usersPage(req: Request, res: Response, deps: AdminDeps): Promise<void> {
  const { users } = await deps.auth.api.listUsers({
    headers: fromNodeHeaders(req.headers),
    query: { limit: 200, sortBy: 'email', sortDirection: 'asc' },
  })
  page(res, 'users_list', { users }, 'Users', 'users')
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
  partial(res, '_user_row', { user })
}

/** POST /admin/users/:id/role — set role. */
export async function setUserRole(req: Request, res: Response, deps: AdminDeps): Promise<void> {
  const role = req.body.role === 'admin' ? 'admin' : 'user'
  const { user } = await deps.auth.api.setRole({
    headers: fromNodeHeaders(req.headers),
    body: { userId: String(req.params.id), role },
  })
  partial(res, '_user_row', { user })
}
