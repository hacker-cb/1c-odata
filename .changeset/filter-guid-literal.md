---
'@1c-odata/client': minor
---

The filter DSL writes a GUID string compared with a GUID field as `guid'…'`, as 1С needs it (#228). It used to write `Ref_Key eq '8af68945-…'`, which 1С answers with no rows — silently — and, for an `Edm.Guid` attribute such as `Идентификатор`, with an error. A field counts as a GUID field by the client's `MetadataIndex` (`Edm.Guid`, tabular rows inside `any()` / `all()` included); without one, or for a field it does not list, by the 1С reference name `*_Key`. Fields typed `Edm.String` — `Recorder` among them — keep the quoted form.

**Changes in what is sent or thrown:**

- `f.Ref_Key.eq(id)` (and `ne` / `gt` / `ge` / `lt` / `le`) now sends `Ref_Key eq guid'…'` instead of `Ref_Key eq '…'`. Code comparing `toFilterString()` output with a fixed string needs updating.
- A string that is not a GUID (8-4-4-4-12 hex) compared with such a field is now an `InvalidArgumentError` naming the field, rather than a filter 1С matches nothing with.

**New:** `guid(value)` in `@1c-odata/client/filter` — a GUID literal for the GUID fields the DSL cannot tell by itself: an `Edm.Guid` attribute queried without a schema (`f.Идентификатор.eq(guid(id))`), or a `cast()` result. It throws `InvalidArgumentError` for a value that is not a GUID.
