import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAdd } from '../../src/commands/add.js'
import { loadConfig } from '../../src/config.js'
import { upsertConnection } from '../../src/connections.js'

vi.mock('@napi-rs/keyring', () => ({
  Entry: class {
    getPassword(): string | null {
      return null
    }
    setPassword(): void {
      throw new Error('no keychain in tests')
    }
    deletePassword(): boolean {
      return false
    }
  },
}))

/** The interactive `add`, answered without a terminal; every overwrite question asked is counted and answered no. */
const prompts = vi.hoisted(() => ({ lines: [] as string[], confirms: [] as string[] }))
vi.mock('../../src/commands/_prompt.js', () => ({
  promptLine: async () => prompts.lines.shift() ?? '',
  promptHidden: async () => '',
  promptConfirm: async (question: string) => {
    prompts.confirms.push(question)
    return false
  },
  readPasswordStdin: async () => 'pw',
}))

const OLD = 'http://old.test/odata/standard.odata'
const NEW = 'http://new.test/odata/standard.odata'
let dir: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-add-force-'))
  prompts.lines = []
  prompts.confirms = []
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.stubEnv('ONEC_C_PASSWORD', '')
  await upsertConnection({ dataDir: dir, name: 'c', baseUrl: OLD, login: 'u', serverTimezone: 'UTC', insecure: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('the interactive CLI add over an existing connection', () => {
  // Base URL, login, (hidden password), timezone, label.
  const answers = () => {
    prompts.lines = [NEW, 'u', 'Europe/Moscow', '']
  }

  it('with --force overwrites without asking', async () => {
    answers()
    await runAdd({ dataDir: dir, insecure: true, name: 'c', force: true })
    expect(prompts.confirms).toEqual([])
    expect(loadConfig(dir).connections.c?.baseUrl).toBe(NEW)
  })

  it('without --force asks first, and a no leaves it as it was', async () => {
    answers()
    await runAdd({ dataDir: dir, insecure: true, name: 'c' })
    expect(prompts.confirms).toEqual(['Connection "c" exists. Overwrite?'])
    expect(loadConfig(dir).connections.c?.baseUrl).toBe(OLD)
  })
})
