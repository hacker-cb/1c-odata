---
'@1c-odata/client': minor
'@1c-odata/metadata': minor
---

An entity an `$expand` brings is parsed with the schema of its own type, as the row is (#283). The index held no navigation properties, so the parser found no type for an expanded field and read the entity schema-less: under the default `int64Mode: 'number'` an `Edm.Int64` stayed the wire string (`"5"`, where codegen types the field `number`), a malformed one (`"12x"`) passed unchecked, `Edm.DateTime` went by the string heuristic alone, and a ValueStorage pair stayed flat.

`buildMetadataIndex` (so `fetchMetadataIndex`, `createDynamicClient` and codegen's `__metadata.json`) now records each EntityType's navigation properties in a new optional field, `EntitySchema.navigation` — `{ [name]: { type, collection? } }`, `type` being the target's local name and `collection: true` only for a to-many end, which 1С never declares. Only a navigation whose target the index holds is written; the key goes after `valueStorages`, the rest of `__metadata.json` stays byte-for-byte as it was (+7–11 % in size for a full base). `parseMetadataIndex` / `loadMetadataIndex` refuse a malformed `navigation` with `MetadataError`; one naming a type the index lacks reads that expanded value schema-less instead of failing the index. `NavigationSchema` is exported as a type.

The parser resolves an expanded field through it: an expanded entity, and each entity of an expanded collection, reads with its target's schema, exactly as a row does — `Edm.Int64` converted per `int64Mode` and, in `'number'` / `'bigint'`, refused when it is no 64-bit integer; `Edm.DateTime` converted by the schema and, in `dateMode: 'date'`, refused when it names no real date-time; an `Edm.String` that looks like a date left a string; ValueStorage grouped. The `'string'` modes pass values through untouched, as they do for the row.

**Migration:** regenerate `__metadata.json` (`1c-odata generate`) or refetch a cached index to get the new behaviour — an index without `navigation` still loads and reads expanded entities schema-less, as before. With a new index, code that read an expanded `Edm.Int64` as a string gets a `number` (or `bigint`) now, and a reply whose expanded entity breaks its schema is a `ParseError`.
