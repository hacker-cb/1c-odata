import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configPath, loadConfig, resolveDataDir, saveConfig } from '../../src/config.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-config-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('resolveDataDir', () => {
  it('prefers ONEC_MCP_DATA_DIR', () => {
    expect(resolveDataDir({ ONEC_MCP_DATA_DIR: '/x/y' })).toBe('/x/y')
  })

  it('ignores a blank override and falls back to a per-OS dir named after the app', () => {
    expect(resolveDataDir({ ONEC_MCP_DATA_DIR: '   ' })).toContain('1c-odata')
    expect(resolveDataDir({})).toContain('1c-odata')
  })
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

  it('normalizes malformed JSON to an empty config', () => {
    writeFileSync(configPath(dir), '{"connections": 42}')
    expect(loadConfig(dir)).toEqual({ connections: {} })
  })
})
