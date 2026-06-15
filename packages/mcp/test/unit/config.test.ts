import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertValidConnectionName, configPath, loadConfig, resolveDataDir, saveConfig } from '../../src/config.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-config-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('resolveDataDir', () => {
  it('prefers ONEC_MCP_DATA_DIR verbatim, over any platform default', () => {
    expect(resolveDataDir({ ONEC_MCP_DATA_DIR: '/x/y', XDG_CONFIG_HOME: '/other', APPDATA: 'C:\\other' })).toBe('/x/y')
  })

  it('ignores a blank override and falls back to a per-user dir named after the app', () => {
    expect(resolveDataDir({ ONEC_MCP_DATA_DIR: '   ' })).toContain('1c-odata')
    expect(resolveDataDir({})).toContain('1c-odata')
  })

  // The default is XDG-style and agent-independent: branches on the host OS.
  if (process.platform === 'win32') {
    it('uses %APPDATA%\\1c-odata on Windows', () => {
      expect(resolveDataDir({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' })).toBe(
        join('C:\\Users\\me\\AppData\\Roaming', '1c-odata'),
      )
    })

    it('falls back to ~\\AppData\\Roaming when APPDATA is unset', () => {
      expect(resolveDataDir({})).toBe(join(homedir(), 'AppData', 'Roaming', '1c-odata'))
    })
  } else {
    it('honors an absolute $XDG_CONFIG_HOME on macOS/Linux', () => {
      expect(resolveDataDir({ XDG_CONFIG_HOME: '/custom/cfg' })).toBe('/custom/cfg/1c-odata')
    })

    it('ignores a relative or empty $XDG_CONFIG_HOME and uses ~/.config', () => {
      const expected = join(homedir(), '.config', '1c-odata')
      expect(resolveDataDir({ XDG_CONFIG_HOME: 'relative/path' })).toBe(expected)
      expect(resolveDataDir({ XDG_CONFIG_HOME: '' })).toBe(expected)
      expect(resolveDataDir({})).toBe(expected)
    })
  }
})

describe('loadConfig / saveConfig', () => {
  it('returns an empty config when the file is absent', () => {
    expect(loadConfig(dir)).toEqual({ connections: {} })
  })

  it('round-trips connections', () => {
    const cfg = {
      connections: {
        trade: { baseUrl: 'http://h/odata/standard.odata', login: 'u', serverTimezone: 'Europe/Moscow' },
      },
    }
    saveConfig(dir, cfg)
    expect(loadConfig(dir)).toEqual(cfg)
  })

  it('writes config.json with 0600 permissions', () => {
    saveConfig(dir, { connections: {} })
    if (process.platform !== 'win32') {
      expect(statSync(configPath(dir)).mode & 0o777).toBe(0o600)
    }
  })

  it('normalizes structurally-invalid JSON to an empty config', () => {
    writeFileSync(configPath(dir), '{"connections": 42}')
    expect(loadConfig(dir)).toEqual({ connections: {} })
  })

  it('throws a clear error on syntactically malformed JSON', () => {
    writeFileSync(configPath(dir), '{ not json')
    expect(() => loadConfig(dir)).toThrow(/Malformed JSON/)
  })

  it('strips userinfo from a hand-edited baseUrl on load', () => {
    writeFileSync(
      configPath(dir),
      JSON.stringify({
        connections: { c: { baseUrl: 'http://u:p@host/odata', login: 'u', serverTimezone: 'Europe/Moscow' } },
      }),
    )
    expect(loadConfig(dir).connections.c?.baseUrl).toBe('http://host/odata')
  })

  it('drops structurally-invalid connection entries on load', () => {
    writeFileSync(
      configPath(dir),
      JSON.stringify({
        connections: {
          good: { baseUrl: 'http://h/odata', login: 'u', serverTimezone: 'Europe/Moscow' },
          notObject: 'oops',
          missingFields: { baseUrl: 'http://h/odata' },
        },
      }),
    )
    expect(Object.keys(loadConfig(dir).connections)).toEqual(['good'])
  })
})

describe('assertValidConnectionName', () => {
  it('accepts ASCII names with letters, digits, hyphens and underscores', () => {
    expect(() => assertValidConnectionName('tvip-trade')).not.toThrow()
    expect(() => assertValidConnectionName('test_tvip_trade')).not.toThrow()
    expect(() => assertValidConnectionName('bp30')).not.toThrow()
  })

  it('rejects non-ASCII names, leading separators, and empty', () => {
    expect(() => assertValidConnectionName('Валюты')).toThrow(/Invalid connection name/)
    expect(() => assertValidConnectionName('-leading')).toThrow(/Invalid connection name/)
    expect(() => assertValidConnectionName('_leading')).toThrow(/Invalid connection name/)
    expect(() => assertValidConnectionName('')).toThrow(/Invalid connection name/)
  })
})
