import { describe, expect, it } from 'vitest'
import * as cliPublic from '../../src/index.js'

describe('CLI public exports', () => {
  it('exposes CLI-specific helpers, including the codegen config it now owns', () => {
    // The codegen config (`defineCodegenConfig` + `CodegenConfig`/`CodegenTarget`
    // types) lives HERE now — it moved out of `@1c-odata/client` so the zero-dep
    // runtime core no longer carries build-tool concepts. Runtime connection
    // helpers (`Connection`/`DataShape`/`defineConnection`/`parseConnectionUrl`)
    // stay in `@1c-odata/client`, the single source of truth for the runtime.
    expect(Object.keys(cliPublic).sort()).toEqual(['defineCodegenConfig', 'loadConfig', 'runFetch', 'runGenerate'])
  })

  it('does not re-export runtime connection helpers', () => {
    expect('defineConnection' in cliPublic).toBe(false)
    expect('parseConnectionUrl' in cliPublic).toBe(false)
  })
})
