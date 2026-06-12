# @1c-odata/metadata

1С:Enterprise OData V3 schema toolkit for [`@1c-odata/client`](https://www.npmjs.com/package/@1c-odata/client):

- `parseEdmx` — parse `$metadata` (EDMX XML) into a typed model.
- `buildMetadataIndex` — build a runtime `MetadataIndex` (the same structure codegen emits as `__metadata.json`) straight from the parsed model, no files involved.
- Schema analysis helpers — entity kind classification (`Catalog_` / `Document_` / registers / …), tabular-part linking, ValueStorage detection, transitive closure.

Use it to run `@1c-odata/client` against **any** 1С base at runtime — full date / Int64 / ValueStorage handling and write validation without generating TypeScript types. Codegen (`@1c-odata/cli`) consumes this package under the hood, so the EDMX schema stays the single source of truth for both workflows.

Pure ESM. Node ≥ 22.21.0.

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

Lower-level building blocks: `fetchMetadataXml` (download), `parseEdmx` (XML → model), `buildMetadataIndex` (model → index), `fetchMetadataIndex` (all three in one step). The index is plain JSON — cache it with `JSON.stringify` and revive with `parseMetadataIndex` from `@1c-odata/client`.

See the [repository README](https://github.com/hacker-cb/1c-odata#readme) for the full picture (typed codegen workflow, untyped mode, limitations).

## License

MIT
