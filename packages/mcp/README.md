# @1c-odata/mcp

MCP ([Model Context Protocol](https://modelcontextprotocol.io)) server for [1С:Enterprise](https://1c.ru/)
REST/OData V3 bases, built on [`@1c-odata/client`](../client) and [`@1c-odata/metadata`](../metadata).

**Read-only data access.** It exposes schema introspection and data queries — no create / update / delete of
1С data. Connections can be managed from the CLI (recommended — the password is typed with no echo) or via the
`add_connection` / `remove_connection` tools. No tool ever returns a stored password.

Works against any 1С base at runtime via the live `$metadata` (dynamic mode) — no code generation required.

## Tools

| Tool | Purpose |
|---|---|
| `list_connections` | Configured connections (name, base URL, login, timezone, password source). No passwords. |
| `refresh_metadata` | Drop the cached `$metadata` for a connection and re-download it. |
| `list_entities` | Entity sets, filtered by kind (catalog / document / register / …) and a name substring. Paginated. |
| `describe_entity` | One entity: properties (type / nullable / maxLength), keys, navigation properties, value storages, kind. |
| `list_enums` | Enumeration types and their members. |
| `query` | Read-only OData query: raw `$filter`, `$select`, `$expand`, `$orderby`, `$top`/`$skip`, optional count. |
| `get_entity` | Fetch a single entity by `Ref_Key`. |
| `count` | Count rows matching an optional `$filter`. |
| `register_query` | Register virtual tables: balance / turnovers / slices / accounting (read-only analytics). |
| `add_connection` | Add/update a connection (writes config; optional password stored securely, never returned). |
| `remove_connection` | Remove a connection and delete its stored password. |

## Quick start

### 1. Add a connection (in a terminal)

```console
$ npx @1c-odata/mcp add my-base
Connection name: my-base
Base URL: https://your-1c-host/base/odata/standard.odata/
Login: your-user
Password: ********            # typed with no echo — never stored in shell history or argv
Server timezone [Europe/Moscow]: Europe/Moscow
Verifying connection… OK
✓ Connection "my-base" saved.
  config:   ~/.config/1c-odata/config.json
  password: OS keychain
```

The installed binary is `1c-odata-mcp` (the name the tool prints in its own hints); the `npx @1c-odata/mcp <cmd>`
form shown here is the no-install equivalent. Other commands: `list` (no passwords), `remove <name>`, `test <name>`.

Non-interactive (scripts / CI) — pass `--url` to skip the prompts:

```bash
# password from stdin (not visible in `ps`):
npx @1c-odata/mcp add my-base --url https://host/base/odata/standard.odata/ --login user --password-stdin <<<"$PW"
# or store only the non-secret config and supply the password via env at runtime:
ONEC_MY_BASE_PASSWORD=… npx @1c-odata/mcp add my-base --url https://host/base/odata/standard.odata/ --login user
```

The interactive `add` (no `--url`) needs a real terminal; in a non-TTY context (CI, an agent) it errors and
points you here. An **env-supplied password is verified but not copied to storage** — keep
`ONEC_<NAME>_PASSWORD` exported in the environment that runs `serve`, not only during `add`.

### 2. Register the server with your MCP client

Add to your client config — `.mcp.json` (project), `~/.claude.json`, or `claude_desktop_config.json`:

```jsonc
{
  "mcpServers": {
    "1c-odata": {
      "command": "npx",
      "args": ["-y", "@1c-odata/mcp", "serve"]
    }
  }
}
```

For a custom agent that can't reach the OS keychain, ship a predefined data dir and pass each connection's
password through the `env` block — reference a variable your shell / secret manager exports rather than a
literal secret in a committed file (`${VAR}` expansion is supported by Claude Code; other clients may need the
value inlined or their own secret mechanism):

```jsonc
{
  "mcpServers": {
    "1c-odata": {
      "command": "npx",
      "args": ["-y", "@1c-odata/mcp", "serve"],
      "env": {
        "ONEC_MCP_DATA_DIR": "/abs/path/to/agent-data-dir",
        "ONEC_MY_BASE_PASSWORD": "${ONEC_MY_BASE_PASSWORD}"
      }
    }
  }
}
```

Connections load lazily — `serve` starts instantly and downloads a base's `$metadata` only on first use, so a
predefined `config.json` plus `ONEC_<NAME>_PASSWORD` env vars is enough; nothing connects at boot.

Then ask the assistant to `list_connections`, explore the schema, and query data.

## Where data lives

Both files live in one **agent-independent** data directory, so a connection added once is shared by every
MCP client (Claude Code, Claude Desktop, Codex, ChatGPT, …) — they all spawn the same `serve` process and
resolve the same directory. Resolution order (first non-blank wins; the result **must be absolute** — a
relative `--data-dir` / `ONEC_MCP_DATA_DIR` is a hard error, not a silent fallback):

1. the `--data-dir <path>` flag,
2. `$ONEC_MCP_DATA_DIR` (env override — sandboxed / portable / CI),
3. the per-user default — `~/.config/1c-odata` on macOS **and** Linux (honoring an absolute `$XDG_CONFIG_HOME`)
   or `%APPDATA%\1c-odata` on Windows. macOS deliberately uses the XDG `~/.config` path, not
   `~/Library/Application Support`, for cross-platform / container consistency.

- **`config.json`** — connection descriptors *without* passwords (base URL, login, timezone, optional shape).
  Safe to read / surface to an LLM.
- **Passwords** — resolved in priority order **env → OS keychain → `credentials.json` (0600)**:
  - **`ONEC_<NAME>_PASSWORD`** always wins — use it for CI / secret managers / agent configs. The name is the
    connection name upper-cased with every run of non-`[A-Z0-9]` characters collapsed to a single `_`
    (leading/trailing `_` stripped): `my-base` → `ONEC_MY_BASE_PASSWORD`, `tvip-trade` →
    `ONEC_TVIP_TRADE_PASSWORD`, `bp.v3` → `ONEC_BP_V3_PASSWORD`.
  - **OS keychain** (`@napi-rs/keyring`, an optional dependency) — the entry is namespaced **per data
    directory**: service `1c-odata:<data-dir basename>:<first 8 hex of sha256(absolute data dir)>`, with the
    connection name as the account (e.g. service `1c-odata:1c-odata:7149e725`, account `trade`). The basename
    and account are human-readable hints in Keychain Access / Credential Manager; the hash isolates dirs. Two
    clients on the **same** data dir share the secret; a **different** `--data-dir` / `ONEC_MCP_DATA_DIR` is a
    separate namespace.
  - **`credentials.json` (0600)** — the fallback when the keychain is unavailable (headless Linux / CI) or
    `--insecure-storage` is passed; it lives inside the data dir and is loud about the downgrade. On non-Windows
    a credentials file with permissions looser than `0600` is **refused on read** (with a `chmod 600` hint) so
    its plaintext is never loaded.

**Connection names** are an ASCII alias — a letter or digit first, then letters, digits, `-`, `_`
(`/^[A-Za-z0-9][A-Za-z0-9_-]*$/`); a Cyrillic 1С base name needs such an alias. Because the env-var slug
collapses `-` and `_` to the same `_`, two names differing only in `-`/`_` (e.g. `a-b` and `a_b`) would map to
one `ONEC_A_B_PASSWORD` — `add` rejects the colliding second name, so pick a distinct one.

> **Upgrading from ≤ 0.4.x.** Keychain secrets are now namespaced per data directory (see above). A password
> stored by an earlier version under the old flat `1c-odata` service is **not migrated** and won't be found —
> `list` reports its source as `none`. Re-add it (`1c-odata-mcp add <name>`) or export `ONEC_<NAME>_PASSWORD`.
> `config.json`, `credentials.json`, and env passwords are unaffected. Likewise, **moving the data dir**
> re-hashes the keychain service and orphans keychain-stored secrets — the `credentials.json` file travels with
> the dir and env passwords are independent, so both survive a move.

## Output size

Every read tool keeps its result within a byte budget so a large query can't overflow the model's context:
row sets are truncated to a usable sample (the response carries `truncated` / `hasMore` and a hint to narrow
the request), and an oversized individual field (e.g. a base64 `ValueStorage`) is capped with a marker. One
row is always returned even if it alone exceeds the budget, so you still see the shape (narrow with `select`
or `compact`); `get_entity` instead refuses an over-budget entity and points you to `query` + `$select`. Tune
it with env vars (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `ONEC_MCP_DEFAULT_TOP` | `50` | Page size when a call omits `top`. |
| `ONEC_MCP_MAX_TOP` | `1000` | Hard ceiling on a call's `top`. |
| `ONEC_MCP_MAX_BYTES` | `24000` | Per-result byte budget for the returned rows. |
| `ONEC_MCP_MAX_REGISTER_ROWS` | `100000` | Cap on rows fetched from a register virtual table before client-side paging; beyond it `register_query` returns a `totalCapped` floor. |

Pass `compact: true` to `query` / `get_entity` / `register_query` to also drop 1С `*_Type` annotation
companions (and `@odata` noise) and fit more rows per response. Caveat: that also removes composite-type
discriminators such as `Value_Type` / `Ref_Type`, so omit it when you need to know which entity a `*_Key`
references.

## Security

- **No tool ever returns a stored password.** `list_connections` shows only where each password lives.
- Prefer the CLI for entering a password (no-echo prompt) or the `ONEC_<NAME>_PASSWORD` env var, so the secret
  never reaches the model's context, the transcript, or `ps`.
- The MCP `add_connection` tool accepts an optional `password`, but passing it there places it in the model
  context/transcript — omit it (and use the CLI/env) unless you accept that trade-off.
- All tool output and error text is redacted of URL userinfo; `config.json` carries no secrets; the fallback
  credentials file is `0600` and lives outside the project.
