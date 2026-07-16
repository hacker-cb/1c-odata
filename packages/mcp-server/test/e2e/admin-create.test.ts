// test/e2e/admin-create.test.ts
//
// `admin-create` is the CLI equivalent of the one-time /setup wizard — and the
// wizard self-closes once an admin exists. This drives the command against a
// PERSISTENT pglite store to pin that same bootstrap-only contract: the first run
// seeds an admin, a repeat run is refused (it bypasses every session check, so
// without the gate it would silently mint extra admins), and --force is the
// deliberate escape hatch.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildProgram } from '../../src/cli.js'
import { createDb } from '../../src/store/db.js'
import { runAuthMigrations } from '../../src/store/migrate.js'
import { countAdmins } from '../../src/store/repos.js'

const PUBLIC_URL = 'http://127.0.0.1:9998'
const SECRET = 'e2e-secret-not-for-prod-0123456789'

let dataDir: string
let prevSecret: string | undefined
let prevPublicUrl: string | undefined

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'mcp-admincreate-'))
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

/** Count admins by reopening the SAME persistent store the CLI wrote to. */
async function admins(): Promise<number> {
  const handle = createDb({ kind: 'pglite', dataDir })
  try {
    await runAuthMigrations(handle)
    return await countAdmins(handle.db)
  } finally {
    await handle.close()
  }
}

describe('admin-create CLI (bootstrap-only)', () => {
  it('seeds the first admin', async () => {
    await runCli(['admin-create', '--email', 'first@example.com', '--password', 'FirstPass1!'])
    expect(await admins()).toBe(1)
  })

  it('refuses a second admin and names the sanctioned path', async () => {
    await runCli(['admin-create', '--email', 'first@example.com', '--password', 'FirstPass1!'])
    await expect(
      runCli(['admin-create', '--email', 'second@example.com', '--password', 'SecondPass2!']),
    ).rejects.toThrow(/already exists/)
    // The refusal must land BEFORE createUser — no extra admin, no stray user row.
    expect(await admins()).toBe(1)
  })

  it('--force is the deliberate escape hatch for the ops case', async () => {
    await runCli(['admin-create', '--email', 'first@example.com', '--password', 'FirstPass1!'])
    await runCli(['admin-create', '--email', 'second@example.com', '--password', 'SecondPass2!', '--force'])
    expect(await admins()).toBe(2)
  })
})
