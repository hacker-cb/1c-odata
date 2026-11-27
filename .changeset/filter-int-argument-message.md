---
'@1c-odata/client': patch
---

An integer argument of a filter DSL function (`substring`'s start and length, `dateadd`'s amount) that untyped code passes as an object whose `toString` is not callable — `{ toString: null }` — is refused with the `InvalidArgumentError` it was meant to get, not a `TypeError` raised while writing that error's message. The message shows a string argument quoted and a non-primitive by its type (`received an object`).
