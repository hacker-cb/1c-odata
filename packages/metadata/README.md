# @1c-odata/metadata

Run [`@1c-odata/client`](https://www.npmjs.com/package/@1c-odata/client) against **any** 1С:Enterprise OData V3 base at runtime — full date / Int64 / ValueStorage handling and write validation, with no codegen and no generated files. It's also the EDMX schema toolkit that `@1c-odata/cli` uses under the hood, so the `$metadata` schema stays the single source of truth for both workflows.

- `createDynamicClient` — download `$metadata`, build the index, and return a ready `ODataV3Client` in one call.
- `fetchMetadataIndex` — just the runtime `MetadataIndex` (cache it as JSON; revive with `parseMetadataIndex` from `@1c-odata/client`).
- `parseEdmx` / `buildMetadataIndex` — lower-level: EDMX XML → typed model → runtime `MetadataIndex` (the same structure codegen emits as `__metadata.json`).
- Schema analysis helpers — entity kind classification (`Catalog_` / `Document_` / registers / …), tabular-part linking, ValueStorage detection, transitive closure.

Pure ESM. Node ≥ 24.18.0.

> ⚠️ **v0.x — pre-release.** API is unstable; see [STABILITY.md](https://github.com/hacker-cb/1c-odata/blob/master/STABILITY.md).

## Install

```bash
pnpm add @1c-odata/client @1c-odata/metadata
```

## Quick start

```ts
import { createDynamicClient } from '@1c-odata/metadata'

const client = await createDynamicClient(
  {
    baseUrl: 'http://1c.example.com/base/odata/standard.odata',
    auth: { username: 'user', password: 'pass' },
    serverTimezone: 'Europe/Moscow',
  },
  { validateOnWrite: true },
)
const { value } = await client.query('Catalog_Валюты').top(5).get()
```

The runtime `MetadataIndex` is plain JSON — cache it with `JSON.stringify` and revive with `parseMetadataIndex` from `@1c-odata/client`, or load a codegen-emitted `__metadata.json` from disk with `loadMetadataIndex` (also in `@1c-odata/client`). `fetchMetadataXml` exposes just the download step when you need the raw EDMX.

See the [repository README](https://github.com/hacker-cb/1c-odata#readme) for the full picture (typed codegen workflow, untyped mode, limitations).

## License

MIT
