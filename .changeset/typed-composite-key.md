---
"@1c-odata/client": minor
---

A composite entity key takes typed values: `EntityKey` is now `string | Record<string, string | number | bigint | Date>`, and each value is written by its JS type, as the 1С docs show it — a `number` or `bigint` bare (`LineNumber=1`), a `Date` as `datetime'…'` in the connection's `serverTimezone` (`Period=datetime'2025-01-01T00:00:00'`), a string as before (a GUID → `guid'…'`, anything else a quoted literal, which 1С converts to the field's type). A row read back keys itself: `client.entity('InformationRegister_КурсыВалют', { Period: row.Period, Валюта_Key: row.Валюта_Key })` — a `Date` key used to be an `InvalidArgumentError`. A `number` value, which untyped callers could already pass, now goes out bare (`LineNumber=1`) instead of quoted (`LineNumber='1'`); 1С accepts both. An invalid `Date`, a non-finite number, or a value of another type is an `InvalidArgumentError`.
