// test/unit/admin-bases.test.ts
import type { ReadPool } from '@1c-odata/mcp/internal'
import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the reachability probe: assert verify-before-save without a live 1С base.
vi.mock('@1c-odata/mcp/internal', async (orig) => {
  const actual = await orig<typeof import('@1c-odata/mcp/internal')>()
  return { ...actual, verifyConnectivity: vi.fn() }
})

import { verifyConnectivity } from '@1c-odata/mcp/internal'
import { createBase, deleteBase, updateBase, verifyBase } from '../../src/http/admin/bases.js'
import type { AdminDeps } from '../../src/http/admin/router.js'
import { decrypt, encrypt, type Keyring, loadKeyring } from '../../src/store/crypto.js'
import { createDb, type DbHandle } from '../../src/store/db.js'
import { runAuthMigrations } from '../../src/store/migrate.js'
import { BaseRepo, GrantRepo, HealthRepo, SecretRepo } from '../../src/store/repos.js'

const KEY = Buffer.alloc(32, 7).toString('base64')

interface FakeRes {
  statusCode: number
  body: string
  headers: Record<string, string>
  type(): FakeRes
  status(c: number): FakeRes
  setHeader(k: string, v: string): FakeRes
  send(b: string): FakeRes
}

function res(): FakeRes {
  const r: FakeRes = {
    statusCode: 200,
    body: '',
    headers: {},
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

function deps(handle: DbHandle, keyring: Keyring): AdminDeps {
  const db = handle.db
  const sharedPool: ReadPool = { get: vi.fn(), list: vi.fn(), refresh: vi.fn() }
  return {
    auth: {} as AdminDeps['auth'],
    db,
    keyring,
    sharedPool,
    version: 'test',
    baseRepo: new BaseRepo(db),
    secretRepo: new SecretRepo(db),
    grantRepo: new GrantRepo(db),
    healthRepo: new HealthRepo(db),
    startOnDemandCheck: () => {},
    checkingSince: () => null,
  }
}

describe('admin base CRUD', () => {
  let handle: DbHandle
  let keyring: Keyring
  beforeEach(async () => {
    handle = createDb({ kind: 'pglite' })
    await runAuthMigrations(handle)
    keyring = loadKeyring({ ONEC_MCP_ENC_KEY: KEY } as NodeJS.ProcessEnv)
    vi.mocked(verifyConnectivity).mockReset()
  })

  it('persists descriptor + encrypts secret + refreshes on create', async () => {
    vi.mocked(verifyConnectivity).mockResolvedValue()
    const d = deps(handle, keyring)
    const req = {
      body: {
        name: 'trade',
        baseUrl: 'http://1c/odata',
        login: 'u',
        password: 'p@ss',
        serverTimezone: 'Europe/Moscow',
      },
      params: {},
    } as unknown as Request
    const r = res()
    await createBase(d)(req, r as unknown as Response)

    // descriptor stored
    const stored = await d.baseRepo.get('trade')
    expect(stored?.baseUrl).toBe('http://1c/odata')
    // secret encrypted (sealed envelope, no plaintext)
    const sealed = await d.secretRepo.get('trade')
    expect(sealed).not.toBeNull()
    expect(sealed?.ciphertext.toString('utf8')).not.toContain('p@ss')
    // pool cache evicted
    expect(d.sharedPool.refresh).toHaveBeenCalledWith('trade')
    // verify ran with the exact triple, BEFORE persistence
    expect(verifyConnectivity).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'http://1c/odata', login: 'u', password: 'p@ss' }),
    )
    // success response: the new row (health seeded ok), the form closed (OOB), and
    // a success toast — the empty-state placeholder hides itself via CSS, no OOB.
    expect(r.body).toContain('id="base-trade"')
    expect(r.body).toContain('badge ok')
    expect(r.body).toContain('id="drawer-body" hx-swap-oob="innerHTML"></div>') // drawer closed
    expect(r.body).toContain('flash-msg ok')
    expect(r.body).not.toContain('hx-swap-oob="delete"') // no placeholder OOB juggling
  })

  it('does NOT persist when verify rejects', async () => {
    vi.mocked(verifyConnectivity).mockRejectedValue(new Error('401 Unauthorized'))
    const d = deps(handle, keyring)
    const req = {
      body: { name: 'bad', baseUrl: 'http://1c/odata', login: 'u', password: 'x', serverTimezone: 'Europe/Moscow' },
      params: {},
    } as unknown as Request
    const r = res()
    await createBase(d)(req, r as unknown as Response)
    expect(await d.baseRepo.get('bad')).toBeUndefined()
    expect(await d.secretRepo.has('bad')).toBe(false)
    expect(d.sharedPool.refresh).not.toHaveBeenCalled()
    expect(r.body).toContain('Verification failed')
  })

  it('never echoes the password back into the reform DOM on failure', async () => {
    vi.mocked(verifyConnectivity).mockRejectedValue(new Error('boom'))
    const d = deps(handle, keyring)
    const req = {
      body: {
        name: 'bad',
        baseUrl: 'http://1c/odata',
        login: 'u',
        password: 'sup3rs3cret',
        serverTimezone: 'Europe/Moscow',
      },
      params: {},
    } as unknown as Request
    const r = res()
    await createBase(d)(req, r as unknown as Response)
    expect(r.body).not.toContain('sup3rs3cret')
  })

  it('rejects an invalid (non-ASCII) base name before any I/O', async () => {
    vi.mocked(verifyConnectivity).mockResolvedValue()
    const d = deps(handle, keyring)
    const req = {
      body: { name: 'Валюты', baseUrl: 'http://1c/odata', login: 'u', password: 'p', serverTimezone: 'Europe/Moscow' },
      params: {},
    } as unknown as Request
    const r = res()
    await createBase(d)(req, r as unknown as Response)
    expect(r.body).toContain('Invalid base name')
    expect(verifyConnectivity).not.toHaveBeenCalled()
    expect(d.sharedPool.refresh).not.toHaveBeenCalled()
  })

  it('a CREATE with an existing name is rejected — no silent overwrite', async () => {
    vi.mocked(verifyConnectivity).mockResolvedValue()
    const d = deps(handle, keyring)
    await d.baseRepo.upsert('trade', { baseUrl: 'http://old/odata', login: 'old', serverTimezone: 'Europe/Moscow' })
    const req = {
      body: {
        name: 'trade',
        baseUrl: 'http://new/odata',
        login: 'new',
        password: 'p',
        serverTimezone: 'Europe/Moscow',
      },
      params: {},
    } as unknown as Request
    const r = res()
    await createBase(d)(req, r as unknown as Response)
    expect(r.body).toContain('already exists')
    // The error re-renders into the drawer (OOB) and MUST stay a CREATE form:
    // inferring edit mode from the typed name would hand the user an hx-put that
    // overwrites the very base whose existence caused the error.
    expect(r.body).toContain('hx-swap-oob')
    expect(r.body).toContain('drawer-body')
    expect(r.body).toContain('hx-post="/admin/bases"')
    expect(r.body).not.toContain('hx-put')
    // the existing descriptor is untouched — createBase must never upsert over it
    const stored = await d.baseRepo.get('trade')
    expect(stored?.baseUrl).toBe('http://old/odata')
    expect(stored?.login).toBe('old')
    expect(verifyConnectivity).not.toHaveBeenCalled()
    expect(d.sharedPool.refresh).not.toHaveBeenCalled()
  })

  it('a tampered `edit` field in a create POST cannot flip the error re-render into edit mode', async () => {
    vi.mocked(verifyConnectivity).mockResolvedValue()
    const d = deps(handle, keyring)
    await d.baseRepo.upsert('trade', { baseUrl: 'http://old/odata', login: 'old', serverTimezone: 'Europe/Moscow' })
    const req = {
      // `edit` is attacker/stale-form-supplied body data — the mode must come from the route.
      body: {
        name: 'trade',
        edit: '1',
        baseUrl: 'http://new/odata',
        login: 'n',
        password: 'p',
        serverTimezone: 'Europe/Moscow',
      },
      params: {},
    } as unknown as Request
    const r = res()
    await createBase(d)(req, r as unknown as Response)
    expect(r.body).toContain('already exists')
    expect(r.body).toContain('hx-post="/admin/bases"')
    expect(r.body).not.toContain('hx-put')
  })

  it('BaseRepo.create is insert-only: the uniqueness race loser writes nothing', async () => {
    // The atomic primitive behind the no-silent-overwrite invariant: the handler's
    // pre-check is advisory (two concurrent creates both pass it); the transaction
    // relies on create() returning false instead of upserting over the winner.
    const d = deps(handle, keyring)
    expect(
      await d.baseRepo.create('trade', { baseUrl: 'http://first/odata', login: 'a', serverTimezone: 'Europe/Moscow' }),
    ).toBe(true)
    expect(
      await d.baseRepo.create('trade', { baseUrl: 'http://second/odata', login: 'b', serverTimezone: 'Europe/Moscow' }),
    ).toBe(false)
    expect((await d.baseRepo.get('trade'))?.baseUrl).toBe('http://first/odata')
  })

  it('rejects a blank / non-IANA server timezone before any persistence', async () => {
    vi.mocked(verifyConnectivity).mockResolvedValue()
    const d = deps(handle, keyring)
    for (const tz of ['', 'Not/AZone', 'Moscow']) {
      const req = {
        body: { name: 'tzbad', baseUrl: 'http://1c/odata', login: 'u', password: 'p', serverTimezone: tz },
        params: {},
      } as unknown as Request
      const r = res()
      await createBase(d)(req, r as unknown as Response)
      expect(r.body).toContain('Invalid server timezone')
      expect(await d.baseRepo.get('tzbad')).toBeUndefined()
    }
    expect(verifyConnectivity).not.toHaveBeenCalled()
    expect(d.sharedPool.refresh).not.toHaveBeenCalled()
  })

  it('delete cascades (secret gone) and refreshes', async () => {
    const d = deps(handle, keyring)
    await d.baseRepo.upsert('g', { baseUrl: 'http://x', login: 'u', serverTimezone: 'Europe/Moscow' })
    await d.secretRepo.put('g', encrypt(keyring, 'g', 'p'))
    await deleteBase({ params: { name: 'g' } } as unknown as Request, res() as unknown as Response, d)
    expect(await d.baseRepo.get('g')).toBeUndefined()
    expect(await d.secretRepo.get('g')).toBeNull() // FK cascade
    expect(d.sharedPool.refresh).toHaveBeenCalledWith('g')
  })

  describe('verifyBase (probe-only, no persistence)', () => {
    it('probes without persisting anything', async () => {
      vi.mocked(verifyConnectivity).mockResolvedValue()
      const d = deps(handle, keyring)
      const req = {
        body: { name: 'probe', baseUrl: 'http://1c/odata', login: 'u', password: 'p@ss' },
      } as unknown as Request
      const r = res()
      await verifyBase(req, r as unknown as Response, d)
      expect(r.body).toContain('verified')
      // No DB write, no cache eviction on a mere probe.
      expect(await d.baseRepo.get('probe')).toBeUndefined()
      expect(await d.secretRepo.has('probe')).toBe(false)
      expect(d.sharedPool.refresh).not.toHaveBeenCalled()
    })

    it('errors when no password is available (none typed, none stored)', async () => {
      const d = deps(handle, keyring)
      const req = { body: { name: 'x', baseUrl: 'http://1c/odata', login: 'u', password: '' } } as unknown as Request
      const r = res()
      await verifyBase(req, r as unknown as Response, d)
      expect(r.body).toContain('Password required')
      expect(verifyConnectivity).not.toHaveBeenCalled()
    })

    it('never sends the stored secret to a request-changed URL (no credential exfil)', async () => {
      // C1: an admin editing base "prod" changes only the URL to an attacker host,
      // clicks Verify with a blank password — the stored secret must NOT be probed
      // against the attacker URL (that would exfiltrate a write-only credential).
      const d = deps(handle, keyring)
      await d.baseRepo.upsert('prod', { baseUrl: 'https://prod/odata', login: 'u', serverTimezone: 'Europe/Moscow' })
      await d.secretRepo.put('prod', encrypt(keyring, 'prod', 'prod-secret'))
      const req = {
        body: { name: 'prod', baseUrl: 'https://attacker.example/', login: 'u', password: '' },
      } as unknown as Request
      const r = res()
      await verifyBase(req, r as unknown as Response, d)
      expect(verifyConnectivity).not.toHaveBeenCalled() // secret never leaves for the changed URL
      expect(r.body).toContain('Re-enter the password')
    })

    it('never echoes the typed password back into the probe result', async () => {
      vi.mocked(verifyConnectivity).mockRejectedValue(new Error('nope'))
      const d = deps(handle, keyring)
      const req = {
        body: { name: 'x', baseUrl: 'http://1c/odata', login: 'u', password: 'sup3rs3cret' },
      } as unknown as Request
      const r = res()
      await verifyBase(req, r as unknown as Response, d)
      expect(r.body).not.toContain('sup3rs3cret')
    })
  })

  describe('updateBase (edit)', () => {
    it('a blank password on edit with UNCHANGED url+login reuses the stored secret + keeps it', async () => {
      const d = deps(handle, keyring)
      // Seed an existing base + secret.
      await d.baseRepo.upsert('trade', { baseUrl: 'http://1c/odata', login: 'u', serverTimezone: 'Europe/Moscow' })
      await d.secretRepo.put('trade', encrypt(keyring, 'trade', 'stored-pw'))
      vi.mocked(verifyConnectivity).mockResolvedValue()

      const req = {
        // Same url+login as stored (only the timezone changes); blank password → reuse.
        body: { baseUrl: 'http://1c/odata', login: 'u', password: '', serverTimezone: 'UTC' },
        params: { name: 'trade' },
      } as unknown as Request
      const r = res()
      await updateBase(d)(req, r as unknown as Response)

      // Verify ran against the DECRYPTED stored password + the base's OWN stored pair.
      expect(verifyConnectivity).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: 'http://1c/odata', login: 'u', password: 'stored-pw' }),
      )
      // Descriptor updated (timezone)…
      expect((await d.baseRepo.get('trade'))?.serverTimezone).toBe('UTC')
      // …and the stored secret is unchanged (blank field must NOT wipe it).
      const sealed = await d.secretRepo.get('trade')
      expect(sealed).not.toBeNull()
      if (sealed) expect(decrypt(keyring, 'trade', sealed)).toBe('stored-pw')
      expect(d.sharedPool.refresh).toHaveBeenCalledWith('trade')
    })

    it('rejects a blank-password edit that CHANGES the URL — no persist, no exfil (C1)', async () => {
      const d = deps(handle, keyring)
      await d.baseRepo.upsert('prod', { baseUrl: 'https://prod/odata', login: 'u', serverTimezone: 'Europe/Moscow' })
      await d.secretRepo.put('prod', encrypt(keyring, 'prod', 'prod-secret'))
      vi.mocked(verifyConnectivity).mockResolvedValue()

      const req = {
        // Changed URL to an attacker host, blank password — must be refused.
        body: { baseUrl: 'https://attacker.example/', login: 'u', password: '', serverTimezone: 'Europe/Moscow' },
        params: { name: 'prod' },
      } as unknown as Request
      const r = res()
      await updateBase(d)(req, r as unknown as Response)

      expect(verifyConnectivity).not.toHaveBeenCalled() // stored secret never sent to the changed URL
      expect(r.body).toContain('Re-enter the password')
      expect((await d.baseRepo.get('prod'))?.baseUrl).toBe('https://prod/odata') // NOT persisted
    })

    it('strips embedded userinfo from the persisted base URL (codex-1)', async () => {
      vi.mocked(verifyConnectivity).mockResolvedValue()
      const d = deps(handle, keyring)
      const req = {
        body: {
          name: 'creds',
          baseUrl: 'https://u:p@1c/odata',
          login: 'u',
          password: 'typed',
          serverTimezone: 'Europe/Moscow',
        },
      } as unknown as Request
      const r = res()
      await createBase(d)(req, r as unknown as Response)
      const stored = await d.baseRepo.get('creds')
      // The base password must never land in base_url — userinfo is stripped.
      expect(stored?.baseUrl).not.toContain('@')
      expect(stored?.baseUrl).toContain('1c/odata')
    })

    it('a verify failure on edit renders an OOB error (visible on the edit form)', async () => {
      const d = deps(handle, keyring)
      await d.baseRepo.upsert('trade', { baseUrl: 'http://1c/odata', login: 'u', serverTimezone: 'Europe/Moscow' })
      await d.secretRepo.put('trade', encrypt(keyring, 'trade', 'stored-pw'))
      vi.mocked(verifyConnectivity).mockRejectedValue(new Error('401 Unauthorized'))

      const req = {
        body: { baseUrl: 'http://1c/odata', login: 'u', password: '', serverTimezone: 'Europe/Moscow' },
        params: { name: 'trade' },
      } as unknown as Request
      const r = res()
      await updateBase(d)(req, r as unknown as Response)
      // OOB wrapper so the error is visible in the drawer despite hx-swap="none".
      expect(r.body).toContain('hx-swap-oob')
      expect(r.body).toContain('drawer-body')
      expect(r.body).toContain('Verification failed')
    })
  })
})
