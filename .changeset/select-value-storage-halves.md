---
'@1c-odata/client': patch
---

`select()` of a ValueStorage field brings its value (#286). Codegen declares a storage as the one field `<X>` (`ValueStorage | null`), so a typed `.select('ФайлХранилище')` sent `$select=ФайлХранилище` — a name 1С returns nothing for: it answers only `<X>_Base64Data` and `<X>_Type`, and the field read `undefined`.

With a `metadataIndex`, a query (`get()`, `stream()`, `count()`, `raw()`) writes a storage's base named in `select` as its two halves (`ФайлХранилище_Base64Data,ФайлХранилище_Type`) — the row's, or one an `$expand` path reaches through `EntitySchema.navigation` (`Владелец/Файл` → `Владелец/Файл_Base64Data,Владелец/Файл_Type`); the reply comes in `minimalmetadata` (#289) and the parser groups the halves back into `<X>`. A half already named is not named twice; an entry holding several names (`'Ref_Key,ФайлХранилище'`) is read as 1С reads it. Without an index, or for a set it does not list, the names go as given.
