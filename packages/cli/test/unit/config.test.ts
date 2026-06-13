import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InvalidArgumentError } from '@1c-odata/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { rejection } from './_helpers.js'

let tmp: string

const VALID_CONN = `{ baseUrl: 'http://example.test/odata', auth: { username: 'u', password: 'p' }, serverTimezone: 'Europe/Moscow' }`

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), '1c-odata-cli-'))
})
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

describe('loadConfig', () => {
  it('loads a valid 1c-odata.config.ts via c12', async () => {
    writeFileSync(
      join(tmp, '1c-odata.config.ts'),
      `
import { defineCodegenConfig } from '@1c-odata/cli'
export default defineCodegenConfig({
  metadataDir: './metadata',
  generatedDir: './generated',
  targets: {
    x: { connection: ${VALID_CONN} },
  },
})
`,
    )
    const result = await loadConfig({ cwd: tmp })
    expect(result.config.targets.x?.connection.baseUrl).toBe('http://example.test/odata')
    expect(result.config.targets.x?.connection.auth.username).toBe('u')
    expect(result.config.targets.x?.connection.auth.password).toBe('p')
    expect(result.configFile).toContain('1c-odata.config')
    expect(result.cwd).toBe(tmp)
  })

  it('throws when no config file is found', async () => {
    await expect(loadConfig({ cwd: tmp })).rejects.toThrow(/config/i)
  })

  it('throws when targets is missing or empty', async () => {
    writeFileSync(join(tmp, '1c-odata.config.ts'), `export default { targets: {} }`)
    await expect(loadConfig({ cwd: tmp })).rejects.toThrow(/at least one target/i)
  })

  it('loads from explicit configFile path when provided', async () => {
    const customPath = join(tmp, 'custom.config.ts')
    writeFileSync(customPath, `export default { targets: { z: { connection: ${VALID_CONN} } } }`)
    const result = await loadConfig({ cwd: tmp, configFile: customPath })
    expect(result.config.targets.z?.connection.baseUrl).toBe('http://example.test/odata')
  })

  it('preserves explicit serverTimezone', async () => {
    writeFileSync(
      join(tmp, '1c-odata.config.ts'),
      `export default { targets: { x: { connection: { baseUrl: 'http://example.test/odata', auth: { username: 'u', password: 'p' }, serverTimezone: 'Asia/Vladivostok' } } } }`,
    )
    const result = await loadConfig({ cwd: tmp })
    expect(result.config.targets.x?.connection.serverTimezone).toBe('Asia/Vladivostok')
  })

  it('throws when serverTimezone is an invalid IANA name', async () => {
    writeFileSync(
      join(tmp, '1c-odata.config.ts'),
      `export default { targets: { x: { connection: { baseUrl: 'http://example.test/odata', auth: { username: 'u', password: 'p' }, serverTimezone: 'Not/A/Zone' } } } }`,
    )
    await expect(loadConfig({ cwd: tmp })).rejects.toThrow(/is not a valid IANA timezone/)
  })

  it('throws when baseUrl contains userinfo (defensive)', async () => {
    writeFileSync(
      join(tmp, '1c-odata.config.ts'),
      `export default { targets: { trade: { connection: { baseUrl: 'http://leak:secret@example/odata', auth: { username: 'u', password: 'p' }, serverTimezone: 'Europe/Moscow' } } } }`,
    )
    const err = await rejection(loadConfig({ cwd: tmp }))
    expect(err.message).toMatch(/must NOT contain credentials/)
    // Error must NOT leak URL contents
    expect(err.message).not.toContain('leak')
    expect(err.message).not.toContain('secret')
  })

  it('throws when baseUrl is not a valid URL', async () => {
    writeFileSync(
      join(tmp, '1c-odata.config.ts'),
      `export default { targets: { x: { connection: { baseUrl: 'not a url', auth: { username: 'u', password: 'p' }, serverTimezone: 'Europe/Moscow' } } } }`,
    )
    const err = await rejection(loadConfig({ cwd: tmp }))
    expect(err.message).toMatch(/is not a valid URL/)
    expect(err.message).not.toContain('not a url')
  })

  it('throws when auth.username is missing or empty', async () => {
    writeFileSync(
      join(tmp, '1c-odata.config.ts'),
      `export default { targets: { x: { connection: { baseUrl: 'http://example.test/odata', auth: { username: '', password: 'p' }, serverTimezone: 'Europe/Moscow' } } } }`,
    )
    await expect(loadConfig({ cwd: tmp })).rejects.toThrow(/auth\.username.*non-empty/)
  })

  it('throws when auth.password is missing or empty', async () => {
    writeFileSync(
      join(tmp, '1c-odata.config.ts'),
      `export default { targets: { x: { connection: { baseUrl: 'http://example.test/odata', auth: { username: 'u', password: '' }, serverTimezone: 'Europe/Moscow' } } } }`,
    )
    await expect(loadConfig({ cwd: tmp })).rejects.toThrow(/auth\.password.*non-empty/)
  })

  it('throws a clear error when a target has no connection', async () => {
    // The #1 migration mistake: writing the old flat shape under a target
    // instead of nesting it under `connection:`. The error must name `connection`.
    writeFileSync(join(tmp, '1c-odata.config.ts'), `export default { targets: { trade: { include: ['Catalog_*'] } } }`)
    const err = await rejection(loadConfig({ cwd: tmp }))
    expect(err).toBeInstanceOf(InvalidArgumentError)
    expect(err.message).toMatch(/Target "trade" must declare a "connection"/)
  })

  it('throws when auth object is missing entirely', async () => {
    writeFileSync(
      join(tmp, '1c-odata.config.ts'),
      `export default { targets: { x: { connection: { baseUrl: 'http://example.test/odata', serverTimezone: 'Europe/Moscow' } } } }`,
    )
    await expect(loadConfig({ cwd: tmp })).rejects.toThrow(/auth is required/)
  })

  it('re-throws validation failures as InvalidArgumentError (C-4 contract)', async () => {
    writeFileSync(
      join(tmp, '1c-odata.config.ts'),
      `export default { targets: { mybase: { connection: { baseUrl: 'http://example.test/odata', auth: { username: 'u', password: 'p' }, serverTimezone: 'FooBar/Baz' } } } }`,
    )
    const err = await loadConfig({ cwd: tmp }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(InvalidArgumentError)
    const iae = err as InvalidArgumentError
    expect(iae.message).toMatch(/Target "mybase":/)
    expect(iae.argument).toBe('serverTimezone')
    expect(iae.received).toBe('FooBar/Baz')
    expect(iae.cause).toBeInstanceOf(InvalidArgumentError)
  })

  it('auto-sources .env.local from cwd before evaluating config', async () => {
    // .env.local supplies the URL; config reads process.env at evaluation time.
    writeFileSync(join(tmp, '.env.local'), `ONEC_FROM_DOTENV_URL=http://envuser:envpass@example.test/odata\n`)
    writeFileSync(
      join(tmp, '1c-odata.config.ts'),
      `import { defineCodegenConfig } from '@1c-odata/cli'
import { parseConnectionUrl } from '@1c-odata/client'
const url = process.env.ONEC_FROM_DOTENV_URL
if (!url) throw new Error('Missing ONEC_FROM_DOTENV_URL')
export default defineCodegenConfig({
  targets: { trade: { connection: { ...parseConnectionUrl(url), serverTimezone: 'Europe/Moscow' } } },
})
`,
    )
    delete process.env.ONEC_FROM_DOTENV_URL
    try {
      const result = await loadConfig({ cwd: tmp })
      expect(result.config.targets.trade?.connection.baseUrl).toBe('http://example.test/odata')
      expect(result.config.targets.trade?.connection.auth.username).toBe('envuser')
      expect(result.config.targets.trade?.connection.auth.password).toBe('envpass')
    } finally {
      delete process.env.ONEC_FROM_DOTENV_URL
    }
  })

  it('.env.local overrides .env when both are present', async () => {
    writeFileSync(join(tmp, '.env'), `ONEC_LAYERED_URL=http://base:base@example.test/odata\n`)
    writeFileSync(join(tmp, '.env.local'), `ONEC_LAYERED_URL=http://local:local@example.test/odata\n`)
    writeFileSync(
      join(tmp, '1c-odata.config.ts'),
      `import { defineCodegenConfig } from '@1c-odata/cli'
import { parseConnectionUrl } from '@1c-odata/client'
const url = process.env.ONEC_LAYERED_URL!
export default defineCodegenConfig({
  targets: { trade: { connection: { ...parseConnectionUrl(url), serverTimezone: 'Europe/Moscow' } } },
})
`,
    )
    delete process.env.ONEC_LAYERED_URL
    try {
      const result = await loadConfig({ cwd: tmp })
      expect(result.config.targets.trade?.connection.auth.username).toBe('local')
    } finally {
      delete process.env.ONEC_LAYERED_URL
    }
  })
})
