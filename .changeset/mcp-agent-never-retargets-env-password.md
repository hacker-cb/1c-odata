---
"@1c-odata/mcp": patch
---

An agent can no longer route a connection's `ONEC_<NAME>_PASSWORD` to a server it chose through another MCP process. Every MCP process shares one data directory while the variable is set per process, and the guard from 0.11.0 looked only at its own process's environment: an agent in a process without the variable could re-point a connection (`add_connection` with `overwrite`, or `remove_connection` then `add_connection`) — or create a name nobody had added yet — and a process holding the variable then sent the password to that server. Now, whatever the process's environment:

- `add_connection` never points an existing connection at another `baseUrl` or `login` — a person re-points one with the CLI `1c-odata-mcp add <name> --force`. An overwrite keeping both (a timezone, a label, a password) is taken as before.
- A connection `add_connection` creates is marked `"addedBy": "agent"` in `config.json` and never takes its password from `ONEC_<NAME>_PASSWORD`, in any process: it uses a password given through `add_connection` / `set_credentials`, and `set_credentials` / `set-credentials` now take one for it even where the variable is set. The CLI `add` (also `--force`) writes no mark, so a person re-adding the connection makes the variable apply again. `list_connections` reports the mark as `addedBy: "agent"`, the CLI `list` as an `added by` line, and a missing password for such a connection says the variable is not used.

`addedBy` is a new optional field of a `config.json` entry. An MCP process of an earlier version neither writes nor keeps it: update every MCP process sharing the data directory. Connections already in `config.json` count as added by a person.
