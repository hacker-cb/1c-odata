// test/unit/admin-users.test.ts
//
// The user-management handlers' GUARDS and side-effects, against a real pglite
// user table (countAdmins/getUserById read it directly) with the better-auth
// admin API stubbed — the plugin's own behavior is not under test here.
import type { ReadPool } from '@1c-odata/mcp/internal'
import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { user } from '../../auth-schema.js'
import type { AdminDeps } from '../../src/http/admin/router.js'
import { banUser, deleteUser, setUserPassword, setUserRole } from '../../src/http/admin/users.js'
import { loadKeyring } from '../../src/store/crypto.js'
import { createDb, type DbHandle } from '../../src/store/db.js'
import { runAuthMigrations } from '../../src/store/migrate.js'
import { BaseRepo, GrantRepo, HealthRepo, SecretRepo } from '../../src/store/repos.js'

const KEY = Buffer.alloc(32, 9).toString('base64')

interface FakeRes {
  statusCode: number
  body: string
  headers: Record<string, string | string[]>
  locals: Record<string, unknown>
  type(): FakeRes
  status(c: number): FakeRes
  setHeader(k: string, v: string | string[]): FakeRes
  send(b: string): FakeRes
}

function res(actorId: string): FakeRes {
  const r: FakeRes = {
    statusCode: 200,
    body: '',
    headers: {},
    locals: { actorId },
    type: () => r,
    status: (c) => {
      r.statusCode = c
      return r
    },
    setHeader: (k, v) => {
      r.headers[k] = v
      return r
    },
    send: (b) => {
      r.body = b
      return r
    },
  }
  return r
}

const api = {
  setRole: vi.fn(),
  setUserPassword: vi.fn(),
  revokeUserSessions: vi.fn(),
  banUser: vi.fn(),
  unbanUser: vi.fn(),
  removeUser: vi.fn(),
}

function deps(handle: DbHandle): AdminDeps {
  const db = handle.db
  const keyring = loadKeyring({ ONEC_MCP_ENC_KEY: KEY } as NodeJS.ProcessEnv)
  const sharedPool: ReadPool = { get: vi.fn(), list: vi.fn(), refresh: vi.fn() }
  return {
    auth: { api } as unknown as AdminDeps['auth'],
    db,
    keyring,
    sharedPool,
    version: 'test',
    baseRepo: new BaseRepo(db),
    secretRepo: new SecretRepo(db),
    grantRepo: new GrantRepo(db),
    healthRepo: new HealthRepo(db),
  }
}

function req(params: Record<string, string>, body: Record<string, unknown> = {}): Request {
  return { params, body, headers: {}, get: () => undefined } as unknown as Request
}

async function seedUser(handle: DbHandle, id: string, email: string, role: string, banned = false): Promise<void> {
  await handle.db.insert(user).values({ id, name: id, email, role, banned })
}

describe('admin user management guards', () => {
  let handle: DbHandle
  beforeEach(async () => {
    handle = createDb({ kind: 'pglite' })
    await runAuthMigrations(handle)
    for (const fn of Object.values(api)) fn.mockReset()
    api.setRole.mockResolvedValue({ user: { id: 'u2', email: 'two@x', name: '', role: 'user' } })
    api.banUser.mockResolvedValue({ user: { id: 'u2', email: 'two@x', name: '', role: 'user', banned: true } })
    api.unbanUser.mockResolvedValue({ user: { id: 'u2', email: 'two@x', name: '', role: 'user', banned: false } })
    api.setUserPassword.mockResolvedValue({})
    api.revokeUserSessions.mockResolvedValue({})
    api.removeUser.mockResolvedValue({})
  })

  it('refuses to demote the LAST admin (select snaps back via a 200 row + error toast)', async () => {
    await seedUser(handle, 'a1', 'admin@x', 'admin')
    const d = deps(handle)
    const r = res('a1')
    await setUserRole(req({ id: 'a1' }, { role: 'user' }), r as unknown as Response, d)
    expect(r.statusCode).toBe(200) // row re-render, not a bare 4xx — the select must reset
    expect(r.body).toContain('last admin')
    expect(r.body).toContain('id="user-a1"') // current row restored
    expect(api.setRole).not.toHaveBeenCalled()
  })

  it('allows demoting an admin when another admin remains', async () => {
    await seedUser(handle, 'a1', 'one@x', 'admin')
    await seedUser(handle, 'a2', 'two@x', 'admin')
    const d = deps(handle)
    await setUserRole(req({ id: 'a2' }, { role: 'user' }), res('a1') as unknown as Response, d)
    expect(api.setRole).toHaveBeenCalledTimes(1)
  })

  it('does NOT count a BANNED admin as a usable fallback (self-demote refused → no lockout)', async () => {
    // a1 active, a2 an admin but banned (cannot sign in). Demoting a1 would strip
    // the only sign-in-capable admin — the guard must refuse despite two admin rows.
    await seedUser(handle, 'a1', 'one@x', 'admin')
    await seedUser(handle, 'a2', 'two@x', 'admin', true)
    const d = deps(handle)
    const r = res('a1')
    await setUserRole(req({ id: 'a1' }, { role: 'user' }), r as unknown as Response, d)
    expect(r.statusCode).toBe(200)
    expect(r.body).toContain('last admin')
    expect(api.setRole).not.toHaveBeenCalled()
  })

  it('refuses to ban the last ACTIVE admin when the only other admin is already banned', async () => {
    await seedUser(handle, 'a1', 'one@x', 'admin')
    await seedUser(handle, 'a2', 'two@x', 'admin', true)
    const d = deps(handle)
    const r = res('a2') // actor irrelevant to the count; target is the active admin a1
    await banUser(req({ id: 'a1' }), r as unknown as Response, d)
    expect(r.statusCode).toBe(400)
    expect(r.body).toContain('last admin')
    expect(api.banUser).not.toHaveBeenCalled()
  })

  it('refuses self-ban and self-delete outright', async () => {
    await seedUser(handle, 'a1', 'one@x', 'admin')
    await seedUser(handle, 'a2', 'two@x', 'admin')
    const d = deps(handle)
    const r1 = res('a1')
    await banUser(req({ id: 'a1' }), r1 as unknown as Response, d)
    expect(r1.statusCode).toBe(400)
    expect(r1.body).toContain('your own account')
    const r2 = res('a1')
    await deleteUser(req({ id: 'a1' }), r2 as unknown as Response, d)
    expect(r2.statusCode).toBe(400)
    expect(api.banUser).not.toHaveBeenCalled()
    expect(api.removeUser).not.toHaveBeenCalled()
  })

  it('refuses to ban or delete the LAST admin (acted on by a second, non-admin-removing path)', async () => {
    await seedUser(handle, 'a1', 'one@x', 'admin')
    await seedUser(handle, 'u2', 'two@x', 'user')
    const d = deps(handle)
    // u2 acting would be blocked by the gate; simulate a second ADMIN row being
    // the target while only one admin exists: actor u2's id differs from target.
    const r = res('u2')
    await banUser(req({ id: 'a1' }), r as unknown as Response, d)
    expect(r.statusCode).toBe(400)
    expect(r.body).toContain('last admin')
    expect(api.banUser).not.toHaveBeenCalled()
  })

  it('ban revokes the target sessions and renders the banned row', async () => {
    await seedUser(handle, 'a1', 'one@x', 'admin')
    await seedUser(handle, 'u2', 'two@x', 'user')
    const d = deps(handle)
    const r = res('a1')
    await banUser(req({ id: 'u2' }), r as unknown as Response, d)
    expect(api.banUser).toHaveBeenCalledTimes(1)
    expect(api.revokeUserSessions).toHaveBeenCalledWith(expect.objectContaining({ body: { userId: 'u2' } }))
    expect(r.body).toContain('banned')
  })

  it('set-password enforces the minimum length, then sets + revokes sessions and closes the form', async () => {
    await seedUser(handle, 'a1', 'one@x', 'admin')
    await seedUser(handle, 'u2', 'two@x', 'user')
    const d = deps(handle)

    const short = res('a1')
    await setUserPassword(req({ id: 'u2' }, { password: 'short' }), short as unknown as Response, d)
    expect(short.body).toContain('at least 8 characters') // form re-render, retryable
    expect(api.setUserPassword).not.toHaveBeenCalled()

    const ok = res('a1')
    await setUserPassword(req({ id: 'u2' }, { password: 'longenough-1' }), ok as unknown as Response, d)
    expect(api.setUserPassword).toHaveBeenCalledWith(
      expect.objectContaining({ body: { userId: 'u2', newPassword: 'longenough-1' } }),
    )
    expect(api.revokeUserSessions).toHaveBeenCalledWith(expect.objectContaining({ body: { userId: 'u2' } }))
    // OOB-only success: the slot swap gets '' (form closes) + an ok toast
    expect(ok.body).toContain('hx-swap-oob')
    expect(ok.body).toContain('flash-msg ok')
  })

  it('delete cleans up the orphaned grants', async () => {
    await seedUser(handle, 'a1', 'one@x', 'admin')
    await seedUser(handle, 'u2', 'two@x', 'user')
    const d = deps(handle)
    await d.baseRepo.upsert('trade', { baseUrl: 'http://x', login: 'l', serverTimezone: 'Europe/Moscow' })
    await d.grantRepo.grant('u2', 'trade', 'read')
    const r = res('a1')
    await deleteUser(req({ id: 'u2' }), r as unknown as Response, d)
    expect(api.removeUser).toHaveBeenCalledTimes(1)
    expect((await d.grantRepo.resolve('u2')).size).toBe(0)
    expect(r.body).toContain('flash-msg ok')
  })

  it('mutations on a vanished user flash a 404 and never reach the plugin API', async () => {
    await seedUser(handle, 'a1', 'one@x', 'admin')
    const d = deps(handle)
    const r = res('a1')
    await banUser(req({ id: 'ghost' }), r as unknown as Response, d)
    expect(r.statusCode).toBe(404)
    expect(api.banUser).not.toHaveBeenCalled()
  })
})
