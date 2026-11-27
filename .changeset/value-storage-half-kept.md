---
'@1c-odata/client': patch
---

A ValueStorage half a response carries without its pair stays in the row as the field it came as (#284). The parser grouped `<X>_Base64Data` + `<X>_Type` into `<X>` only when both were strings (or into `null` when one was `null`), yet removed both halves every time — so an untyped `client.query('Catalog_X').select('Файл_Base64Data')` with a loaded metadata index returned a row with neither `Файл` nor `Файл_Base64Data`: the bytes asked for were gone.

The halves are now grouped only as a pair: both present, both strings → `{ contentType, base64Data }`; both present, one `null` → `null`. A half sent alone — or a pair of values neither form fits — is left as it came. A row from 1С carries both halves unless `$select` named only one of them, so a read of a whole entity reads as before.
