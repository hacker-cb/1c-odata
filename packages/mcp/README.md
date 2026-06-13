# @1c-odata/mcp

MCP ([Model Context Protocol](https://modelcontextprotocol.io)) server for [1С:Enterprise](https://1c.ru/)
REST/OData V3 bases, built on [`@1c-odata/client`](../client) and [`@1c-odata/metadata`](../metadata).

**Read-only by design.** It exposes schema introspection and data queries — no create / update / delete.
Connections are managed from the CLI (where the password is typed with no echo); the LLM-facing tools never
see a password and never write to disk.

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

## Quick start

### 1. Add a connection (in a terminal)

```console
$ npx @1c-odata/mcp add my-base
Connection name: my-base
Base URL (you may include user:password@): https://your-1c-host/base/odata/standard.odata/
Login: your-user
Password: ********            # typed with no echo — never stored in shell history or argv
Server timezone [Europe/Moscow]: Europe/Moscow
Verifying connection… OK
✓ Connection "my-base" saved.
  config:   ~/.config/1c-odata/config.json
  password: OS keychain
```

Other commands: `list` (no passwords), `remove <name>`, `test <name>`.

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

## Security

- The password is never a tool argument and never a CLI argument — only a no-echo prompt or an env var,
  so it never reaches the model's context, the transcript, or `ps`.
- Tools are read-only and never return or log a password; all output is redacted of URL userinfo.
- `config.json` carries no secrets; the fallback credentials file is `0600` and lives outside the project.
