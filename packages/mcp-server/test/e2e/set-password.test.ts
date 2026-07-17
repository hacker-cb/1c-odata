// test/e2e/set-password.test.ts
//
// Drives the `set-password` CLI break-glass command end-to-end against a
// PERSISTENT pglite store: create an admin, reset its password via the command,
// then confirm the NEW password signs in over the real better-auth instance and
// the OLD one is rejected. Also checks the fail-loud path for an unknown email.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildAuth } from '../../src/auth/better-auth.js'
import { resolveCanonicalUrls } from '../../src/auth/config.js'
import { buildProgram } from '../../src/cli.js'
import { createDb } from '../../src/store/db.js'
import { runAuthMigrations } from '../../src/store/migrate.js'

const PUBLIC_URL = 'http://127.0.0.1:9999'
const SECRET = 'e2e-secret-not-for-prod-0123456789'

let dataDir: string
let prevSecret: string | undefined
let prevPublicUrl: string | undefined

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'mcp-setpw-'))
  prevSecret = process.env.BETTER_AUTH_SECRET
  prevPublicUrl = process.env.ONEC_MCP_PUBLIC_URL
  process.env.BETTER_AUTH_SECRET = SECRET
  process.env.ONEC_MCP_PUBLIC_URL = PUBLIC_URL
})

afterEach(() => {
  if (prevSecret === undefined) delete process.env.BETTER_AUTH_SECRET
  else process.env.BETTER_AUTH_SECRET = prevSecret
  if (prevPublicUrl === undefined) delete process.env.ONEC_MCP_PUBLIC_URL
  else process.env.ONEC_MCP_PUBLIC_URL = prevPublicUrl
  rmSync(dataDir, { recursive: true, force: true })
})

/** Run one CLI subcommand to completion against the shared temp store. */
async function runCli(args: string[]): Promise<void> {
  await buildProgram().parseAsync(['node', 'cli', ...args, '--auth-data-dir', dataDir])
}

/** Open the SAME persistent store the CLI used and sign in over the auth API. */
async function signInWorks(email: string, password: string): Promise<boolean> {
  const handle = createDb({ kind: 'pglite', dataDir })
  try {
    await runAuthMigrations(handle)
    const auth = buildAuth({ urls: resolveCanonicalUrls(PUBLIC_URL), db: handle.db, secret: SECRET })
    try {
      await auth.api.signInEmail({ body: { email, password }, headers: new Headers({ origin: PUBLIC_URL }) })
      return true
    } catch {
      return false
    }
  } finally {
    await handle.close()
  }
}

describe('set-password CLI (break-glass)', () => {
  it('resets an existing admin password; new works, old is rejected', async () => {
    await runCli(['admin-create', '--email', 'admin@example.com', '--password', 'OldPassword1!'])
    expect(await signInWorks('admin@example.com', 'OldPassword1!')).toBe(true)

    await runCli(['set-password', '--email', 'admin@example.com', '--password', 'NewPassword2!'])
    expect(await signInWorks('admin@example.com', 'NewPassword2!')).toBe(true)
    expect(await signInWorks('admin@example.com', 'OldPassword1!')).toBe(false)
  })

  it('fails loudly for an unknown email (no user is created)', async () => {
    await expect(runCli(['set-password', '--email', 'ghost@example.com', '--password', 'Whatever3!'])).rejects.toThrow(
      /No user with email/,
    )
    // The email must NOT have been silently created.
    expect(await signInWorks('ghost@example.com', 'Whatever3!')).toBe(false)
  })
})
