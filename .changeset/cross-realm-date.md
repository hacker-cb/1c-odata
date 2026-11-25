---
"@1c-odata/client": patch
---

A `Date` from another JS realm — created in a `node:vm` context, a sandbox or a plugin host — is now written, and so are the dates inside plain objects and arrays built there, in the connection's `serverTimezone` everywhere, as a `Date` of the client's own realm is. Before, writes (`create` / `patch` / `put`, with or without a schema) sent it through `JSON.stringify` as UTC ISO with `Z` instead of naive server time, and `$filter` literals and function-import arguments wrote it as `String(date)` — the date silently shifted by the zone offset or was rejected by 1С. A register turnovers-style `Period` given such a `Date` as a point is now rejected like any other point `Date`, instead of silently querying all periods. The filter DSL, function-import arguments and composite keys now share one literal formatter for numbers, booleans, `bigint`s and dates (a composite key still writes a GUID-shaped string as `guid'…'`).
