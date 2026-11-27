---
'@1c-odata/client': patch
'@1c-odata/metadata': patch
---

A key named `__proto__` — in a response body, a write payload or an EDMX — is an own field of the object it belongs to, never its prototype (#275).

The parser copied each field of a row into `{}` by assignment, so a body like `{"value":[{"__proto__":{"x":1},"a":2}]}` gave a row with the keys `['a']` whose `row.x` was `1`; nested objects and tabular rows did the same, and so did the write transform on a payload carrying such a field. `buildMetadataIndex` wrote type, property and entity-set names the same way, so an EDMX type named `__proto__` replaced the prototype of `schemas` and left `entitySetToType` naming a type `parseMetadataIndex` then refused, failing the whole index.

Such a key is now defined as an ordinary own field. Rows, payloads, `schemas`, `entitySetToType` and each type's `properties` keep their plain `Object` prototype — `row.hasOwnProperty` works as before — and the field serializes back as it came (`enums` stays the null-prototype dictionary it was). Nothing changes for 1С, which sends no such names: `__metadata.json` of a real base is byte-for-byte the same.

`validateOnWrite` (`validateEntity`) counts a property whose name `Object.prototype` carries (`__proto__`, `constructor`, …) only as the payload's own field: a non-nullable one the payload lacked read `Object.prototype` / `Object` and passed its `required` check. Every other name reads as before.

`buildMetadataIndex` lists in `entitySetToType` only the sets whose type `schemas` holds. An EntitySet whose type lies in another namespace or is missing from the EDMX was listed under a type no schema stands for, and `parseMetadataIndex` refuses such an index whole — a `__metadata.json` codegen emitted for that EDMX would not load. Such a set reads and writes schema-less either way; 1С's EDMX has none, so the index of a real base does not change.
