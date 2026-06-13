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

Other commands: `list` (no passwords), `remove <name>`, `test <name>`.

Non-interactive (scripts / CI) — pass `--url` to skip the prompts:

```bash
# password from stdin (not visible in `ps`):
npx @1c-odata/mcp add my-base --url https://host/base/odata/standard.odata/ --login user --password-stdin <<<"$PW"
# or store only the non-secret config and supply the password via env at runtime:
ONEC_MY_BASE_PASSWORD=… npx @1c-odata/mcp add my-base --url https://host/base/odata/standard.odata/ --login user
```

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

Then ask the assistant to `list_connections`, explore the schema, and query data.

## Where data lives

- **`config.json`** — connection descriptors *without* passwords (base URL, login, timezone). Safe to read.
- **Passwords** — resolved in priority order: **env → OS keychain → `credentials.json` (0600)**.
  - `ONEC_<NAME>_PASSWORD` (e.g. `ONEC_MY_BASE_PASSWORD`) always wins — use it for CI / secret managers.
  - The keychain backend (`@napi-rs/keyring`) is optional; on headless Linux/CI it falls back to a `0600`
    file with a loud warning. Pass `--insecure-storage` to force the file backend.

Both files live in the data directory: `$ONEC_MCP_DATA_DIR` if set, otherwise the per-OS user config dir
(`~/.config/1c-odata`, `~/Library/Application Support/1c-odata`, `%APPDATA%\1c-odata`).

## Output size

Every read tool keeps its result within a byte budget so a large query can't overflow the model's context:
row sets are truncated to a usable sample (the response carries `truncated` / `hasMore` and a hint to narrow
the request), and an oversized individual field (e.g. a base64 `ValueStorage`) is capped with a marker. Tune
it with env vars (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `ONEC_MCP_DEFAULT_TOP` | `50` | Page size when a call omits `top`. |
| `ONEC_MCP_MAX_TOP` | `1000` | Hard ceiling on a call's `top`. |
| `ONEC_MCP_MAX_BYTES` | `24000` | Per-result byte budget for the returned rows. |

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
