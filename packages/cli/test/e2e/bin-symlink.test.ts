import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTmpProject } from './helpers.js'

const cliJsRealPath = resolve(__dirname, '..', '..', 'dist', 'cli.js')

describe('e2e: bin entry detection through pnpm-style symlink', () => {
  it.skipIf(!existsSync(cliJsRealPath))(
    'surfaces an error when invoked through a symlinked path with invalid config',
    () => {
      const { tmp, cleanup } = createTmpProject()
      try {
        // Reproduce the pnpm workspace layout: a project's
        // `node_modules/@1c-odata/cli` is a symlink to the real package dir.
        // The bin then references `dist/cli.js` *through* that symlink, so
        // `process.argv[1]` and `import.meta.url` point at different paths.
        // Without realpath canonicalization the bin entry check returns false
        // and the program never runs (silent exit 0) — see cli.ts.
        const fakePkg = join(tmp, 'node_modules', '@1c-odata')
        mkdirSync(fakePkg, { recursive: true })
        symlinkSync(resolve(__dirname, '..', '..'), join(fakePkg, 'cli'))
        const binPath = join(fakePkg, 'cli', 'dist', 'cli.js')

        // Minimal config file with INVALID auth (empty password) so loadConfig
        // throws. Validates that the bin entry runs and surfaces the error
        // (the symlink fix in cli.ts is the actual subject of this test).
        writeFileSync(
          join(tmp, '1c-odata.config.mjs'),
          `export default { connections: { trade: { baseUrl: 'http://example.test/odata', auth: { username: 'u', password: '' }, serverTimezone: 'Europe/Moscow' } } }\n`,
        )

        const env = { ...process.env }
        const r = spawnSync(process.execPath, [binPath, 'fetch'], { cwd: tmp, env, encoding: 'utf8' })

        expect(r.status).toBe(1)
        expect(r.stderr).toMatch(/auth\.password.*non-empty/)
      } finally {
        cleanup()
      }
    },
  )
})
