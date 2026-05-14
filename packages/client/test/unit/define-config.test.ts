import { describe, expect, it } from 'vitest'
import { defineConfig } from '../../src/connection.js'

// ── Type-level regression guards ─────────────────────────────────────────────
// These declarations are validated by `pnpm typecheck` (tsc --noEmit). If
// `defineConfig` ever loses its `<const C extends CliConfig>(c: C): C` signature
// and starts returning a widened `CliConfig`, the assignments below become
// type errors: `config.connections.trade` would be `Connection | undefined`,
// and `.baseUrl` would not be accessible without a guard.

const _configWithTrade = defineConfig({
  connections: {
    trade: {
      baseUrl: 'https://example.com',
      auth: { username: 'u', password: 'p' },
      serverTimezone: 'Europe/Moscow',
    },
  },
})

// Regression guard 1: 'trade' key is preserved literally — access without `!`.
// If defineConfig widens the type, `_configWithTrade.connections.trade`
// becomes `Connection | undefined` and this line fails to compile.
const _tradeBaseUrl: string = _configWithTrade.connections.trade.baseUrl

// Regression guard 2: nested literal fields stay typed (not widened to `string`).
const _tradeUsername: string = _configWithTrade.connections.trade.auth.username

// Suppress unused-variable warnings — these exist purely as type-level checks.
void _tradeBaseUrl
void _tradeUsername

// ── Runtime tests ────────────────────────────────────────────────────────────

describe('defineConfig — runtime identity', () => {
  it('returns the same object reference (no-op at runtime)', () => {
    const input = {
      connections: {
        a: { baseUrl: 'http://a', auth: { username: 'u', password: 'p' }, serverTimezone: 'Europe/Moscow' },
      },
    }
    const output = defineConfig(input)
    expect(output).toBe(input)
  })
})
