import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { coverage } from '../../vitest.shared'

export default defineConfig({
  resolve: {
    // Self-imports → src (see vitest.shared.ts). The subpath entry MUST precede
    // the bare name: a bare alias prefix-matches '@1c-odata/cli/codegen'.
    alias: {
      '@1c-odata/cli/codegen': fileURLToPath(new URL('./src/codegen/index.ts', import.meta.url)),
      '@1c-odata/cli': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/e2e/**'],
    environment: 'node',
    coverage,
  },
})
