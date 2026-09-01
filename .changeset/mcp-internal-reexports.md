---
"@1c-odata/mcp": patch
---

`@1c-odata/mcp/internal` re-exports for alternate hosts:

- `assertValidConnectionName` / `isValidConnectionName`, so a DB-backed admin
  write path enforces the same ASCII connection-name rule as the file-backed
  store.
- `InvalidArgumentError` (from `@1c-odata/client`), so a scoping wrapper throws
  the pool's canonical not-found error without a new dependency — an ungranted
  base is then byte-identical to a missing one.
