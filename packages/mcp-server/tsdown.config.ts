import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['./src/cli.ts', './src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  fixedExtension: false,
  // Both migration paths (src/store/migrate.ts) use a drizzle-orm migrator, which
  // bundles cleanly; nothing here imports drizzle-kit at runtime (it's a build-time
  // dep for `drizzle-kit generate` only), so no runtime externals are needed.
})
