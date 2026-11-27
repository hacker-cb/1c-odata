---
'@1c-odata/client': patch
---

An `Edm.Int64` value that is no decimal integer fails a read with a `ParseError` under `int64Mode: 'bigint'`, not a bare `SyntaxError` from `BigInt` (#276).

`BigInt('12x')` threw a native `SyntaxError` that went past every `ODataError` / `ParseError` handler, while `''` and `' 0x1f '` read silently as `0n` and `31n`. The wire value must now match `-?\d+` — what 1С sends — and anything else is a `ParseError` naming the field and the value (`Edm.Int64 field LineNumber: expected an integer string, got string "12x"`).
