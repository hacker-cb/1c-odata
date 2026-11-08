import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveDataDir } from '../../src/config.js'
import { keychainServiceName } from '../../src/secret-store.js'

// `homedir()` is pinned per test so the expansion is deterministic and the
// "home unknown" branch is reachable; `undefined` falls through to the real one.
const fakeHome = vi.hoisted(() => ({ value: undefined as string | undefined | Error }))
vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>()
  return {
    ...os,
    homedir: () => {
      if (fakeHome.value instanceof Error) throw fakeHome.value
      return fakeHome.value ?? os.homedir()
    },
  }
})

const HOME = process.platform === 'win32' ? 'C:\\Users\\me' : '/home/me'

afterEach(() => {
  fakeHome.value = undefined
})

describe('resolveDataDir — leading ~ expansion', () => {
  it('expands ~/… in the --data-dir flag', () => {
    fakeHome.value = HOME
    expect(resolveDataDir({}, '~/.config/1c-odata-nexus')).toBe(join(HOME, '.config', '1c-odata-nexus'))
  })

  it('expands ~/… in ONEC_MCP_DATA_DIR, after trimming', () => {
    fakeHome.value = HOME
    expect(resolveDataDir({ ONEC_MCP_DATA_DIR: '  ~/data  ' })).toBe(join(HOME, 'data'))
  })

  it('expands a bare ~ to the home directory itself', () => {
    fakeHome.value = HOME
    expect(resolveDataDir({}, '~')).toBe(HOME)
  })

  it('gives ~/x and its absolute spelling one directory and one keychain namespace', () => {
    fakeHome.value = HOME
    const viaTilde = resolveDataDir({}, '~/x')
    const viaAbsolute = resolveDataDir({}, join(HOME, 'x'))
    expect(viaTilde).toBe(viaAbsolute)
    expect(keychainServiceName(viaTilde)).toBe(keychainServiceName(viaAbsolute))
  })

  it('does not expand ~user/…, and says only a leading ~ or ~/ is', () => {
    fakeHome.value = HOME
    expect(() => resolveDataDir({}, '~other/data')).toThrow(/not absolute.*not `~user`/)
  })

  it('leaves a ~ that is not leading alone', () => {
    fakeHome.value = HOME
    expect(() => resolveDataDir({}, 'data/~/x')).toThrow(/not absolute/)
  })

  if (process.platform === 'win32') {
    it('expands ~\\… on Windows', () => {
      fakeHome.value = HOME
      expect(resolveDataDir({}, '~\\data')).toBe(join(HOME, 'data'))
    })

    it('rejects a drive-relative root on Windows, naming the forms that work', () => {
      expect(() => resolveDataDir({}, '\\onec')).toThrow(/not absolute.*drive letter or a UNC prefix/)
      expect(resolveDataDir({}, '\\\\server\\share\\onec')).toBe('\\\\server\\share\\onec')
      expect(() => resolveDataDir({}, '///onec')).toThrow(/not absolute/)
      expect(() => resolveDataDir({}, '\\\\server')).toThrow(/not absolute/)
    })
  } else {
    it('does not treat ~\\… as the home outside Windows, and says so', () => {
      fakeHome.value = HOME
      expect(() => resolveDataDir({}, '~\\data')).toThrow(/not absolute.*not `~\\` outside Windows/)
    })

    it('reports an unknown home on the default path as the resolveDataDir error, not a raw throw', () => {
      fakeHome.value = new Error('no passwd entry')
      expect(() => resolveDataDir({})).toThrow(/not absolute.*ensure HOME\/USERPROFILE is set/)
    })
  }

  it('throws when the home directory is empty', () => {
    fakeHome.value = ''
    expect(() => resolveDataDir({}, '~/data')).toThrow(/home directory is unknown/)
  })

  it('throws when homedir() itself fails', () => {
    fakeHome.value = new Error('no passwd entry')
    expect(() => resolveDataDir({ ONEC_MCP_DATA_DIR: '~/data' })).toThrow(/home directory is unknown/)
  })

  it('does not consult the home for an absolute override', () => {
    fakeHome.value = new Error('must not be called')
    const abs = process.platform === 'win32' ? 'C:\\srv\\onec' : '/srv/onec'
    expect(resolveDataDir({}, abs)).toBe(abs)
  })
})
