import { defineConfig, parseConnectionUrl } from '@1c-odata/client'

// `1c-odata generate` reads `metadata/default.xml` from disk — doesn't need a real
// URL. `1c-odata fetch` and `pnpm demo` DO need ONEC_EXAMPLE_BASIC_URL — they'll fail
// fast at the transport layer with a clear network error if it points nowhere.
const url =
  process.env.ONEC_EXAMPLE_BASIC_URL ??
  'http://placeholder:placeholder@1c-odata-placeholder.invalid/odata/standard.odata/'

export default defineConfig({
  metadataDir: './metadata',
  generatedDir: './generated',
  fetchTimeout: 120_000,
  connections: {
    default: {
      ...parseConnectionUrl(url),
      serverTimezone: 'Europe/Moscow',
      codegen: { include: ['Catalog_*', 'Document_*'] },
    },
  },
})
