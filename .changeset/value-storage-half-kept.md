---
'@1c-odata/client': patch
---

A ValueStorage half that a response carries without its pair stays in the row as the field it came as (#284). The parser grouped `<X>_Base64Data` + `<X>_Type` into `<X>` only when both were strings (or into `null` when one was `null`), yet removed both halves every time — so an untyped `client.query('Catalog_X').select('Файл_Base64Data')` with a loaded metadata index returned a row with neither `Файл` nor `Файл_Base64Data`: the bytes asked for were gone.

The halves are now grouped only as a pair: both present, both strings → `{ contentType, base64Data }`; both present, one `null` → `null`. A half sent alone — or a pair of values neither form fits — is left as it came.

This reaches whole-entity reads too: the client asks 1С for `odata=nometadata` JSON, in which 1С sends a ValueStorage's `<X>_Base64Data` but not its `<X>_Type`. Up to v0.12.0 every such row lost both halves silently — the stored bytes never reached the caller; it now carries `<X>_Base64Data` as a plain field, and `<X>` is not set. Grouping a whole row into `<X>` needs the `_Type` 1С withholds there — #289.
