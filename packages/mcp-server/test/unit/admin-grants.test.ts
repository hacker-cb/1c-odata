// test/unit/admin-grants.test.ts
import { eq } from 'drizzle-orm'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

  // pglite is a full WASM Postgres per handle and `beforeEach` makes a NEW one for
  // every test — without this the suite piles them up for the whole file.
  afterEach(async () => {
    await handle.close()
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

  it('the swapped cell carries a base-only aria-label and JSON-safe hx-vals (no user data)', async () => {
    const deps = { grantRepo: new GrantRepo(handle.db) } as unknown as AdminDeps
    const r = res()
    await toggleGrant(
      { body: { sub: 'alice', base: 'trade', granted: 'on', scope: 'read' } } as unknown as Request,
      r as unknown as Response,
      deps,
    )
    // The user comes from the row's <th scope="row">, so the cell needs only the
    // base — and hx-vals then carries no email, whose quote could break the
    // hand-assembled JSON. sub (uuid) + base (restricted charset) are JSON-safe.
    expect(r.body).toContain('aria-label="Grant access to trade"')
    expect(r.body).not.toContain('undefined')
    expect(r.body).not.toContain('email')
  })

  // `grants.sub` FKs `user.id` and `grants.base_name` FKs `bases.name`, so a target
  // deleted while the matrix was on screen makes the INSERT raise 23503 rather than
  // land. That must read as "reload", not a generic 500 with the box left ticked.
  it('a grant for a base deleted while the matrix was open reports "reload" and shows the cell unchecked', async () => {
    const grantRepo = new GrantRepo(handle.db)
    const deps = { grantRepo } as unknown as AdminDeps
    await new BaseRepo(handle.db).delete('trade')
    const r = res()
    await toggleGrant(
      { body: { sub: 'alice', base: 'trade', granted: 'on', scope: 'read' } } as unknown as Request,
      r as unknown as Response,
      deps,
    )
    expect(r.body).toContain('no longer exists')
    expect(r.body).not.toContain('checked') // the optimistic tick snaps back
    expect((await grantRepo.resolve('alice')).has('trade')).toBe(false)
  })

  it('a grant for a user deleted while the matrix was open reports "reload" too', async () => {
    const grantRepo = new GrantRepo(handle.db)
    const deps = { grantRepo } as unknown as AdminDeps
    await handle.db.delete(user).where(eq(user.id, 'alice'))
    const r = res()
    await toggleGrant(
      { body: { sub: 'alice', base: 'trade', granted: 'on', scope: 'read' } } as unknown as Request,
      r as unknown as Response,
      deps,
    )
    expect(r.body).toContain('no longer exists')
    expect((await grantRepo.resolve('alice')).has('trade')).toBe(false)
  })

  it('revoking a grant whose base already vanished is a silent no-op (the DELETE cannot violate an FK)', async () => {
    const grantRepo = new GrantRepo(handle.db)
    const deps = { grantRepo } as unknown as AdminDeps
    await new BaseRepo(handle.db).delete('trade')
    const r = res()
    await toggleGrant(
      { body: { sub: 'alice', base: 'trade', granted: '' } } as unknown as Request,
      r as unknown as Response,
      deps,
    )
    expect(r.body).not.toContain('no longer exists')
    expect(r.body).toContain('aria-label="Grant access to trade"')
  })
})
