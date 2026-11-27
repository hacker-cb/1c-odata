---
"@1c-odata/mcp": patch
---

A connection named like a property every object inherits — `constructor`, `toString`, both valid names — is no longer mistaken for an existing connection while `config.json` is absent (or holds no `connections` object). Before, `remove_connection` and the CLI `remove` reported it removed, `set_label`, `set_credentials` and the CLI `set-credentials` "changed" it by writing `label` / `login` onto the global `Object`, the interactive CLI `add` asked whether to overwrite it, and a read went on with a function in place of its descriptor. Each now answers that there is no such connection, and the interactive `add` takes the name as a new one.
