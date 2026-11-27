---
'@1c-odata/client': patch
---

A single-entity response whose body is a JSON array — `entity(…).get()`, the entity `create()` / `patch()` / `put()` get back, the read behind `expectVersion` — is a `ParseError` ("Expected object at root"), where `[]` read as an entity with no fields and `[{…}]` as one keyed `"0"`. 1С answers with an object, so nothing changes for a response from 1С itself; a proxy or a misrouted request answering `200` with an array no longer passes as an entity.
