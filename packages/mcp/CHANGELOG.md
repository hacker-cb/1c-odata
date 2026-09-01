# @1c-odata/mcp

## 0.7.0

### Minor Changes

- [#56](https://github.com/hacker-cb/1c-odata/pull/56) [`1a64c54`](https://github.com/hacker-cb/1c-odata/commit/1a64c54e3afb80436c9222cae5c994f9d620f969) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Refactor `@1c-odata/mcp` for multi-tenant reuse (prep for a remote multi-tenant host).

  - New `@1c-odata/mcp/internal` subpath exposing the reusable building blocks — `ConnectionPool`, the new `ConnectionSource`/`FileConnectionSource` seam, `ReadPool`, the read-only tool registrators (`registerSchemaTools`/`registerDataTools`/`registerServerInfoTool`), and the response-limit helpers. The connection-management tools stay off this surface (admin-only).
  - `ConnectionPool` now takes a `ConnectionSource` (where connections and secrets come from) instead of `{ dataDir }`; the local stdio server injects a `FileConnectionSource` (config.json + keychain) and is unchanged. The read-only tool registrators now accept a `ReadPool`.
  - The programmatic building blocks previously reachable from the `@1c-odata/mcp` root (`ConnectionPool`, `SecretStore`, `passwordEnvVar`, …) moved to `@1c-odata/mcp/internal`; the root now exposes only the local-server entry (`createMcpServer`, `runServe`) and config/data-dir helpers. No CLI, MCP-tool, or on-disk contract changed.

- [#126](https://github.com/hacker-cb/1c-odata/pull/126) [`3146289`](https://github.com/hacker-cb/1c-odata/commit/3146289e4304b1ea5bf531be6a8496456c6cf228) Thanks [@hacker-cb](https://github.com/hacker-cb)! - **Breaking:** the minimum supported Node version is now 24.18.0 (was 22.21.0).

  Node 22 "Jod" has left active LTS and is in maintenance; Node 24 "Krypton" is
  the active LTS line and is supported until 2028-04-30. Installing on Node 22
  will now be refused or warned about by npm/pnpm, depending on your client.

  No source change accompanies this. The library does not yet use any API that
  Node 22 lacks — the floor moves so that the version CI exercises and the version
  the packages advertise are one and the same. Keeping the advertised floor below the tested one meant the
  promise was never actually verified, which is the defect this closes.

  `@types/node` is pinned to the matching major for the same reason: types
  describing a runtime above the floor let an API that does not exist there
  typecheck green and fail at runtime for anyone who installed at the advertised
  minimum.

  If you are pinned to Node 22, stay on the previous release until you can move —
  v0.x carries no compatibility shims (see STABILITY.md).

### Patch Changes

- [#58](https://github.com/hacker-cb/1c-odata/pull/58) [`bf78afc`](https://github.com/hacker-cb/1c-odata/commit/bf78afceb30cc89123e112f451a829e03930e57a) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Prep `@1c-odata/mcp/internal` for a DB-backed multi-tenant host. Additive only — no CLI, MCP-tool, on-disk, or local stdio behavior changed.

  - `SecretSource` gains a `'db'` variant so a DB-backed `ConnectionSource` can report the real password origin in `list_connections`. `SecretStore` itself never returns it (file/keychain/env only).
  - `@1c-odata/mcp/internal` now re-exports `verifyConnectivity` — the standalone `$metadata` reachability probe (no `dataDir` dependency), reused by a remote host to verify a base before saving it. The connection-management functions (`upsertConnection`/`removeConnection`/`updateConnectionCredentials`/`setConnectionLabel`) stay private — they are bound to the file-backed config.

- [#162](https://github.com/hacker-cb/1c-odata/pull/162) [`4c57cdb`](https://github.com/hacker-cb/1c-odata/commit/4c57cdba8e317db65074909ba268f0112bb0af1a) Thanks [@hacker-cb](https://github.com/hacker-cb)! - `@1c-odata/mcp/internal` re-exports for alternate hosts:

  - `assertValidConnectionName` / `isValidConnectionName`, so a DB-backed admin
    write path enforces the same ASCII connection-name rule as the file-backed
    store.
  - `InvalidArgumentError` (from `@1c-odata/client`), so a scoping wrapper throws
    the pool's canonical not-found error without a new dependency — an ungranted
    base is then byte-identical to a missing one.

- Updated dependencies [[`3146289`](https://github.com/hacker-cb/1c-odata/commit/3146289e4304b1ea5bf531be6a8496456c6cf228)]:
  - @1c-odata/client@0.7.0
  - @1c-odata/metadata@0.7.0

## 0.6.0

### Minor Changes

- [#52](https://github.com/hacker-cb/1c-odata/pull/52) [`fe30fdc`](https://github.com/hacker-cb/1c-odata/commit/fe30fdc3890b7ab99458567fb15eabbb64e23a6d) Thanks [@hacker-cb](https://github.com/hacker-cb)! - mcp: per-connection labels and credential-rotation tools

  - Connections now carry an optional human-readable `label` (free-form, may be Cyrillic). It is surfaced by
    `list_connections` and the CLI `list`, and falls back to the connection name when unset — so existing
    configs need no migration.
  - New `set_label` MCP tool and `1c-odata-mcp label <name> [label]` CLI command set or clear a connection's
    label (empty value reverts to the name). `add_connection` / `add --label` accept a label on creation.
  - New `set_credentials` MCP tool and `1c-odata-mcp set-credentials <name>` CLI command change a connection's
    login and/or password in place (together or separately), preserving its base URL, timezone and label. The
    change is verified against `$metadata` before being persisted when a password is available (the CLI also
    offers `--no-verify`), the password is keyed on the connection name (so a login change never orphans it),
    and no tool ever returns it.

- [#54](https://github.com/hacker-cb/1c-odata/pull/54) [`5b4df45`](https://github.com/hacker-cb/1c-odata/commit/5b4df45ec54f057514b8fc0ade82c9be1282d400) Thanks [@hacker-cb](https://github.com/hacker-cb)! - mcp: add a `server_info` tool

  New read-only `server_info` MCP tool reports the running server's version (the
  same value carried in the MCP `initialize` handshake, resolved from the
  package), the data directory holding config + credentials, and how many
  connections are configured. This makes the version answerable from within a
  conversation, not just from the host-level handshake / CLI `--version`. Never
  returns secrets.

### Patch Changes

- [#55](https://github.com/hacker-cb/1c-odata/pull/55) [`d90af38`](https://github.com/hacker-cb/1c-odata/commit/d90af38bfbccc6837fcd57c1d17940948094f259) Thanks [@hacker-cb](https://github.com/hacker-cb)! - mcp: print help on a bare CLI invocation instead of silently starting the server

  `1c-odata-mcp` with no subcommand now prints its help (the command list) instead
  of starting the stdio MCP server, which — when run by a human in a terminal —
  just hung waiting for JSON-RPC on stdin with no indication of what it was doing.
  The server is now reached only via the explicit `serve` subcommand, which is how
  MCP clients already launch it (`args: ["-y", "@1c-odata/mcp", "serve"]` — see the
  README). Standard client configs are unaffected; only a bare `1c-odata-mcp` used
  as a server entrypoint needs `serve` appended.

- Updated dependencies []:
  - @1c-odata/client@0.6.0
  - @1c-odata/metadata@0.6.0

## 0.5.0

### Minor Changes

- [#41](https://github.com/hacker-cb/1c-odata/pull/41) [`ea230be`](https://github.com/hacker-cb/1c-odata/commit/ea230be094c9deb3c93a5f7c7d95ba7d773346df) Thanks [@hacker-cb](https://github.com/hacker-cb)! - fix(mcp): isolate OS-keychain secrets per data directory

  This is a behavioral break (stored keychain secrets stop resolving — see below), so
  per the stability policy it ships as a minor bump in v0.x, not a patch.

  The keychain entry was keyed by a constant service name (`1c-odata`) plus the bare
  connection name, with no reference to the data directory — so two data dirs
  (separate projects/agents) that defined a connection with the same name shared one
  keychain secret: adding in one overwrote the other, removing deleted the other.
  `config.json` and `credentials.json` were already isolated per data dir; the
  keychain now matches them.

  The keychain service is now `1c-odata:<data-dir basename>:<first 8 hex of
sha256(canonical data dir)>` — the basename is a human-readable hint (visible in
  Keychain Access / Credential Manager) of which data dir a secret belongs to, the
  hash is the actual per-dir discriminator. The connection name stays the account.
  Two clients resolving the **same** data dir compute the same service and keep
  sharing (the agent-independent default-dir model is preserved); two **different**
  dirs isolate.

  **Behavior change — re-add passwords.** Secrets stored under the previous flat
  service are no longer found (no automatic migration). Re-add the password
  (`1c-odata-mcp add <name>`) or supply it via `ONEC_<NAME>_PASSWORD`. The non-secret
  `config.json`, the `credentials.json` file backend, and env-var passwords are
  unaffected.

### Patch Changes

- [#48](https://github.com/hacker-cb/1c-odata/pull/48) [`370921e`](https://github.com/hacker-cb/1c-odata/commit/370921ee855e48763c1d7c400827d5831f446cde) Thanks [@hacker-cb](https://github.com/hacker-cb)! - docs(mcp): document config locations, secrets, and custom-agent setup; clarify the add_connection name rule

  Expands the package README and adds an `@1c-odata/mcp` section to STABILITY.md:

  - Per-data-dir OS-keychain isolation and the service-name format
    (`1c-odata:<basename>:<8 hex of sha256(canonical data dir)>`, account = connection name),
    plus the no-migration / data-dir-move upgrade caveats.
  - The `ONEC_<NAME>_PASSWORD` slug rule, the connection-name charset, and the
    `-`/`_` env-var collision.
  - That an env-supplied password is verified but not persisted (must stay exported
    at `serve` time), and the non-TTY `add` behavior.
  - A `.mcp.json` `env`-block example and the lazy-load model for shipping a
    predefined connection set to a custom agent.
  - The 0600 `credentials.json` read refusal and the data-dir resolution order
    (relative paths throw).

  Also corrects the `add_connection` tool description to state the
  leading-alphanumeric connection-name rule the code enforces.

- Updated dependencies [[`bc33cc0`](https://github.com/hacker-cb/1c-odata/commit/bc33cc0733238ee241d3106b9854c78bf02fb62b)]:
  - @1c-odata/client@0.5.0
  - @1c-odata/metadata@0.5.0

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
