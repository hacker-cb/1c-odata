import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { coverage } from '../../vitest.shared'

export default defineConfig({
  resolve: {
    // Self-import → src (see vitest.shared.ts): unit tests exercise source
    // directly and V8 coverage attributes to src/** rather than the bundle.
    alias: {
      '@1c-odata/mcp-server': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
  test: {
    // e2e is NOT excluded here (a config-level exclude would also block the
    // `test:e2e` script's `vitest run test/e2e`). Suite separation is done by the
    // scripts instead: `test:unit` CLI-excludes test/e2e + test/integration,
    // `test:e2e` positionally filters to test/e2e.
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The auth e2e boots an ephemeral better-auth AS over PGlite (WASM init +
    // schema push) and drives a full OAuth flow. On the slower Windows CI runner
    // this exceeds vitest's default 5s test / 10s hook budgets, so raise both;
    // unit tests finish in ms and are unaffected.
    testTimeout: 60000,
    hookTimeout: 60000,
    coverage,
  },
})
