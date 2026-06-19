---
"@1c-odata/mcp": patch
---

fix(mcp): isolate OS-keychain secrets per data directory

The keychain entry was keyed by a constant service name (`1c-odata`) plus the bare
connection name, with no reference to the data directory — so two data dirs
(separate projects/agents) that defined a connection with the same name shared one
keychain secret: adding in one overwrote the other, removing deleted the other.
`config.json` and `credentials.json` were already isolated per data dir; the
keychain now matches them.

The keychain service is now `1c-odata:<data-dir basename>:<first 8 hex of
sha256(canonical data dir)>` — the basename is a human-readable hint (visible in
Keychain Access / Credential Manager) of which data dir a secret belongs to, the
hash is the actual per-dir discriminator. The connection name stays the account.
Two clients resolving the **same** data dir compute the same service and keep
sharing (the agent-independent default-dir model is preserved); two **different**
dirs isolate.

**Behavior change — re-add passwords.** Secrets stored under the previous flat
service are no longer found (no automatic migration). Re-add the password
(`1c-odata-mcp add <name>`) or supply it via `ONEC_<NAME>_PASSWORD`. The non-secret
`config.json`, the `credentials.json` file backend, and env-var passwords are
unaffected.
