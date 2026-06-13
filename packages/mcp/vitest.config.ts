import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { coverage } from '../../vitest.shared'

export default defineConfig({
  resolve: {
    // Self-import → src (see vitest.shared.ts): unit tests exercise source
    // directly and V8 coverage attributes to src/** rather than the bundle.
    alias: {
      '@1c-odata/mcp': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/e2e/**'],
    environment: 'node',
    coverage,
  },
})
