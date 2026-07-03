// Import through the SUBPATH (aliased to src/internal.ts by vitest.config.ts) so
// this test doubles as a check that the '@1c-odata/mcp/internal' alias resolves
// and is not swallowed by the bare '@1c-odata/mcp' alias.

import * as internal from '@1c-odata/mcp/internal'
import {
  ConnectionPool,
  clampTop,
  DEFAULT_LIMITS,
  FileConnectionSource,
  passwordEnvVar,
  registerDataTools,
  registerSchemaTools,
  registerServerInfoTool,
  resolveLimits,
  SecretStore,
  verifyConnectivity,
} from '@1c-odata/mcp/internal'
import { describe, expect, it } from 'vitest'

// Locks the reusable-building-block contract @1c-odata/mcp-server depends on. A
// rename/removal here is an intentional (internal, non-semver) break — update the
// consumer in lock-step. Management tools must stay OFF this surface (admin-only).
describe('@1c-odata/mcp/internal surface', () => {
  it('exports the pool, source seam, registrators, limit helpers and connectivity probe', () => {
    // Static named imports (not dynamic namespace access) — a missing export is a
    // compile error here, not just a runtime miss.
    for (const fn of [
      ConnectionPool,
      FileConnectionSource,
      registerSchemaTools,
      registerDataTools,
      registerServerInfoTool,
      resolveLimits,
      clampTop,
      SecretStore,
      passwordEnvVar,
      verifyConnectivity,
    ]) {
      expect(typeof fn).toBe('function')
    }
    expect(DEFAULT_LIMITS).toMatchObject({ defaultTop: expect.any(Number), maxTop: expect.any(Number) })
  })

  it('does NOT expose the connection-management tools (admin-only, not remote-reusable)', () => {
    // register*ManagementTools is deliberately absent — the remote read surface
    // must not carry add/remove/set_credentials/set_label.
    expect('registerManagementTools' in internal).toBe(false)
  })
})
