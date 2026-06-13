import { defineCodegenConfig } from '@1c-odata/cli'
import { parseConnectionUrl } from '@1c-odata/client'

// Build-time config — consumed ONLY by the `1c-odata` CLI (`fetch` + `generate`).
// The app runtime never imports this file; it builds its own Connection in
// `src/connections.ts` (both derive from ONEC_EXAMPLE_BASIC_URL).
//
// `1c-odata generate` reads `metadata/default.xml` from disk — doesn't need a real
// URL. `1c-odata fetch` and `pnpm demo` DO need ONEC_EXAMPLE_BASIC_URL — they'll fail
// fast at the transport layer with a clear network error if it points nowhere.
const url =
  process.env.ONEC_EXAMPLE_BASIC_URL ??
  'http://placeholder:placeholder@1c-odata-placeholder.invalid/odata/standard.odata/'

export default defineCodegenConfig({
  metadataDir: './metadata',
  generatedDir: './generated',
  fetchTimeout: 120_000,
  targets: {
    default: {
      connection: {
        ...parseConnectionUrl(url),
        serverTimezone: 'Europe/Moscow',
      },
      include: ['Catalog_*', 'Document_*'],
    },
  },
})
