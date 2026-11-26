---
"@1c-odata/client": patch
---

A filter value that cannot be read as a literal — an object with no prototype, one whose `toString` is not a function, a revoked `Proxy` — is now an `InvalidArgumentError` naming the field, with the underlying failure as its `cause`, instead of escaping as a bare `TypeError`.
