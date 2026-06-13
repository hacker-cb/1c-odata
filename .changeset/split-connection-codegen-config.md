---
"@1c-odata/client": minor
"@1c-odata/cli": minor
"@1c-odata/metadata": minor
---

Split the runtime connection descriptor from the build-time codegen config.

The single `defineConfig` / `CliConfig` object mixed three lifecycles in one file the app runtime had to import: the runtime connection (`baseUrl`/`auth`/`serverTimezone`/`shape`), build-only codegen settings (`include`, `fetchTimeout`, `metadataDir`, `generatedDir`), and secrets. They are now cleanly separated:

- **`@1c-odata/client`** owns the runtime `Connection` — now just `baseUrl`, `auth`, `serverTimezone`, `shape` — plus a new `defineConnection` helper. `CliConfig` and `defineConfig` are **removed** from this package (the zero-dep runtime core no longer carries build-tool concepts).
- **`@1c-odata/cli`** owns the build-time codegen config: new `defineCodegenConfig` + `CodegenConfig` / `CodegenTarget` types. A target wraps a `connection` plus codegen options.
- The app runtime no longer imports `1c-odata.config.ts` — it builds its `Connection` directly (from env, a database, a vault, …), so build settings and secrets stay out of the runtime graph.

**Migration — `1c-odata.config.ts`:**

```diff
-import { defineConfig, parseConnectionUrl } from '@1c-odata/client'
+import { parseConnectionUrl } from '@1c-odata/client'
+import { defineCodegenConfig } from '@1c-odata/cli'

-export default defineConfig({
-  connections: {
-    trade: {
-      ...parseConnectionUrl(url),
-      serverTimezone: 'Europe/Moscow',
-      codegen: { include: ['Catalog_*'] },
-    },
-  },
-})
+export default defineCodegenConfig({
+  targets: {
+    trade: {
+      connection: { ...parseConnectionUrl(url), serverTimezone: 'Europe/Moscow' },
+      include: ['Catalog_*'],
+    },
+  },
+})
```

**Migration — runtime** (build the `Connection`, don't import the config file):

```diff
-import config from '../1c-odata.config.js'
-const client = new ODataV3Client(clientOptionsFromConnection(config.connections.trade!))
+import { defineConnection, parseConnectionUrl } from '@1c-odata/client'
+const conn = defineConnection({ ...parseConnectionUrl(process.env.ONEC_URL!), serverTimezone: 'Europe/Moscow' })
+const client = new ODataV3Client(clientOptionsFromConnection(conn))
```

Other breaking changes:

- CLI selection flag renamed `--connection` → `--target` (e.g. `1c-odata fetch --target trade`).
- `Connection.fetchTimeout` removed — set the `$metadata` download timeout per codegen target (`CodegenTarget.fetchTimeout`), at config level (`CodegenConfig.fetchTimeout`), or per call (`fetchMetadataIndex(conn, { timeout })`).
- `Connection.codegen` removed — the `include` whitelist now lives directly on the codegen target.
