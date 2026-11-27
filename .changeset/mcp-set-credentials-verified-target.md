---
"@1c-odata/mcp": patch
---

`set_credentials` and the CLI `set-credentials` no longer store a password for a server it was not verified on. They verify the new credentials against the connection as read before the change; where another process re-pointed the connection to another base URL or login during that verification (`add --force`, or `remove_connection` + `add_connection` in another MCP server), the password was stored for the new target and sent there on the next read. The change is now refused — "changed while its credentials were being verified … Nothing was changed" — and the stored password stays as it was.
