---
'@1c-odata/mcp-server': minor
'@1c-odata/mcp': patch
---

feat(mcp-server): multi-tenant, per-user base scoping with encrypted secrets

Adds a database-backed multi-tenancy layer to the remote MCP server, active
**only when auth is enabled** (a `--public-url` deployment that also supplies an
encryption key). Without auth, the server is unchanged: the file-backed
`FileConnectionSource` and an unscoped connection pool.

- **Encrypted secrets at rest.** 1С passwords are sealed with AES-256-GCM
  (`src/store/crypto.ts`). The base name is the AAD, so a stored secret is
  cryptographically bound to its base — a swapped ciphertext fails to decrypt. Each
  row records the `key_id` that sealed it, so the KEK can be rotated: supply the
  current key via `--enc-key` or `ONEC_MCP_ENC_KEY` (base64 32-byte;
  `openssl rand -base64 32`) and any retired keys via `ONEC_MCP_ENC_KEYS_PREVIOUS`.
  A missing/malformed key fails boot loudly.
- **Our tables** (`bases`, `base_secrets`, `grants`, `health`) live in a
  hand-written `src/store/tenancy-schema.ts`, merged with better-auth's generated
  schema. `grants.sub` FKs `user.id`. The committed `drizzle/0001_*.sql` ships the
  DDL and is applied by the drizzle-orm migrator on BOTH paths — pglite (dev/tests)
  and Postgres (prod) run the exact same SQL.
- **Per-user scoping.** A `DbConnectionSource` decrypts secrets at read time; a
  per-session `ScopedPool` fronts the shared pool and restricts every operation
  to the caller's granted bases, resolving grants **fresh on every tool-call** so
  a revoked grant takes effect on the user's next call — no reconnect. An
  ungranted base yields the **same** `No connection named "…"` error as a base
  that does not exist, so scoping never leaks base existence.
- **Session ↔ subject binding.** Each MCP session is pinned to the `sub` that
  opened it; a different valid token replaying that session id is rejected with
  `403` — a valid bearer token can no longer hijack another user's session.

`@1c-odata/mcp` gets a one-line internal re-export (`InvalidArgumentError` from
`/internal`) so the scoped pool throws the pool's canonical not-found error
without a new dependency.
