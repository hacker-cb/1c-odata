---
"@1c-odata/mcp": minor
---

mcp: add a `server_info` tool

New read-only `server_info` MCP tool reports the running server's version (the
same value carried in the MCP `initialize` handshake, resolved from the
package), the data directory holding config + credentials, and how many
connections are configured. This makes the version answerable from within a
conversation, not just from the host-level handshake / CLI `--version`. Never
returns secrets.
