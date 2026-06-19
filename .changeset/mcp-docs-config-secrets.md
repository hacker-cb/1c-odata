---
"@1c-odata/mcp": patch
---

docs(mcp): document config locations, secrets, and custom-agent setup; clarify the add_connection name rule

Expands the package README and adds an `@1c-odata/mcp` section to STABILITY.md:

- Per-data-dir OS-keychain isolation and the service-name format
  (`1c-odata:<basename>:<8 hex of sha256(data dir)>`, account = connection name),
  plus the no-migration / data-dir-move upgrade caveats.
- The `ONEC_<NAME>_PASSWORD` slug rule, the connection-name charset, and the
  `-`/`_` env-var collision.
- That an env-supplied password is verified but not persisted (must stay exported
  at `serve` time), and the non-TTY `add` behavior.
- A `.mcp.json` `env`-block example and the lazy-load model for shipping a
  predefined connection set to a custom agent.
- The 0600 `credentials.json` read refusal and the data-dir resolution order
  (relative paths throw).

Also corrects the `add_connection` tool description to state the
leading-alphanumeric connection-name rule the code enforces.
