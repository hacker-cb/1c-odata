---
'@1c-odata/client': patch
---

An `Edm.Int64` value that is no 64-bit integer string fails a read with a `ParseError` under `int64Mode: 'bigint'`, not a bare `SyntaxError` from `BigInt` (#276).

`BigInt('12x')` threw a native `SyntaxError` that went past every `ODataError` / `ParseError` handler; `''` and `' 0x1f '` read silently as `0n` and `31n`, a value past the signed 64-bit range as a `bigint` no `Edm.Int64` holds, and a JSON number (`1.5`) reached the `bigint`-typed field as-is. The wire value must now be `null` or match `-?\d+` within `-2^63 … 2^63-1` — what 1С sends — and anything else is a `ParseError` naming the field and the value (`Edm.Int64 field LineNumber: expected a 64-bit integer string or null, got string "12x"`).

**Migration:** none for a response from 1С. Code that caught `SyntaxError` around a read catches `ParseError` instead; code that read padded or hexadecimal values through it reads the field with `int64Mode: 'string'` and converts it itself.
