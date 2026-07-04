import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['./src/cli.ts', './src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  fixedExtension: false,
  // `drizzle-kit` is a RUNTIME dependency (it's dynamically imported on the pglite
  // migration path — src/store/migrate.ts — and the CLI defaults to pglite), so it
  // must resolve from node_modules at runtime rather than be bundled. Keep it (and
  // the optional sqlite drivers it lazy-imports) EXTERNAL so the prod artifact
  // stays lean and the build emits no UNRESOLVED_IMPORT noise for drivers we never
  // touch. The pg path uses drizzle-orm's migrator, which IS bundled.
  external: ['drizzle-kit', 'drizzle-kit/api'],
})
