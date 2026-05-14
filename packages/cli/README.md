# @1c-odata/cli

Two binaries for [`@1c-odata/client`](https://www.npmjs.com/package/@1c-odata/client):

- `1c-odata fetch` — downloads `$metadata` (EDMX) from a 1С:Enterprise OData V3 endpoint and saves it locally.
- `1c-odata generate` — generates TypeScript types from the saved EDMX (per-connection output under `generated/<connection>/`).

Codegen library is also exposed at [`@1c-odata/cli/codegen`](https://github.com/hacker-cb/1c-odata/tree/master/packages/cli/src/codegen) for programmatic use.

Pure ESM. Node ≥ 22.21.

> ⚠️ **v0.x — pre-release.** API is unstable; see [STABILITY.md](https://github.com/hacker-cb/1c-odata/blob/master/STABILITY.md).

## Install

```bash
pnpm add -D @1c-odata/cli @1c-odata/client
```

## Quick start

`1c-odata.config.ts`:

```ts
import { defineConfig, parseConnectionUrl } from '@1c-odata/client'

const url = process.env.ONEC_URL
if (!url) throw new Error('Set ONEC_URL (format: http://user:pwd@host/path)')

export default defineConfig({
  connections: {
    trade: {
      ...parseConnectionUrl(url),
      serverTimezone: 'Europe/Moscow',
      codegen: { include: ['Catalog_*', 'Document_*'] },
    },
  },
})
```

Fetch + generate:

```bash
export ONEC_URL=http://u:p@1c.example.com/odata/standard.odata
pnpm 1c-odata fetch
pnpm 1c-odata generate
```

See [the repo README](https://github.com/hacker-cb/1c-odata#readme) for project-wide setup and [`examples/basic`](https://github.com/hacker-cb/1c-odata/tree/master/examples/basic) for a runnable consumer.

## License

[MIT](./LICENSE)
