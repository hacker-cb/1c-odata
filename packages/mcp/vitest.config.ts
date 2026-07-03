import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { coverage } from '../../vitest.shared'

export default defineConfig({
  resolve: {
    // Self-import → src (see vitest.shared.ts): unit tests exercise source
    // directly and V8 coverage attributes to src/** rather than the bundle.
    alias: {
      // Order matters: the more specific subpath must precede the bare package,
      // or '@1c-odata/mcp' would also swallow '@1c-odata/mcp/internal'.
      '@1c-odata/mcp/internal': fileURLToPath(new URL('./src/internal.ts', import.meta.url)),
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
