import { type AuthOptions, BasicAuth, ODataV3Client, parseConnectionUrl } from '@1c-odata/client'

export interface FixtureConfig {
  id: string
  baseUrl: string
  username: string
  password: string
}

export interface FixtureProfile {
  id: string
  smoke: { catalogName: string; countDocument: string }
  crud?: { catalogName: string; descField: string }
  valueStorage?: { catalogName: string; field: string }
}

/**
 * Authoritative registry of known test fixtures and the capabilities each base
 * supports. Capability availability is confirmed by direct EDMX inspection of
 * `snapshots/<fixture>.xml`. To onboard a new base: add an `ONEC_<ID>_URL`
 * secret and one entry here.
 */
export const FIXTURE_PROFILES: Record<string, FixtureProfile> = {
  'trade_v11.5': {
    id: 'trade_v11.5',
    smoke: { catalogName: 'Catalog_Валюты', countDocument: 'Document_РеализацияТоваровУслуг' },
    crud: { catalogName: 'Catalog_ВидыКонтактнойИнформации', descField: 'Description' },
    valueStorage: { catalogName: 'Catalog_Файлы', field: 'ФайлХранилище' },
  },
  'bp_v3.0': {
    id: 'bp_v3.0',
    smoke: { catalogName: 'Catalog_Валюты', countDocument: 'Document_РеализацияТоваровУслуг' },
    crud: { catalogName: 'Catalog_ВидыКонтактнойИнформации', descField: 'Description' },
    valueStorage: { catalogName: 'Catalog_Файлы', field: 'ФайлХранилище' },
  },
}

/**
 * Active fixtures = registry entries whose `ONEC_<ID>_URL` env var is present
 * and parses cleanly. The env var name derives from the fixture id by
 * replacing `.` with `_` and uppercasing.
 */
export function activeFixtures(): Array<{ fixture: FixtureConfig; profile: FixtureProfile }> {
  const out: Array<{ fixture: FixtureConfig; profile: FixtureProfile }> = []
  for (const profile of Object.values(FIXTURE_PROFILES)) {
    const upper = profile.id.replace(/\./g, '_').toUpperCase()
    const fullUrl = process.env[`ONEC_${upper}_URL`]
    if (!fullUrl) continue
    try {
      const { baseUrl, auth } = parseConnectionUrl(fullUrl)
      out.push({
        fixture: { id: profile.id, baseUrl, username: auth.username, password: auth.password },
        profile,
      })
    } catch (err) {
      // Skip fixtures whose URL is malformed or missing userinfo, but log so
      // a typo in `.env.local` (e.g. credentials forgotten) is visible
      // instead of silently dropping the fixture.
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[helpers] skipping fixture ${profile.id}: ${msg}`)
    }
  }
  return out
}

/** True when writes are explicitly allowed and at least one fixture is active. */
export function writesAllowed(): boolean {
  return process.env.ONEC_TESTS_ALLOW_WRITES === 'true' && activeFixtures().length > 0
}

/** Distinctive prefix for write test data — easy to identify and clean up. */
export function testPrefix(): string {
  return `TEST_CLAUDE_${Date.now()}_`
}

/** BasicAuth helper bound to a fixture. */
export function authFor(f: FixtureConfig): AuthOptions {
  return BasicAuth({ username: f.username, password: f.password })
}

/**
 * Single point of `ODataV3Client` construction for integration tests.
 * Per-client `proxy` is gone from the production API; integration tests
 * route through `HTTP_PROXY` via `test/setup.ts`'s `setGlobalDispatcher`,
 * which is test-only and not part of the published bundle.
 */
export function makeClient(fixture: FixtureConfig): ODataV3Client {
  return new ODataV3Client({
    baseUrl: fixture.baseUrl,
    auth: authFor(fixture),
    serverTimezone: 'Europe/Moscow',
  })
}
