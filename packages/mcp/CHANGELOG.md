# @1c-odata/mcp

## 0.4.1

### Patch Changes

- [#39](https://github.com/hacker-cb/1c-odata/pull/39) [`b187b01`](https://github.com/hacker-cb/1c-odata/commit/b187b014074601526a49928c74a3064feede3b12) Thanks [@hacker-cb](https://github.com/hacker-cb)! - fix(release): publish via `pnpm pack` so `workspace:*` deps are rewritten to concrete versions

  The release workflow published with `npm publish`, which does not rewrite the
  `workspace:` protocol. As a result `@1c-odata/metadata` and `@1c-odata/cli` (and
  transitively `@1c-odata/mcp`) shipped with `"@1c-odata/client": "workspace:*"` in
  their published manifests and were uninstallable from npm (`EUNSUPPORTEDPROTOCOL`).
  The workflow now publishes a `pnpm pack` tarball, which rewrites workspace deps to
  the released version, so a plain `npm install` / `npx` resolves them. (`@1c-odata/client`
  is dependency-free and was unaffected; it bumps with the fixed group.)

- Updated dependencies [[`b187b01`](https://github.com/hacker-cb/1c-odata/commit/b187b014074601526a49928c74a3064feede3b12)]:
  - @1c-odata/client@0.4.1
  - @1c-odata/metadata@0.4.1

## 0.4.0

### Minor Changes

- [#25](https://github.com/hacker-cb/1c-odata/pull/25) [`5a47896`](https://github.com/hacker-cb/1c-odata/commit/5a478961d4e6d1c8f20a89a4a61d5ae75dff50c0) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Add `@1c-odata/mcp` — a read-only MCP (Model Context Protocol) server for 1С:Enterprise OData V3 bases, built on `@1c-odata/client` and `@1c-odata/metadata`.

  - **Schema tools**: `list_connections`, `list_entities` (filter by kind/name, paginated), `describe_entity` (properties, keys, navigation, value storages), `list_enums`, `refresh_metadata`.
  - **Data tools**: `query` (raw `$filter`/`$select`/`$expand`/`$orderby`, paging, optional count), `get_entity`, `count`, `register_query` (balance / turnovers / slices / accounting virtual tables, paginated via `top`/`skip`; the returned `total` is exact below the register-fetch cap, a `totalCapped` floor beyond it).
  - **Bounded output**: every read tool keeps its result within a configurable byte budget — large row sets are truncated to a usable sample (with `truncated`/`hasMore` and a nudge to narrow), and oversized individual fields (e.g. a base64 `ValueStorage`) are capped with a marker, so a single fat row or entity can't overflow it either. Opt-in `compact` additionally drops 1С `*_Type` / `@odata` annotation noise. `register_query` additionally caps the rows it fetches from a register FI (degrading to a `totalCapped` floor beyond the cap). Page size, byte budget, and register-fetch cap are env-configurable (`ONEC_MCP_DEFAULT_TOP`, `ONEC_MCP_MAX_TOP`, `ONEC_MCP_MAX_BYTES`, `ONEC_MCP_MAX_REGISTER_ROWS`); results serialize as compact JSON.
  - **Connection management** — CLI `1c-odata-mcp add`/`list`/`remove`/`test` (interactive no-echo password, or non-interactive via `--url`/`--login`/`--password-stdin`/env), plus MCP `add_connection`/`remove_connection` tools. Secrets resolve env → OS keychain (`@napi-rs/keyring`, optional) → `0600` file; no tool ever returns a password, and `config.json` carries none.
  - Works against any base at runtime via live `$metadata` (dynamic mode); read-only by design.

### Patch Changes

- Updated dependencies [[`70cef5e`](https://github.com/hacker-cb/1c-odata/commit/70cef5e9066422c15871874b47f79cb06efdc777), [`8a09e92`](https://github.com/hacker-cb/1c-odata/commit/8a09e92b7422e4e855b1b3e9bf726f61bcd53d9b), [`27c207a`](https://github.com/hacker-cb/1c-odata/commit/27c207a770b6969872db5f07b7a334574313a12a), [`4415ac4`](https://github.com/hacker-cb/1c-odata/commit/4415ac4dae057a5c5131aad18ddedc0a7ba738de), [`c48e6dc`](https://github.com/hacker-cb/1c-odata/commit/c48e6dcb661ddbd30a715f9292c36723fa900197), [`f065038`](https://github.com/hacker-cb/1c-odata/commit/f0650388106795f5754d2f77574cfee8d45f50f9), [`968a14e`](https://github.com/hacker-cb/1c-odata/commit/968a14e3c52e70026a1c4eae5336d63c0ca386b3), [`b1507e8`](https://github.com/hacker-cb/1c-odata/commit/b1507e8c98bba793527cfdb8a07059b06628f983)]:
  - @1c-odata/client@0.4.0
  - @1c-odata/metadata@0.4.0
