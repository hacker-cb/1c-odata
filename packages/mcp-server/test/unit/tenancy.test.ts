// test/unit/tenancy.test.ts
import type { ConnectionSummary, PoolEntry, ReadPool } from '@1c-odata/mcp/internal'
import { InvalidArgumentError } from '@1c-odata/mcp/internal'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt, type Keyring, loadKeyring } from '../../src/store/crypto.js'
import { createDb, type DbHandle } from '../../src/store/db.js'
import { runAuthMigrations } from '../../src/store/migrate.js'
import { BaseRepo, GrantRepo, SecretRepo } from '../../src/store/repos.js'
import { user } from '../../src/store/schema.js'
import { DbConnectionSource } from '../../src/tenancy/db-connection-source.js'
import { resolveGrants } from '../../src/tenancy/grants.js'
import { ScopedPool } from '../../src/tenancy/scoped-pool.js'

const KEY = Buffer.alloc(32, 3).toString('base64')

async function freshDb(): Promise<{ handle: DbHandle; keyring: Keyring }> {
  const handle = createDb({ kind: 'pglite' })
  await runAuthMigrations(handle)
  return { handle, keyring: loadKeyring({ ONEC_MCP_ENC_KEY: KEY } as NodeJS.ProcessEnv) }
}

// Minimal fake shared pool: a real one requires a live 1С base. It carries every
// base the source knows; scoping is what we assert on top of it.
function fakeSharedPool(names: string[]): ReadPool {
  return {
    async get(name: string): Promise<PoolEntry> {
      if (!names.includes(name)) {
        throw new InvalidArgumentError(`No connection named "${name}"`, { argument: 'connection' })
      }
      return { name } as unknown as PoolEntry
    },
    async list(): Promise<ConnectionSummary[]> {
      return names.map((name) => ({ name }) as unknown as ConnectionSummary)
    },
    refresh: vi.fn(),
  }
}

describe('DbConnectionSource + grant scoping', () => {
  let handle: DbHandle
  let keyring: Keyring

  beforeEach(async () => {
    ;({ handle, keyring } = await freshDb())
  })

  async function seed(): Promise<{ src: DbConnectionSource; alice: string; bob: string }> {
    const db = handle.db
    // Users (FK target for grants).
    await db.insert(user).values([
      { id: 'alice', name: 'Alice', email: 'a@x', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
      { id: 'bob', name: 'Bob', email: 'b@x', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    ])
    const bases = new BaseRepo(db)
    const secrets = new SecretRepo(db)
    const grants = new GrantRepo(db)
    for (const name of ['Trade', 'Accounting', 'HR']) {
      await bases.upsert(name, { baseUrl: `https://x/${name}`, login: 'u', serverTimezone: 'Europe/Moscow' })
      await secrets.put(name, encrypt(keyring, name, `pw-${name}`))
    }
    await grants.grant('alice', 'Trade', 'read')
    await grants.grant('alice', 'HR', 'read')
    // bob gets nothing.
    return { src: new DbConnectionSource({ db, keyring }), alice: 'alice', bob: 'bob' }
  }

  it('getSecret decrypts a stored row; secretSource is db/none', async () => {
    const { src } = await seed()
    expect(await src.getSecret('Trade')).toBe('pw-Trade')
    expect(await src.secretSource('Trade')).toBe('db')
    await src.getBase('Trade') // exists
    // A base with no secret row → null + 'none'.
    await new BaseRepo(handle.db).upsert('Empty', { baseUrl: 'https://x/e', login: 'u', serverTimezone: 'UTC' })
    expect(await src.getSecret('Empty')).toBeNull()
    expect(await src.secretSource('Empty')).toBe('none')
  })

  it('a tampered secret row → getSecret null + onSecretError fired (no throw)', async () => {
    const db = handle.db
    await db
      .insert(user)
      .values({ id: 'u', name: 'U', email: 'u@x', emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
    await new BaseRepo(db).upsert('T', { baseUrl: 'https://x/t', login: 'u', serverTimezone: 'UTC' })
    const sealed = encrypt(keyring, 'T', 'pw')
    sealed.tag.writeUInt8(sealed.tag.readUInt8(0) ^ 0xff, 0)
    await new SecretRepo(db).put('T', sealed)
    const onSecretError = vi.fn()
    const src = new DbConnectionSource({ db, keyring, onSecretError })
    expect(await src.getSecret('T')).toBeNull()
    expect(onSecretError).toHaveBeenCalledOnce()
  })

  it('user sees ONLY granted bases; ungranted base is indistinguishable from absent', async () => {
    const { src } = await seed()
    const shared = fakeSharedPool((await src.listBases()).map((b) => b.name)) // Trade, Accounting, HR
    const alicePool = new ScopedPool(shared, () => resolveGrants(handle.db, 'alice'))

    // list is filtered to alice's grants.
    expect((await alicePool.list()).map((c) => c.name).sort()).toEqual(['HR', 'Trade'])

    // granted → resolves.
    await expect(alicePool.get('Trade')).resolves.toBeDefined()

    // ungranted-but-existing base → SAME error, for the SAME name, as a truly-absent
    // base. Compare against a scoped pool over a shared pool that does NOT know
    // "Accounting": both must produce the byte-identical message, so a caller can't
    // tell "you lack a grant" from "no such base".
    const ungranted = await alicePool.get('Accounting').catch((e) => e)
    const absentShared = fakeSharedPool(['Trade', 'HR']) // no "Accounting" at all
    const absentPool = new ScopedPool(absentShared, () => resolveGrants(handle.db, 'alice'))
    const absent = await absentPool.get('Accounting').catch((e) => e)
    expect(ungranted).toBeInstanceOf(InvalidArgumentError)
    expect(absent).toBeInstanceOf(InvalidArgumentError)
    expect(ungranted.message).toBe(absent.message)
    expect(ungranted.message).toBe('No connection named "Accounting"')
    // And the class/message shape matches the shared pool's own absent-base throw.
    const rawAbsent = await shared.get('Nonexistent').catch((e) => e)
    expect(rawAbsent).toBeInstanceOf(InvalidArgumentError)
    expect(ungranted.message).toBe(`No connection named "Accounting"`)
    expect(rawAbsent.message).toBe(`No connection named "Nonexistent"`)
  })

  it('bob (no grants) sees no bases and every get throws not-found', async () => {
    const { src, bob } = await seed()
    const shared = fakeSharedPool((await src.listBases()).map((b) => b.name))
    const bobPool = new ScopedPool(shared, () => resolveGrants(handle.db, bob))
    expect(await bobPool.list()).toEqual([])
    await expect(bobPool.get('Trade')).rejects.toBeInstanceOf(InvalidArgumentError)
  })

  it('revocation takes effect on the NEXT call — same ScopedPool instance', async () => {
    const { src } = await seed()
    const shared = fakeSharedPool((await src.listBases()).map((b) => b.name))
    const alicePool = new ScopedPool(shared, () => resolveGrants(handle.db, 'alice'))

    await expect(alicePool.get('Trade')).resolves.toBeDefined() // granted now
    await new GrantRepo(handle.db).revoke('alice', 'Trade') // admin revokes
    await expect(alicePool.get('Trade')).rejects.toBeInstanceOf(InvalidArgumentError) // next call: gone
  })

  it('refresh on an ungranted base is a no-op (shared.refresh not called)', async () => {
    const { src } = await seed()
    const shared = fakeSharedPool((await src.listBases()).map((b) => b.name))
    const alicePool = new ScopedPool(shared, () => resolveGrants(handle.db, 'alice'))
    alicePool.refresh('Accounting') // ungranted
    await new Promise((r) => setTimeout(r, 10)) // let the fire-and-forget settle
    expect(shared.refresh).not.toHaveBeenCalled()
  })

  it('refresh on a granted base forwards to the shared pool', async () => {
    const { src } = await seed()
    const shared = fakeSharedPool((await src.listBases()).map((b) => b.name))
    const alicePool = new ScopedPool(shared, () => resolveGrants(handle.db, 'alice'))
    alicePool.refresh('Trade') // granted
    await new Promise((r) => setTimeout(r, 10))
    expect(shared.refresh).toHaveBeenCalledWith('Trade')
  })

  it('refresh swallows a rejecting grant read — no unhandled-rejection crash', async () => {
    // Regression: refresh is fire-and-forget (sync/void), so a rejected grants()
    // (a live DB query) with no .catch would surface as an unhandledRejection and,
    // under Node's default policy, terminate the whole multi-tenant process — a
    // cross-tenant DoS. Assert the rejection is swallowed and nothing forwards.
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onRejection)
    try {
      const shared = fakeSharedPool(['Trade'])
      const pool = new ScopedPool(shared, () => Promise.reject(new Error('db down')))
      expect(() => pool.refresh('Trade')).not.toThrow()
      await new Promise((r) => setTimeout(r, 20)) // let the rejected microtask settle
      expect(shared.refresh).not.toHaveBeenCalled()
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })
})
