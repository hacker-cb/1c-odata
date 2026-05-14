import { describe, expect, it } from 'vitest'
import * as cliPublic from '../../src/index.js'

describe('CLI public exports', () => {
  it('exposes only CLI-specific helpers', () => {
    // CLI public API is strictly CLI-specific. `Connection`/`CliConfig`/
    // `DataShape`/`defineConfig`/`parseConnectionUrl` are imported from
    // `@1c-odata/client` directly (one source of truth).
    expect(Object.keys(cliPublic).sort()).toEqual(['loadConfig', 'runFetch', 'runGenerate'])
  })

  it('does not re-export defineConfig', () => {
    expect('defineConfig' in cliPublic).toBe(false)
  })

  it('does not re-export parseConnectionUrl', () => {
    expect('parseConnectionUrl' in cliPublic).toBe(false)
  })
})
