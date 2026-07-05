// test/unit/setup-token.test.ts
//
// The setup-token repo (create/get/clear) and countAdmins(), against a real
// pglite handle running the committed ./drizzle SQL — so this also exercises the
// new 0002 migration that creates `setup_token`.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDb, type DbHandle } from '../../src/store/db.js'
import { runAuthMigrations } from '../../src/store/migrate.js'
import { countAdmins, SetupTokenRepo } from '../../src/store/repos.js'
import { user } from '../../src/store/schema.js'
import { setupToken } from '../../src/store/tenancy-schema.js'

let handle: DbHandle

beforeEach(async () => {
  handle = createDb({ kind: 'pglite' })
  await runAuthMigrations(handle)
})

afterEach(async () => {
  await handle.close()
})

async function insertUser(id: string, email: string, role: string | null): Promise<void> {
  await handle.db.insert(user).values({
    id,
    name: id,
    email,
    emailVerified: true,
    role,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
}

describe('SetupTokenRepo', () => {
  it('starts empty; ensure() inserts and returns the token', async () => {
    const repo = new SetupTokenRepo(handle.db)
    expect(await repo.get()).toBeNull()
    const tok = await repo.ensure('tok-abc')
    expect(tok).toBe('tok-abc')
    expect(await repo.get()).toBe('tok-abc')
  })

  it('ensure() is idempotent — a second call keeps the FIRST token, no extra row', async () => {
    const repo = new SetupTokenRepo(handle.db)
    await repo.ensure('first')
    const second = await repo.ensure('second') // a restart minting a fresh token
    expect(second).toBe('first')
    expect(await repo.get()).toBe('first')
    // Regression (singleton key): a fresh token must NOT accumulate a second row,
    // else get() would become nondeterministic and the logged URL could drift.
    expect(await handle.db.select().from(setupToken)).toHaveLength(1)
  })

  it('clear() deletes the token (single-use)', async () => {
    const repo = new SetupTokenRepo(handle.db)
    await repo.ensure('burn-me')
    await repo.clear()
    expect(await repo.get()).toBeNull()
  })
})

describe('countAdmins', () => {
  it('is 0 on a fresh store', async () => {
    expect(await countAdmins(handle.db)).toBe(0)
  })

  it('counts only role="admin" users, not plain users or role-less rows', async () => {
    await insertUser('a', 'a@example.com', 'admin')
    await insertUser('b', 'b@example.com', 'user')
    await insertUser('c', 'c@example.com', null)
    await insertUser('d', 'd@example.com', 'admin')
    expect(await countAdmins(handle.db)).toBe(2)
  })

  it('counts comma/space multi-role admins (matches adminGate), excludes lookalikes', async () => {
    await insertUser('m', 'm@example.com', 'admin,user') // multi-role → admin
    await insertUser('n', 'n@example.com', 'user admin') // space-separated → admin
    await insertUser('o', 'o@example.com', 'superadmin') // substring, NOT a member
    expect(await countAdmins(handle.db)).toBe(2)
  })
})
