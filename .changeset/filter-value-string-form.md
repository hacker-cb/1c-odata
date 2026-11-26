---
"@1c-odata/client": patch
---

A filter value written as a string literal whose string conversion fails — an object with no prototype, or one whose `toString` is not a function — is now an `InvalidArgumentError` naming the field, with the conversion's `TypeError` as its `cause`, instead of escaping as a bare `TypeError`.
