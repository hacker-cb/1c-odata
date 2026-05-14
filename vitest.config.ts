import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig(({ mode }) => {
  Object.assign(process.env, loadEnv(mode, __dirname, ''))
  return {
    root: __dirname,
    test: {
      include: ['packages/*/test/**/*.test.ts'],
      globals: false,
      environment: 'node',
      passWithNoTests: true,
      coverage: {
        provider: 'v8',
        reporter: ['text', 'lcov'],
        include: ['packages/*/src/**/*.ts'],
        exclude: ['**/*.test.ts', '**/dist/**'],
      },
    },
  }
})
