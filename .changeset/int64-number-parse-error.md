---
'@1c-odata/client': minor
---

An `Edm.Int64` value that is no 64-bit integer string fails a read with a `ParseError` under the default `int64Mode: 'number'` too, where it read silently as whatever `Number` made of it — `12x` → `NaN`, `1.5` → `1.5`, `0x1f` → `31`, `''` → `0` — and a JSON number passed through as-is (#276).

The check is the one `'bigint'` now applies: the wire value must be `null` or match `-?\d+` within the signed 64-bit range, and anything else is a `ParseError` naming the field and the value. `-0` reads as `0`. `int64Mode: 'string'` passes the wire value through untouched, as before. 1С sends `Edm.Int64` as a decimal integer string, so nothing changes for a response from 1С itself.

The check runs wherever an entity is parsed — a read, and the entity `create()` / `patch()` / `put()` gets back: there such a value is a `ParseError` after the server has written, as a malformed `Edm.DateTime` already was.

**Migration:** none for a response from 1С. Code that read any other value through an `Edm.Int64` field — `NaN`, a fraction, `0` for an empty string, a hexadecimal one — gets a `ParseError` there now: catch it, or read the field with `int64Mode: 'string'` and convert it itself. A write that fails this way has reached the server: do not retry a `create()` on it blindly.
