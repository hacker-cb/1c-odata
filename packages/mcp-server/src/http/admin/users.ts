// src/http/admin/users.ts
import { fromNodeHeaders } from 'better-auth/node'
import type { Request, Response } from 'express'
import type { AdminDeps } from './router.js'
import { page, partial } from './views.js'

/** GET /admin/users — list + create form. */
export async function usersPage(req: Request, res: Response, deps: AdminDeps): Promise<void> {
  const { users } = await deps.auth.api.listUsers({
    headers: fromNodeHeaders(req.headers),
    query: { limit: 200, sortBy: 'email', sortDirection: 'asc' },
  })
  page(res, 'users_list', { users }, 'Users')
}

/** POST /admin/users — create (admin session authorizes; role defaults to 'user'). */
export async function createUser(req: Request, res: Response, deps: AdminDeps): Promise<void> {
  const { user } = await deps.auth.api.createUser({
    headers: fromNodeHeaders(req.headers),
    body: {
      email: String(req.body.email),
      password: String(req.body.password),
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
