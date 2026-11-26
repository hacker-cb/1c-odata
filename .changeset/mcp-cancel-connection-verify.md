---
"@1c-odata/mcp": patch
---

MCP `add_connection` and `set_credentials` now stop when the MCP client cancels the call (`notifications/cancelled`): the `$metadata` download that verifies the credentials — 10+ MB on a big base — is aborted instead of running to its end, and the cancelled call stores nothing, even one cancelled while it waits for another call's write to the config. `verifyConnectivity()` (from `@1c-odata/mcp/internal`) takes an optional `signal` for this.
