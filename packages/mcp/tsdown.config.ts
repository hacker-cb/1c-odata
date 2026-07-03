import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['./src/cli.ts', './src/index.ts', './src/internal.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  fixedExtension: false,
})
