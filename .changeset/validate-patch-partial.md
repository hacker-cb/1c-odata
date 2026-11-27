---
'@1c-odata/client': patch
---

With `validateOnWrite: true`, `patch()` checks only the fields its body carries (#295). A partial update was validated as a whole entity, so `entity(set, key).patch({ Code: 'Y' })` failed with a `ValidationError` on every other non-nullable field of the type (`Ref_Key`, `Description`, … — an entity of 1С has many) and never reached the server.

`patch()` now leaves a field its body does not carry unchecked — the server keeps its value; a field it carries is checked as before: `null` where the schema says `nullable: false` is a `required` issue, a string past `maxLength` a `maxLength` one. `create()` and `put()` still check the whole entity.

`validateEntity` takes the same as an option — `validateEntity(entity, schema, { partial: true })`; the `ValidateEntityOptions` type is exported.
