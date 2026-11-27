---
'@1c-odata/client': minor
---

`validateEntity` takes an optional third argument, `ValidateEntityOptions` (exported as a type): `missing: 'required' | 'ignore'` — whether a non-nullable field the payload does not carry is an issue (`'required'`, the default, as before) or not; `dateMode: 'date' | 'string'` — under `'date'` a `null` in a non-nullable `Edm.DateTime` is no issue, as the write path sends it as the empty date of 1С. Without options it checks a payload as a whole entity, exactly as before. `validateOnWrite` checks `create()` / `patch()` with `{ missing: 'ignore', dateMode }` and `put()` with `{ missing: 'required', dateMode }` (#295).
