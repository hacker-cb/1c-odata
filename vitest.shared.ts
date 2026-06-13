import type { CoverageOptions } from 'vitest/config'

/**
 * Shared bits for the per-package vitest configs (each package keeps its own
 * `vitest.config.ts`; this only holds what would otherwise drift across them).
 *
 * Self-import rule: a package aliases its OWN package name → `src` so unit tests
 * exercise source directly and V8 coverage attributes to `src/**` rather than
 * the bundled `dist`. Add one alias entry per package EXPORT, listing subpath
 * entries BEFORE the bare name — a bare `@scope/pkg` alias prefix-matches
 * `@scope/pkg/subpath` (vite/@rollup alias matches `key` followed by `/`).
 * A package with no by-name self-imports and a single export needs no alias.
 */
export const coverage: CoverageOptions = {
  provider: 'v8',
  reporter: ['text', 'lcov'],
  include: ['src/**/*.ts'],
  exclude: ['**/*.test.ts', '**/dist/**'],
}
