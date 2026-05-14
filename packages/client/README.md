# @1c-odata/client

Typed runtime for the 1С:Enterprise OData V3 interface — `ODataV3Client`, query builder, filter DSL, value-storage helpers, and register helpers.

Server-side only. Pure ESM. Node ≥ 22.21.0.

> ⚠️ **v0.x — pre-release.** API is unstable; see [STABILITY.md](https://github.com/hacker-cb/1c-odata/blob/master/STABILITY.md).

## Install

```bash
pnpm add @1c-odata/client
pnpm add -D @1c-odata/cli   # generates types from $metadata
```

## Quick start

Assuming this file lives at `src/main.ts` (so `../generated/` and `../1c-odata.config.js` resolve to the sibling codegen output and project config):

```ts
import { clientOptionsFromConnection, ODataV3Client } from '@1c-odata/client'
import { and, any } from '@1c-odata/client/filter'
import type { Document_РТУ } from '../generated/trade/index.js'
import config from '../1c-odata.config.js'

const trade = new ODataV3Client(clientOptionsFromConnection(config.connections.trade!))

const { value: docs } = await trade
  .query<Document_РТУ>('Document_РТУ')
  .filter((f) => and(f.Date.year().eq(2025), any(f.Товары, (t) => t.Сумма.gt(10000))))
  .top(50)
  .get()
```

See [`examples/basic`](https://github.com/hacker-cb/1c-odata/tree/master/examples/basic) for a runnable end-to-end consumer, and [the repo README](https://github.com/hacker-cb/1c-odata#readme) for project-wide setup (network config, cross-platform Cyrillic filename handling, codegen flow).

## License

[MIT](./LICENSE)
