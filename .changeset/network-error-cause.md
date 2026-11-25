---
"@1c-odata/client": patch
"@1c-odata/mcp": patch
---

`NetworkError` now names the underlying cause instead of undici's bare `fetch failed`: the code and text of `error.cause` are appended — `Network error: fetch failed (UNABLE_TO_GET_ISSUER_CERT_LOCALLY: unable to get local issuer certificate)`, `ENOTFOUND`, `ECONNREFUSED` — including the per-address errors of a multi-address connect failure, whose own message is empty. A certificate-trust failure also gets a hint to trust the issuing CA with `NODE_EXTRA_CA_CERTS` or the OS store with `NODE_USE_SYSTEM_CA=1`. The MCP server shows the same text, so `add_connection` (when it verifies a password) and every tool that reaches a base now say why it is unreachable. The original error stays in `error.cause`. README "Network configuration" documents `NODE_USE_SYSTEM_CA` and the MCP server's `env` block.
