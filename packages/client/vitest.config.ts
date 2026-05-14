import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../..')

export default defineConfig(({ mode }) => {
  // Load .env / .env.local from the repo root (not the package), so a single
  // top-level .env.local powers tests across all packages.
  Object.assign(process.env, loadEnv(mode, repoRoot, ''))
  return {
    resolve: {
      alias: {
        '@1c-odata/client': new URL('./src/index.ts', import.meta.url).pathname,
      },
    },
    test: {
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/setup.ts'],
      environment: 'node',
      // Allow individual integration test files to produce zero suites when
      // their fixture's URL env var is unset. Without this, vitest 4 errors
      // when an included file emits no describes (e.g. live/smoke.test.ts
      // when no ONEC_*_URL is set).
      passWithNoTests: true,
    },
  }
})
