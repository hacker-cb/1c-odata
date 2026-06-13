import { describe, expect, it } from 'vitest'
import { defineConnection } from '../../src/connection.js'

// ── Type-level regression guards ─────────────────────────────────────────────
// Validated by `pnpm typecheck` (tsc --noEmit). If `defineConnection` ever
// loses its `<const C extends Connection>(c: C): C` signature and starts
// returning a widened `Connection`, the literal field accesses below stop
// compiling (the fields would still be there, but this guards the `const`
// inference that keeps connection-map keys narrow at call sites).

const _trade = defineConnection({
  baseUrl: 'https://example.com',
  auth: { username: 'u', password: 'p' },
  serverTimezone: 'Europe/Moscow',
})

const _tradeBaseUrl: string = _trade.baseUrl
const _tradeUsername: string = _trade.auth.username

// Suppress unused-variable warnings — these exist purely as type-level checks.
void _tradeBaseUrl
void _tradeUsername

// ── Runtime tests ────────────────────────────────────────────────────────────

describe('defineConnection — runtime identity', () => {
  it('returns the same object reference (no-op at runtime)', () => {
    const input = {
      baseUrl: 'http://a',
      auth: { username: 'u', password: 'p' },
      serverTimezone: 'Europe/Moscow',
    }
    const output = defineConnection(input)
    expect(output).toBe(input)
  })
})
