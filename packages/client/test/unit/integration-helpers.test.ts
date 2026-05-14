import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activeFixtures, FIXTURE_PROFILES } from '../integration/helpers.js'

describe('FIXTURE_PROFILES', () => {
  it('every profile satisfies the smoke + crud invariant', () => {
    expect(Object.keys(FIXTURE_PROFILES).length).toBeGreaterThanOrEqual(1)
    for (const [id, p] of Object.entries(FIXTURE_PROFILES)) {
      expect(p.id).toBe(id)
      expect(p.smoke.catalogName).toBeTruthy()
      expect(p.smoke.countDocument).toBeTruthy()
      expect(p.crud?.catalogName).toBeTruthy()
      expect(p.crud?.descField).toBeTruthy()
    }
  })

  // Capability gates packages/client/test/integration/write/value-storage.test.ts via
  // `describe.skipIf(!profile.valueStorage)` — accidentally dropping valueStorage from
  // either profile would silently skip the live write coverage instead of failing fast.
  // Assert positively for both remaining profiles.
  it('keeps ValueStorage capability for both fixtures', () => {
    expect(FIXTURE_PROFILES['trade_v11.5']?.valueStorage).toEqual({
      catalogName: 'Catalog_Файлы',
      field: 'ФайлХранилище',
    })
    expect(FIXTURE_PROFILES['bp_v3.0']?.valueStorage).toEqual({
      catalogName: 'Catalog_Файлы',
      field: 'ФайлХранилище',
    })
  })
})

describe('activeFixtures', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns empty when no URL env vars are set', () => {
    vi.stubEnv('ONEC_TRADE_V11_5_URL', '')
    vi.stubEnv('ONEC_BP_V3_0_URL', '')
    expect(activeFixtures()).toEqual([])
  })

  it('returns one entry when only trade_v11.5 URL is set', () => {
    vi.stubEnv('ONEC_TRADE_V11_5_URL', 'http://u:p@host.example/path')
    vi.stubEnv('ONEC_BP_V3_0_URL', '')
    const result = activeFixtures()
    expect(result).toHaveLength(1)
    expect(result[0]!.fixture.id).toBe('trade_v11.5')
    expect(result[0]!.fixture.baseUrl).toBe('http://host.example/path')
    expect(result[0]!.fixture.username).toBe('u')
    expect(result[0]!.fixture.password).toBe('p')
    expect(result[0]!.profile.id).toBe('trade_v11.5')
  })

  it('skips fixtures with malformed URLs', () => {
    vi.stubEnv('ONEC_TRADE_V11_5_URL', 'not a url')
    vi.stubEnv('ONEC_BP_V3_0_URL', '')
    expect(activeFixtures()).toEqual([])
  })

  it('returns both when every URL is set', () => {
    vi.stubEnv('ONEC_TRADE_V11_5_URL', 'http://u:p@h1.example/path')
    vi.stubEnv('ONEC_BP_V3_0_URL', 'http://u:p@h2.example/path')
    const ids = activeFixtures()
      .map((x) => x.fixture.id)
      .sort()
    expect(ids).toEqual(['bp_v3.0', 'trade_v11.5'])
  })
})
