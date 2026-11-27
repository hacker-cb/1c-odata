---
"@1c-odata/mcp": patch
---

An `add_connection` overwrite that keeps the password — a new label or timezone — no longer drops the connection's built client from the server's pool, which forced a needless `$metadata` download. Since the pool compares a connection with what its client was built from on every use, such a change still reaches the next call. Where a tool may change which password a connection uses — `add_connection` adding one or storing or clearing a password, `set_credentials` changing something, `remove_connection` — the client is still dropped, so a password is never used once it is gone, also where the new one cannot be read back. A `set_credentials` that changes nothing keeps it.
