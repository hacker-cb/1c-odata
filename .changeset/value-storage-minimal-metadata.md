---
'@1c-odata/client': minor
---

A ValueStorage field read from 1С arrives as `{ contentType, base64Data }` (or `null`), as its type says (#289). The client reads every reply as `application/json;odata=nometadata`, and in that format 1С sends a storage's `<X>_Base64Data` but withholds its `<X>_Type` — even in a whole row — so the parser never had the pair to group: `<X>` read `undefined` on every real base (and up to v0.12.0 the half was dropped too).

With a `metadataIndex`, a read whose reply carries a storage now asks for `application/json;odata=minimalmetadata` instead — in `$format` and `Accept` alike — which brings `_Type`:

- a query (`get()`, `stream()`) of a type with `valueStorages` whose `$select` is empty, holds `*` / `**`, or names a storage's base or one of its halves;
- a query whose `$expand` reaches such a type (through `EntitySchema.navigation`; `*` reaches every navigation of its level) with the `$select` keeping that entity whole — empty, a root `*` / `**`, the path or an ancestor named bare or with `/*` / `/**` — or naming a storage of it;
- `entity(…).get()` of such a type, and the entity its `create()` / `patch()` / `put()` return — there the format is library-managed, as `Content-Type` is: a `withHeader('Accept', …)` does not override it.

Where it is unclear whether 1С sends a storage, the heavier format is asked for.

Every other read — no index, a type without storages, a `$select` without them, register virtual tables, `raw()` — stays `nometadata`, its request byte-for-byte as before. The parser drops the `<Nav>@navigationLinkUrl` annotations `minimalmetadata` adds (one per navigation property of a row, an expanded entity's included), and the root `odata.metadata` as it already did, so a row reads the same in either format. 1С sends no such annotation in `nometadata` — not even beside an empty expanded reference — so a `nometadata` row from 1С is unchanged; another server's would lose them.

**Cost:** a read of a type with storages is heavier on the wire — measured on live УТ 11.5 / БП 3.0 at +5 % to +45 %, the navigation links accounting for most of it. A `$select` that leaves storages out keeps the lighter format.

**Migration:** none in code. A row of such a type no longer carries `<X>_Base64Data` as a plain field where it did; read `<X>.base64Data`. Without an index nothing changes: the halves stay flat, `_Base64Data` alone.
