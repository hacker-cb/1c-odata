---
'@1c-odata/client': patch
---

`validateOnWrite: true` no longer refuses a write for a field it leaves out (#295). 1С fills a field a write omits itself — `Ref_Key`, `Code` / `Number`, `DataVersion`, dates… — and a `patch()` keeps what the server holds, so `Nullable="false"` in its EDMX does not make a field mandatory on write. Yet every non-nullable field the body lacked was a `required` issue: `entity(set, key).patch({ Code: 'Y' })` failed on all the others, and `create()` without an explicit `Ref_Key` failed too — the request never left.

Now, for `create()`, `patch()` and `put()` alike:

- a field the body leaves out is no issue;
- a `null` in a non-nullable `Edm.DateTime` is none either — the write sends it as the empty date of 1С, the usual way to clear one — except under `shape: { dateMode: 'string' }`, where it goes as `null` and is refused;
- a `null` in any other non-nullable field, or a string past `maxLength`, is refused as before;
- what is checked is what is sent: a body's `toJSON()` result where it has one, its own enumerable fields.
