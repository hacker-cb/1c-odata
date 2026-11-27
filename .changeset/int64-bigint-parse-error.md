---
'@1c-odata/client': patch
---

An `Edm.Int64` value that is no 64-bit integer fails a read with a `ParseError` under `int64Mode: 'bigint'`, not a bare `SyntaxError` from `BigInt` (#276).

`BigInt('12x')` threw a native `SyntaxError` that went past every `ODataError` / `ParseError` handler; `''` and `' 0x1f '` read silently as `0n` and `31n`, a value past the signed 64-bit range as a `bigint` no `Edm.Int64` holds, and a JSON number reached the `bigint`-typed field as a `number`, a fraction included. The wire value must now be `null`, a string matching `-?\d+` within `-2^63 … 2^63-1` — what 1С sends — or a JSON number that is a safe integer, which converts to a `bigint` like the string would. Anything else is a `ParseError` naming the field and the value (`Edm.Int64 field LineNumber: expected a 64-bit integer string, a safe integer or null, got string "12x"`).

The check runs wherever an entity is parsed, the entity a `create()` / `patch()` / `put()` gets back included.

**Migration:** none for a response from 1С. Code that caught `SyntaxError` around a read catches `ParseError` instead; code that read padded or hexadecimal values through it reads the field with `int64Mode: 'string'` and converts it itself.
