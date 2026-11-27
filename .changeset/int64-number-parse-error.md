---
'@1c-odata/client': minor
---

An `Edm.Int64` value that is no decimal integer fails a read with a `ParseError` under the default `int64Mode: 'number'` too, where it read silently as whatever `Number` made of it — `12x` → `NaN`, `1.5` → `1.5`, `0x1f` → `31`, `''` → `0` (#276).

The check is the one `'bigint'` now applies: the wire value must match `-?\d+`, and anything else is a `ParseError` naming the field and the value. `int64Mode: 'string'` passes the wire value through untouched, as before. 1С sends `Edm.Int64` as a decimal integer string, so nothing changes for a response from 1С itself.

**Migration:** none, unless code relied on reading such a value as `NaN` or a fraction — catch `ParseError` there, or read the field with `int64Mode: 'string'`.
