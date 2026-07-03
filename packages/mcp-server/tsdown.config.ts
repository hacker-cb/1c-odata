import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['./src/cli.ts', './src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  fixedExtension: false,
  // `drizzle-kit` is a devDependency, dynamically imported only in the pglite
  // dev/test migration path (src/store/migrate.ts). Keep it (and its optional
  // sqlite drivers, which it lazy-imports) OUT of the bundle so the prod artifact
  // stays lean and the build emits no UNRESOLVED_IMPORT noise for drivers we
  // never touch. The pg (prod) path uses drizzle-orm's migrator, which IS bundled.
  external: ['drizzle-kit', 'drizzle-kit/api'],
})
