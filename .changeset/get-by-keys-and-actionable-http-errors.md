---
"@1c-odata/client": minor
---

Add batched lookup-by-key (`getByKeys` / `whereIn`) and make non-OData error responses actionable.

Both motivated by a recurring live failure: resolving ~24 analytics keys to names built a `Ref_Key eq guid'…' or …` filter plus a multi-field nested `$select`, pushing the query string past IIS `maxQueryString` (default 2048 bytes). IIS then returns an **HTML 404 page**, and the old error mapping surfaced only an opaque `Unrecognized error content-type "text/html…" (status 404)`. Confirmed live against УТ 11.1: a 24-GUID filter + 5-field nested select produced a 2229-byte query string → HTML 404.

**`V3QueryBuilder.getByKeys(field, values[], opts?)`** — fetch many records by a key field without hand-building giant `or` chains or tripping the URL limit. Splits `values` into batches sized to keep each query string under `queryBudget` (default 1500 bytes, headroom below 2048), issues them with bounded concurrency (default 4), and concatenates each batch's `.value`. `$select` / `$expand` / `$orderby` and any prior `.filter(...)` are applied to every batch. Duplicate keys are de-duplicated (first occurrence wins); missing keys are simply absent; result order follows batch order then server order (set `.orderBy()` if you need a guarantee). `opts.batchSize` forces a fixed cap instead of estimation. `batchSize` / `queryBudget` / `concurrency` are validated as positive integers; if the fixed query parts (a very large `$select`/`$expand`/`$filter`) leave too little room for even one key, it throws an actionable `InvalidArgumentError` rather than silently shipping an over-limit URL.

**`QueryBuilder.whereIn(field, values[])`** — filter sugar that builds a GUID-aware `field eq v1 or field eq v2 or …` chain (so `Ref_Key` and other reference fields no longer need `raw("… eq guid'…'")`), AND-combined with any existing filter. Builds a single request and does NOT chunk — use `getByKeys` for large lists.

1С OData V3 has **no usable `in` operator** (a `$filter=Ref_Key in (…)` probe returns HTTP 400, code 14 «Ошибка при разборе опции запроса $filter»), so both helpers emit chunked `eq … or …` filters.

**Actionable HTTP errors (behavior change).** A non-OData error body (e.g. an IIS HTML error page) now maps to a status-bearing `HTTPError` with `errorFormat: 'none'` and a message that keeps the status + content-type and points at the likely cause (`HTTP 404 …: server returned a non-OData text/html body … reduce the $filter (fewer OR terms), trim $select/$expand, or lower the page size …`). Previously this produced a `ParseError` that dropped the status. Callers can now branch on `.status` (e.g. 404/414). `ErrorFormat` gains a `'none'` member. JSON/XML error bodies are unchanged; a JSON body that is invalid or missing the `odata.error` wrapper still throws `ParseError`.
