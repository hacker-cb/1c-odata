import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['./src/index.ts', './src/filter.ts', './src/internal.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  fixedExtension: false,
})
