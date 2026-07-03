// test/unit/admin-server-info.test.ts
import { beforeEach, describe, expect, it } from 'vitest'
import { adminServerInfo } from '../../src/http/admin/server-info.js'
import { createDb, type DbHandle } from '../../src/store/db.js'
import { runAuthMigrations } from '../../src/store/migrate.js'
import { BaseRepo } from '../../src/store/repos.js'

describe('DB-aware admin server_info', () => {
  let handle: DbHandle
  beforeEach(async () => {
    handle = createDb({ kind: 'pglite' })
    await runAuthMigrations(handle)
  })

  it('counts bases from the DB, not config.json', async () => {
    const baseRepo = new BaseRepo(handle.db)
    await baseRepo.upsert('a', { baseUrl: 'http://a', login: 'u', serverTimezone: 'Europe/Moscow' })
    await baseRepo.upsert('b', { baseUrl: 'http://b', login: 'u', serverTimezone: 'Europe/Moscow' })
    const info = await adminServerInfo({ baseRepo, version: '9.9.9' })
    expect(info).toContain('v9.9.9')
    expect(info).toContain('2 base(s)')
    expect(info).toContain('DB-backed')
  })
})
