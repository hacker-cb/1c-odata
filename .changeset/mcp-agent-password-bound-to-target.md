---
"@1c-odata/mcp": patch
---

A connection an agent added (`"addedBy": "agent"`) now reads only a password stored for its own server. Before, it read the stored password by name alone: an agent in an MCP process that could not delete a connection's keychain entry — no `@napi-rs/keyring`, `--insecure-storage`, a locked keychain — could `remove_connection` it and `add_connection` the name again pointing at its own server, and a process reading the keychain sent the person's password there. An agent's connection now stores its password under `<name>@<16 hex of sha256(base URL)>` — the keychain account and the `credentials.json` key — while a person's keeps `<name>`, so the person's password, and one stored for another server, are never read for it. A login change through `set_credentials` keeps it. A person re-adding the connection (CLI `add --force`) without a password clears what the agent stored. Connections a person added store their password as before.
