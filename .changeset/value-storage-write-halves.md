---
'@1c-odata/client': patch
---

A ValueStorage read back and written again reaches 1С (#293). Since #289 a storage reads as `{ contentType, base64Data }` (or `null`); writing that row back through `create()` / `patch()` / `put()` with a `metadataIndex` failed three ways:

- under `shape: { dateMode: 'string' }` the write body went out untouched, the grouped `<X>` object included — 1С edits a storage only through `<X>_Base64Data`. The storage is now split into its halves in every `dateMode`: that is no date, and dates still pass through untouched in `'string'`;
- `<X>: null` went out as is. It is now `<X>_Base64Data: null`, `<X>_Type` left out — 1С's docs name `_Base64Data` as the one property a storage is edited through and give no other form for clearing;
- a row read back, with new bytes written into `<X>_Base64Data` and the read `<X>` still beside them, had the new half overwritten by the stale grouped value — the write "succeeded" and the file did not change. A half the payload names itself now wins, and `<X>` is dropped.

This holds for a storage of a tabular part's row too (#290). Without an index nothing changes: there is no grouped form to split.
