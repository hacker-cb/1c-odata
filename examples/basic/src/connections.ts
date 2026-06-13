import { defineConnection, parseConnectionUrl } from '@1c-odata/client'

// Runtime connection descriptor — built independently of the codegen config
// (`1c-odata.config.ts`), so the app runtime never imports the build-time
// config file. `shape` is intentionally omitted: codegen baked it into the
// generated `__metadata.json`, which `createClient` loads, so the runtime
// inherits it from the schema (no need to repeat it here).
const url =
  process.env.ONEC_EXAMPLE_BASIC_URL ??
  'http://placeholder:placeholder@1c-odata-placeholder.invalid/odata/standard.odata/'

export const defaultConnection = defineConnection({
  ...parseConnectionUrl(url),
  serverTimezone: 'Europe/Moscow',
})
