import { defineConfig } from 'vitest/config'
import { coverage } from '../../vitest.shared'

export default defineConfig({
  resolve: {
    // Self-imports → src (see vitest.shared.ts). The subpath entry MUST precede
    // the bare name: a bare alias prefix-matches '@1c-odata/cli/codegen'.
    alias: {
      '@1c-odata/cli/codegen': new URL('./src/codegen/index.ts', import.meta.url).pathname,
      '@1c-odata/cli': new URL('./src/index.ts', import.meta.url).pathname,
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/e2e/**'],
    environment: 'node',
    coverage,
  },
})
