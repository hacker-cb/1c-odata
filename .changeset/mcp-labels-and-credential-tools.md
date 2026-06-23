---
"@1c-odata/mcp": minor
---

mcp: per-connection labels and credential-rotation tools

- Connections now carry an optional human-readable `label` (free-form, may be Cyrillic). It is surfaced by
  `list_connections` and the CLI `list`, and falls back to the connection name when unset — so existing
  configs need no migration.
- New `set_label` MCP tool and `1c-odata-mcp label <name> [label]` CLI command set or clear a connection's
  label (empty value reverts to the name). `add_connection` / `add --label` accept a label on creation.
- New `set_credentials` MCP tool and `1c-odata-mcp set-credentials <name>` CLI command change a connection's
  login and/or password in place (together or separately), preserving its base URL, timezone and label. The
  change is verified against `$metadata` before being persisted, the password is keyed on the connection name
  (so a login change never orphans it), and no tool ever returns it.
