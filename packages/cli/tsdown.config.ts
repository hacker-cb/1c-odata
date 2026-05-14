import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['./src/cli.ts', './src/index.ts', './src/codegen/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  fixedExtension: false,
})
