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
    test: {
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/setup.ts'],
      environment: 'node',
      // Allow individual integration test files to produce zero suites when
      // their fixture's URL env var is unset (live tests gate on .env.local).
      passWithNoTests: true,
    },
  }
})
