// test/unit/admin-grants.test.ts
import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it } from 'vitest'
import { toggleGrant } from '../../src/http/admin/grants.js'
import type { AdminDeps } from '../../src/http/admin/router.js'
import { createDb, type DbHandle } from '../../src/store/db.js'
import { runAuthMigrations } from '../../src/store/migrate.js'
import { BaseRepo, GrantRepo } from '../../src/store/repos.js'
import { user } from '../../src/store/schema.js'

interface FakeRes {
  body: string
  type(): FakeRes
  status(): FakeRes
  setHeader(): FakeRes
  send(b: string): FakeRes
}

function res(): FakeRes {
  const r: FakeRes = {
    body: '',
    type: () => r,
    status: () => r,
    setHeader: () => r,
    send: (b) => {
      r.body = b
      return r
    },
  }
  return r
}

describe('grant editor', () => {
  let handle: DbHandle
  beforeEach(async () => {
    handle = createDb({ kind: 'pglite' })
    await runAuthMigrations(handle)
    await handle.db
      .insert(user)
      .values([
        { id: 'alice', name: 'A', email: 'a@x', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
      ])
    await new BaseRepo(handle.db).upsert('trade', { baseUrl: 'http://x', login: 'u', serverTimezone: 'Europe/Moscow' })
  })

  it('set then list then revoke', async () => {
    const grantRepo = new GrantRepo(handle.db)
    const deps = { grantRepo } as unknown as AdminDeps

    await toggleGrant(
      { body: { sub: 'alice', base: 'trade', granted: 'on', scope: 'write' } } as unknown as Request,
      res() as unknown as Response,
      deps,
    )
    expect((await grantRepo.resolve('alice')).get('trade')).toBe('write')
    expect(await grantRepo.listByBase('trade')).toEqual([{ sub: 'alice', scope: 'write' }])

    await toggleGrant(
      { body: { sub: 'alice', base: 'trade', granted: '' } } as unknown as Request,
      res() as unknown as Response,
      deps,
    )
    expect((await grantRepo.resolve('alice')).has('trade')).toBe(false)
  })

  it('keeps the aria-label email in the swapped cell (round-trips through hx-vals)', async () => {
    const deps = { grantRepo: new GrantRepo(handle.db) } as unknown as AdminDeps
    const r = res()
    await toggleGrant(
      { body: { sub: 'alice', base: 'trade', email: 'a@x', granted: 'on', scope: 'read' } } as unknown as Request,
      r as unknown as Response,
      deps,
    )
    // Without threading email through the toggle body, the re-rendered aria-label
    // would read "Grant trade to undefined".
    expect(r.body).toContain('aria-label="Grant trade to a@x"')
    expect(r.body).not.toContain('undefined')
  })
})
