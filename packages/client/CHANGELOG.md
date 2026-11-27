# @1c-odata/client

## 0.12.0

### Minor Changes

- [#262](https://github.com/hacker-cb/1c-odata/pull/262) [`b941e19`](https://github.com/hacker-cb/1c-odata/commit/b941e19ad30478fa98642a609b5d20692e6dc175) Thanks [@hacker-cb](https://github.com/hacker-cb)! - A collection response without a `value` array is a `ParseError`, not an empty result ([#255](https://github.com/hacker-cb/1c-odata/issues/255)).

  `query().get()` / `stream()`, the register virtual tables (`balance()`, `turnovers()`, `sliceLast()`, …) and read functions through `client.functions` read a 200 body with no `value` array — a gateway's `{"error": …}`, a truncated or foreign body — as "no rows". They now fail with a `ParseError` naming what came instead: the first keys of the body (`got no "value" — keys "error"`), or the kind of `value` it held — never the body's values. A row of `value` that is not an object (`null`, a number) is a `ParseError` too, where `null` failed with a `TypeError` and a number read as an empty row.

  1С sends every collection with `value`, an empty one as `"value": []` (checked on entity sets and on every register virtual table of both test bases), so nothing changes for a response from 1С itself.

  **Migration:** none, unless code relied on such a body reading as empty — catch `ParseError` there.

- [#260](https://github.com/hacker-cb/1c-odata/pull/260) [`b80c9e8`](https://github.com/hacker-cb/1c-odata/commit/b80c9e85a963feca8bbd7d26c8580b10efbb59cd) Thanks [@hacker-cb](https://github.com/hacker-cb)! - A metadata index whose entity set names a type it does not hold is refused at load, and no lookup reads an inherited key as a schema ([#258](https://github.com/hacker-cb/1c-odata/issues/258)).

  - **`parseMetadataIndex` / `loadMetadataIndex` throw a `MetadataError`** for an `entitySetToType` entry whose type is not an own key of `schemas` — `Invalid metadata at <source> $.entitySetToType.<Set>: type "<Type>" is not in $.schemas`. It used to load, and a type named after an inherited key (`constructor`, `toString`) then failed every read of that set with a `TypeError` on the first field of the first row. An index built by `buildMetadataIndex` / `fetchMetadataIndex` or emitted by `1c-odata generate` never holds such an entry: only a hand-edited or damaged cache does.

    **Migration:** none for a generated or fetched index. A cache that now fails to load is damaged — fetch or generate it again.

  - **Every schema lookup takes own keys only** — reads (`get()`, `stream()`, entity reads, nested tabular parts and complex values), writes (`validateOnWrite`, the `Date` → wire transform, nested values included) and the filter DSL. A set or a type the index does not hold — an inherited name among them — reads and writes schema-less, as without an index, where an index passed straight to the client (not through `parseMetadataIndex`) used to fail with a `TypeError`. On write that includes a nested tabular part or complex value whose type the index does not hold: its `Date`s are written in the server's zone, found by value, where they used to go out as they were (`toJSON()`, UTC).

### Patch Changes

- [#260](https://github.com/hacker-cb/1c-odata/pull/260) [`b80c9e8`](https://github.com/hacker-cb/1c-odata/commit/b80c9e85a963feca8bbd7d26c8580b10efbb59cd) Thanks [@hacker-cb](https://github.com/hacker-cb)! - An integer argument of a filter DSL function (`substring`'s start and length, `dateadd`'s amount) that untyped code passes as an object whose `toString` is not callable — `{ toString: null }` — is refused with the `InvalidArgumentError` it was meant to get, not a `TypeError` raised while writing that error's message. The message shows a string argument quoted and a non-primitive by its type (`received an object`).

- [#262](https://github.com/hacker-cb/1c-odata/pull/262) [`b941e19`](https://github.com/hacker-cb/1c-odata/commit/b941e19ad30478fa98642a609b5d20692e6dc175) Thanks [@hacker-cb](https://github.com/hacker-cb)! - A malformed `odata.count` that is a JSON object carrying a `"toString"` key is refused with the `ParseError` it was meant to get, not a `TypeError` raised while writing that error's message. The message now names the value's kind (`got: an object`, `got: number -1`) where it showed `String(value)`.

## 0.11.1

### Patch Changes

- [#263](https://github.com/hacker-cb/1c-odata/pull/263) [`687d1b4`](https://github.com/hacker-cb/1c-odata/commit/687d1b46b1a6e576ab0d6c8a81c57768cd4b833c) Thanks [@hacker-cb](https://github.com/hacker-cb)! - The request a `beforeRequest` hook leaves is now read once, right after the hook — `method`, `url`, `headers` (each header, and the string it converts to) and `body` — and the transport reads nothing else after it: the fetch is sent with that reading, and an error reports it in `request`. A getter on the event, or on one of its headers, is read once, and one that throws — or a header value whose conversion to a string throws — is the hook's own error: the call ends with it unchanged and is not retried. Before, the event was read again later, partly outside the hook's error handling:

  - a `url` getter, read at the fetch, turned its error into a `NetworkError`, and a `GET` under a retry policy was sent again — `beforeRequest` called anew; a header getter, or a header value whose conversion throws, did the same;
  - a getter throwing when the error was being built replaced a `TimeoutError`, `NetworkError` or `HTTPError` with its own error, and `onError` was not called;
  - a frozen event whose fields are getters on its prototype (a class instance) was sent without its headers, and later hooks got a copy whose `method`, `url` and `headers` were `undefined`;
  - an event whose `signal` setter ignores the write left `afterResponse` and `onError` with the event's own signal instead of the request's;
  - an `afterResponse` that left the event's `signal` getter throwing failed the call before `onError`.

  `afterResponse` and `onError` are still handed the event itself — the one `beforeRequest` returned keeps its identity. Only an event that will not take the request signal (frozen, or a setter that ignores the write) is replaced by a copy: its own fields kept as they are defined (a getter copied, not called), and `method`, `url`, `headers` and `body` the request's as they were read, the headers a copy of their own.

## 0.11.0

### Minor Changes

- [#249](https://github.com/hacker-cb/1c-odata/pull/249) [`aa0b7c9`](https://github.com/hacker-cb/1c-odata/commit/aa0b7c94ec502e24dd20c2d513385cd953c2fdae) Thanks [@hacker-cb](https://github.com/hacker-cb)! - `filter()` refuses a callback result that is not a filter expression with an `InvalidArgumentError`, and leaves a filter set before as it was. Untyped code returning `undefined` (`.filter((f) => build?.(f))` with `build` missing) used to clear the query's filter — the request then went out over the whole entity set, silently; `null`, a string or an object without `_expr` text are refused too, and so is a `guid()` literal (a value, not a condition). The combinators `and` / `or` / `not` / `any` / `all` refuse such an operand with the same error instead of a `TypeError`, and read an operand's text once. Typed code is unaffected: the callback is typed `(f) => FilterExpression`, and any filter expression — a copy of one included — is taken as before.

  **Migration:** to query without a filter, build the query without `.filter()` rather than returning `undefined` from its callback.

- [#251](https://github.com/hacker-cb/1c-odata/pull/251) [`815c221`](https://github.com/hacker-cb/1c-odata/commit/815c221cbf3e596039bb5c7a595c365bc8656a8d) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Filter DSL types: nullable fields get their operators, and `bigint` fields are typed as `bigint` ([#230](https://github.com/hacker-cb/1c-odata/issues/230)).

  - **A nullable field has the operators of its type.** `FieldExprFor` distributed over the field's union with `null`, so a generated `Сумма?: number | null` had no `gt` / `add` / …, a `Дата?: Date | null` no `year()`, a `Комментарий?: string | null` no `startsWith` — `strictNullChecks` code needed a cast. The surface is now read off the non-null type as a whole. A nullable field is an operand too (`f.Количество.gt(f.Сумма)`, `f.Дата.lt(f.ДатаОкончания)`), and arithmetic on it keeps its `null` (`f.Сумма.add(1)` is a `number | null` expression, so `.eq(null)` compiles).
  - **Numeric fields are one family.** An `Edm.Int64` read as `bigint` (`int64Mode: 'bigint'`): comparisons and arithmetic take `number` or `bigint` operands, and `add` / `sub` / `mul` / `div` / `round` return a `bigint` expression (they were typed for `number`). A `number` field takes a `bigint` or a `bigint` expression as well, and a field typed `number | bigint` keeps its operators. `f.Int64.gt(5)` and `f.Int64.add(1).eq(5)` compile as before.
  - **`any()` / `all()` take a nullable or optional tabular part** (`Товары?: Row[] | null`, as codegen emits it), which they refused in their types; a field holding no array at all is still refused.

  Nothing changes in what is sent.

  **Migration:** code that annotated a `bigint` field's arithmetic as `ChainedFieldExpr<number>` needs `ChainedFieldExpr<bigint>` (or no annotation).

- [#241](https://github.com/hacker-cb/1c-odata/pull/241) [`e629dcc`](https://github.com/hacker-cb/1c-odata/commit/e629dccc502d43baf73d40ddaa2cb67726f9b24f) Thanks [@hacker-cb](https://github.com/hacker-cb)! - The filter DSL writes a GUID string compared with a GUID field as `guid'…'`, as 1С needs it ([#228](https://github.com/hacker-cb/1c-odata/issues/228)). It used to write `Ref_Key eq '8af68945-…'`, which 1С answers with no rows — silently — and, for an `Edm.Guid` attribute such as `Идентификатор`, with an error. A field counts as a GUID field by the client's `MetadataIndex` (`Edm.Guid`, tabular rows inside `any()` / `all()` included); without one, or for a field it does not list (a navigation path, a virtual table), by the 1С reference name `*_Key`. Fields typed `Edm.String` — `Recorder` among them — keep the quoted form.

  **Changes in what is sent or thrown:**

  - `f.Ref_Key.eq(id)` (and `ne` / `gt` / `ge` / `lt` / `le`) now sends `Ref_Key eq guid'…'` instead of `Ref_Key eq '…'`. Code comparing `toFilterString()` output with a fixed string needs updating.
  - A string that is not a GUID (8-4-4-4-12 hex) compared with such a field is now an `InvalidArgumentError` naming the field, rather than a filter 1С matches nothing with.

  **New:** `guid(value)` in `@1c-odata/client/filter` — a GUID literal for the GUID fields the DSL cannot tell by itself: an `Edm.Guid` attribute queried without a schema (`f.Идентификатор.eq(guid(id))`), through a navigation path or on a virtual table. It throws `InvalidArgumentError` for a value that is not a GUID; the literal is for comparisons only — as a function or arithmetic operand, or against a field the schema types other than `Edm.Guid`, it is an `InvalidArgumentError` too.

- [#246](https://github.com/hacker-cb/1c-odata/pull/246) [`f79571c`](https://github.com/hacker-cb/1c-odata/commit/f79571c6aca37e8bc3f03c3d71545c9f87dadd61) Thanks [@hacker-cb](https://github.com/hacker-cb)! - The filter DSL refuses `undefined` as a value ([#229](https://github.com/hacker-cb/1c-odata/issues/229)), and the query builder sends no empty `$select` / `$expand` ([#237](https://github.com/hacker-cb/1c-odata/issues/237)).

  - **`undefined` in a value slot is now an `InvalidArgumentError`** naming the field (`argument`, the row path inside `any()` / `all()`), and so is a function or a symbol (a method passed uncalled). It used to be written as a string — `f.X.eq(undefined)` sent `X eq 'undefined'`, `f.Сумма.add(undefined)` sent `(Сумма add 'undefined')` — a filter 1С rejects or silently matches nothing with.

    **Migration:** where a value may be missing (a field left out of `$select`), check it before the filter, or pass `null` explicitly to compare with a null field. The types are unchanged: a value present in the row works as before.

  - **`select()` with no fields (or blank names only), or `expand()` while nothing is expanded, sends no `$select` / `$expand`** — in `get()`, `raw()`, `stream()` and `count()`; blank names beside real ones are dropped. It used to send `$select=` / `$expand=`, which 1С reads as absent (checked live: 200 with every property), so what comes back is unchanged — only the URL loses the empty option.

### Patch Changes

- [#245](https://github.com/hacker-cb/1c-odata/pull/245) [`46a34c1`](https://github.com/hacker-cb/1c-odata/commit/46a34c1a9235262a03ddf957950cab88fa6732ae) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Documentation: `RequestEvent.signal` and `RequestHooks` now spell out what `req.signal` ends. It aborts only when its attempt is cut short — the timeout, the call's signal (yours, or the one a register read with `count: true` adds), a hook's own error — and not on a response, an error from 1С or the network by itself, or a retry replacing the attempt. Work a hook starts without awaiting it can outlive the call; the docs say how to bound it. No behaviour change.

- [#242](https://github.com/hacker-cb/1c-odata/pull/242) [`f3d172d`](https://github.com/hacker-cb/1c-odata/commit/f3d172d131178aa0515f53eb943debe43ee14b71) Thanks [@hacker-cb](https://github.com/hacker-cb)! - A `timeout` above `2³¹ − 1` ms (about 24.8 days), `Infinity` included, no longer fails the call with a `TimeoutError` almost at once: it is capped at that limit, the longest delay a Node timer keeps, as the retry pause already was. `TimeoutError.timeoutMs` reports the capped value. `0`, a negative value and `NaN` still disable the timeout.

- [#242](https://github.com/hacker-cb/1c-odata/pull/242) [`f3d172d`](https://github.com/hacker-cb/1c-odata/commit/f3d172d131178aa0515f53eb943debe43ee14b71) Thanks [@hacker-cb](https://github.com/hacker-cb)! - An event returned by `beforeRequest` whose `method`, `headers` or `body` getter throws now ends the call as the hook's own error: the timeout's timer is cleared and `req.signal` aborted with that error, and the call is not retried. Before, the timer was left running.

- [#242](https://github.com/hacker-cb/1c-odata/pull/242) [`f3d172d`](https://github.com/hacker-cb/1c-odata/commit/f3d172d131178aa0515f53eb943debe43ee14b71) Thanks [@hacker-cb](https://github.com/hacker-cb)! - `RetryPolicy.maxDelayMs` now caps the first pause between attempts too: an `initialDelayMs` above it went uncapped into the first pause (in full with `jitter: 'none'`, a random share of it with `'full'`).

## 0.10.0

### Minor Changes

- [#227](https://github.com/hacker-cb/1c-odata/pull/227) [`7107749`](https://github.com/hacker-cb/1c-odata/commit/71077490251dd188f72fde6e28be5be50a69d6dc) Thanks [@hacker-cb](https://github.com/hacker-cb)! - **Breaking:** on a timeout the call no longer waits for `onError`. The hook is still called with the `TimeoutError`, but the call fails at once; what the hook throws or rejects with afterwards is dropped (handled, never an unhandled rejection). Before, the wait for `onError` was unbounded on the timeout path and on a network failure — where the timer was cleared before it — so an `onError` writing to the same hung service kept the call from ending, though `timeout` had fired.

  On a network failure `onError` is now awaited for what is left of the `timeout`, and until the caller's own signal aborts: past the deadline the call fails with the `NetworkError` the hook was given — retried as one where a retry policy allows, while the outrun hook still runs — and on the caller's abort with the abort's reason. On an `HTTPError` the timeout does not bound `onError` (the exchange with 1С is over), but a caller's abort now ends the wait there too, with its reason — an abort that came before the hook started, during a buffered `afterResponse`, leaves the `HTTPError` standing. An `onError` whose wait ended early goes on by itself under an aborted `req.signal`, what it throws later dropped — it neither reaches the caller nor stops a retry. With neither a `timeout` nor a signal every hook is awaited in full, as before. The rule for every hook — which of the timeout and a caller's abort bounds it, and what the caller gets — is now listed once, on `RequestHooks`: a caller's abort ends the wait for every hook but `afterResponse` on a buffered call.

  Migration: if you relied on the call's rejection to know a side effect of `onError` had finished — a log flushed, a metric sent — await that in your own code instead (keep the promise the hook starts, and await it after catching the call's error).

- [#220](https://github.com/hacker-cb/1c-odata/pull/220) [`b37d5e2`](https://github.com/hacker-cb/1c-odata/commit/b37d5e22700755823969638a2044a199bfa44bf9) Thanks [@hacker-cb](https://github.com/hacker-cb)! - The filter DSL no longer writes an arbitrary object with an `_expr` field into `$filter` as an OData expression. A comparison value or operator argument (`eq`, `gt`, `add`, `concat`, …) is taken as an expression only where this copy of the DSL itself built it — a field (`f.A.eq(f.B)`), a field expression, or what `raw()`, `and`, `or`, `not`, `any` and `all` return. Any other object carrying `_expr` — say, parsed from outside JSON and passed through untyped code — is now refused with an `InvalidArgumentError` (`argument` the field, `received` the value) instead of rewriting the filter's condition.

  DSL expressions built by another installed copy of `@1c-odata/client` — and a `Proxy` or a spread copy over a DSL expression — are now refused the same way (`InvalidArgumentError`) where they used to be written as expressions. Migration: build the filter with the same copy of the package that runs the query — keep one version of `@1c-odata/client` in the dependency tree (`pnpm why @1c-odata/client` shows the copies).

### Patch Changes

- [#223](https://github.com/hacker-cb/1c-odata/pull/223) [`e57da5a`](https://github.com/hacker-cb/1c-odata/commit/e57da5ac51a9bfde50071c58ae5e83cee789c1ae) Thanks [@hacker-cb](https://github.com/hacker-cb)! - `V3QueryBuilder.count()` now sends the query's `$select` and `$expand` to `/$count` along with `$filter`. 1С counts the rows as it would roll them up by that `$select`: on a register virtual table in the path (`client.query('AccumulationRegister_X/Balance').select(…)`), where 1С does roll the rows up, the count now matches them — before, it left `$select` out and could be thousands of times the rows (234859 against 105 on one БП 3.0 turnovers). Where 1С returns the rows un-rolled (seen on production УТ 11.x bases), the count is the rolled-up number and below the rows — as `register(…)` virtual-table calls with `count: true` already counted. On an ordinary entity set the number is the same. `$orderby` / `$top` / `$skip` stay off the count, as before. A `$select` 1С rejects now fails `count()` as it fails `get()` (HTTP 400) — a navigation path in it needs its `expand()`, on the count as on the page — where before the count ignored it.

  The MCP `query` tool's `count` follows, and counts as `register_query` does; their descriptions now say that on a virtual table with `select` the count may be below the rows, to be paged while `hasMore` holds rather than by the count.

- [#225](https://github.com/hacker-cb/1c-odata/pull/225) [`7f48030`](https://github.com/hacker-cb/1c-odata/commit/7f48030e7156536b2f05afe469f721d866a4c7cf) Thanks [@hacker-cb](https://github.com/hacker-cb)! - The filter DSL now writes every arithmetic operation (`add`, `sub`, `mul`, `div`) in its own parentheses. The old output of a chain gave the wrong order of operations: OData — and 1С — binds `mul`/`div` tighter than `add`/`sub`, so `f.Сумма.add(1).mul(2).eq(10)` was written `Сумма add 1 mul 2 eq 10` and computed `Сумма + 2`, silently selecting the wrong rows. It is now `((Сумма add 1) mul 2) eq 10`, computed in the order of the calls; an expression passed as the operand keeps its own grouping (`(Сумма mul (Сумма add 2))`). A single operation means the same as before — only its text gains the parentheses (`(Сумма add 5) gt 10`), so code comparing `toFilterString()` output to a fixed string needs updating. A filter passed where a value goes — `raw()`, a comparison or `or(...)`, reachable only from untyped code — is now written in parentheses too, so its own operators keep their grouping (`(Сумма mul (Сумма add 2))`, `Active eq ((A eq 1) or (B eq 2))`).

- [#220](https://github.com/hacker-cb/1c-odata/pull/220) [`b37d5e2`](https://github.com/hacker-cb/1c-odata/commit/b37d5e22700755823969638a2044a199bfa44bf9) Thanks [@hacker-cb](https://github.com/hacker-cb)! - The filter DSL's `dateadd` and `datedifference` now refuse a unit outside their signature's list (`second`, `minute`, `hour`, `day`, `month`, `quarter`, `year`) with an `InvalidArgumentError`, instead of writing whatever untyped code passed into `$filter` unescaped.

- [#220](https://github.com/hacker-cb/1c-odata/pull/220) [`b37d5e2`](https://github.com/hacker-cb/1c-odata/commit/b37d5e22700755823969638a2044a199bfa44bf9) Thanks [@hacker-cb](https://github.com/hacker-cb)! - The filter DSL's `dateadd` amount and `substring` start and length must now be integers — 1С takes nothing else there: a fraction such as `dateadd('day', 0.5)` is an `InvalidArgumentError` naming the argument, instead of a query the server rejects.

- [#220](https://github.com/hacker-cb/1c-odata/pull/220) [`b37d5e2`](https://github.com/hacker-cb/1c-odata/commit/b37d5e22700755823969638a2044a199bfa44bf9) Thanks [@hacker-cb](https://github.com/hacker-cb)! - A filter value that cannot be read as a literal — an object with no prototype, one whose `toString` is not a function, a revoked `Proxy` — is now an `InvalidArgumentError` naming the field, with the underlying failure as its `cause`, instead of escaping as a bare `TypeError`.

- [#224](https://github.com/hacker-cb/1c-odata/pull/224) [`b09961c`](https://github.com/hacker-cb/1c-odata/commit/b09961cb9fa556462bc95b2163bbdda00f297fb5) Thanks [@hacker-cb](https://github.com/hacker-cb)! - A hook's own error now aborts `req.signal` whether or not a `timeout` is set. Before, the signal was aborted only through the timeout's controller, so with no `timeout` the work a failing `beforeRequest` (or a streamed read's `afterResponse`) had started under `req.signal` ran on without a deadline. Every attempt now carries a controller of its own in the request signal: `req.signal` is always set for hooks, and it aborts — the hook's error its reason — when a hook (`beforeRequest`, `afterResponse` on either path, or `onError` throwing an error other than the one it was handed) ends the call with its own error. A `beforeRequest` returning an event without `signal`, or deleting it, no longer leaves the later hooks without one. The caller's own `AbortSignal` is never aborted by this.

  A hook that fell back on a deadline of its own where `req.signal` was missing — `req.signal ?? AbortSignal.timeout(5000)` — no longer takes the fallback. To keep that deadline, combine the two: `AbortSignal.any([req.signal, AbortSignal.timeout(5000)])`.

  Once 1С has answered and the body is read, the timeout stops — on a buffered call, and for the error body of a streamed read — so it no longer aborts `req.signal` under a slow `afterResponse` or `onError` after the exchange is over. A `hooks` getter that throws after the response counts as the hook's own error — reaching the caller as is, never retried — as it already did before the request.

- [#222](https://github.com/hacker-cb/1c-odata/pull/222) [`fdbd37c`](https://github.com/hacker-cb/1c-odata/commit/fdbd37c0ba36a9857a509dc2c89d989cb9eeda9b) Thanks [@hacker-cb](https://github.com/hacker-cb)! - `.count()` now reads a `/$count` answer strictly: the whole body (BOM and surrounding whitespace aside) must be a non-negative decimal integer within the safe range. A body that only starts with digits — `12oops`, a proxy page, a truncated response — as well as `1.5`, `-1` or `1e3`, is a `ParseError` instead of a total read off its prefix. The `odata.count` of a collection (`withCount()`) is read by the same rule — a JSON number is taken where it is a non-negative safe integer, and any other value (`null`, `-1`, `true`) is a `ParseError` rather than a silently missing count. Register virtual tables (`count: true`) share the one parser, and the MCP server's `query`/`count` totals, which go through `.count()`, follow.

## 0.9.1

### Patch Changes

- [#211](https://github.com/hacker-cb/1c-odata/pull/211) [`5b7df24`](https://github.com/hacker-cb/1c-odata/commit/5b7df24d16b07d8c6775a589523c3ac09efdd67f) Thanks [@hacker-cb](https://github.com/hacker-cb)! - On a streamed read (`readStream` for a ValueStorage / binary property) the request timeout now bounds the `afterResponse` hook. Before, a hook still running when the timeout fired let the call return the response anyway, with its body already cut by the timer — reading it failed with a bare `AbortError` instead of a `TimeoutError`. Now the call fails with a `TimeoutError` (`onError` called with it) and the unread body is cancelled; a caller's `AbortSignal` firing while the hook runs ends the call with the abort's reason; both hold even where the hook ignores `req.signal`. A hook that throws its own error still fails the call with it, and work it left running under `req.signal` is now cancelled. Buffered calls (`get`, `create`, `patch`, …) are unchanged: their response is read before `afterResponse` runs and stands however long the hook takes — the JSDoc of `timeout` and `afterResponse` now says so.

- [#207](https://github.com/hacker-cb/1c-odata/pull/207) [`6c9aa0d`](https://github.com/hacker-cb/1c-odata/commit/6c9aa0dcb153d1ba3b6a308651d90c40685d688c) Thanks [@hacker-cb](https://github.com/hacker-cb)! - `ClientOptions.signal` now aborts every request of the client, as documented — a call given its own `signal` included. Before, a per-call `signal` replaced the client's instead of being combined with it, so stopping a service through the client's signal left such calls running; `register().*({ count: true })`, which always passes a signal of its own to the page and `/$count` requests, was never stopped by the client's signal at all. And the pause between retry attempts now hears an abort — of the call's signal or the client's: the call ends at once with the abort's reason, and no next attempt starts, so `beforeRequest` (a token refresh, say) is no longer called on an aborted request. A request whose signal has already aborted when it starts likewise ends before `beforeRequest` is called.

- [#208](https://github.com/hacker-cb/1c-odata/pull/208) [`6dd16fe`](https://github.com/hacker-cb/1c-odata/commit/6dd16fe27544cd8fcf7d612a2773331a974d74dd) Thanks [@hacker-cb](https://github.com/hacker-cb)! - A `Date` from another JS realm — created in a `node:vm` context, a sandbox or a plugin host — is now written, and so are the dates inside plain objects and arrays built there, in the connection's `serverTimezone` everywhere, as a `Date` of the client's own realm is. Before, writes (`create` / `patch` / `put`, with or without a schema; `dateMode: 'string'` still leaves the body as is) sent it through `JSON.stringify` as UTC ISO with `Z` instead of naive server time, and `$filter` literals and function-import arguments wrote it as `String(date)` — the date silently shifted by the zone offset or was rejected by 1С. A register turnovers-style `Period` given such a `Date` as a point is now rejected like any other point `Date`, instead of silently querying all periods. The filter DSL, function-import arguments and composite keys now share one literal formatter for numbers, booleans, `bigint`s and dates (a composite key still writes a GUID-shaped string as `guid'…'`).

- [#209](https://github.com/hacker-cb/1c-odata/pull/209) [`8d973aa`](https://github.com/hacker-cb/1c-odata/commit/8d973aa5cf636d8d214bb1fbb99f9fe1e62d08d2) Thanks [@hacker-cb](https://github.com/hacker-cb)! - MCP `query` with `count: true` no longer sends `$inlinecount`. By the 1С 8.3.27 documentation `$inlinecount` makes 1С drop `$skip` / `$top`, so on a publication that behaves as documented `query` with `count` and `skip` would silently return the start of the collection as the page asked for. The tool now reads the page alone and the exact total from the set's `/$count` (same `$filter`) in a parallel request — as `register_query` does — and a failure of either fails the call and aborts the other. The page never holds more than `top` rows: one 1С sends past `top` (a publication ignoring `$top`) is cut back to `top`. A page that cannot be placed — past `top` without `count`, or at a `skip` with exactly as many rows as 1С counted (it ignored `$skip`, or counts short) — offers no paging on (`hasMore: false`), and the summary says why. An empty page always ends the paging, whatever the count says. The client's `withCount()` is unchanged; its JSDoc now names the documented caveat and the `.count()` alternative.

## 0.9.0

### Minor Changes

- [#201](https://github.com/hacker-cb/1c-odata/pull/201) [`81ee92b`](https://github.com/hacker-cb/1c-odata/commit/81ee92b7885c2082b467558773743ecc7c9e49f0) Thanks [@hacker-cb](https://github.com/hacker-cb)! - **Breaking:** an exception thrown by an `afterResponse` or `onError` hook now reaches the caller as is — it is no longer wrapped in a `NetworkError`, `onError` is not called a second time with that wrapper, and retry never repeats the request because of it, whatever the exception's type (a `NetworkError` from a nested client call inside a hook included). Only a failure of the wire itself — the fetch, or reading the response body — becomes a `NetworkError`. Before, a hook that threw (say, `onError` throwing on a 401 to trigger a re-login) came back as a `NetworkError`, and with retry enabled the request was sent again — for the default `retryableMethods`, which include `PATCH`, `PUT` and `DELETE`, the write was repeated in 1С. An `onError` that rethrows the very error it was handed ("log and rethrow") leaves it the library's error, retried as before. `beforeRequest` already propagated its exceptions unchanged; all three hooks now follow one rule, stated on `RequestHooks`.

  Migration: if you caught your own hook's failure as `NetworkError` (`err instanceof NetworkError`, or by its `cause`), catch the error your hook throws instead. Code that relied on retry re-sending a request after a hook threw must retry it itself.

  A JSON error body of `null` — from a proxy, say — is now a `ParseError` ("missing odata.error wrapper") like any other non-object body, instead of escaping as a `TypeError` that became a retried `NetworkError`. An `odata.error.code` whose conversion to text throws no longer escapes the same way, and a bare-string `odata.error` — an empty one included — is kept as the message of an `HTTPError` rather than lost or taken for a missing wrapper.

  A caller's abort is now rethrown as the reason it was given — `controller.abort(new Error('…'))` comes back as that error, as a plain `abort()` already came back as its `AbortError` — and is never retried, whatever the reason's type; before, a custom reason became a `NetworkError` that retry repeated. A caller's abort that lands before the timeout fires is the caller's abort, not a `TimeoutError`.

  In `requestStream()`, an `afterResponse` hook that throws now cancels the unread response body, releasing its connection, instead of leaving it to the garbage collector.

  Retry now decides by the method that was actually sent: a `beforeRequest` hook that replaces the method — `GET` into `PATCH`, say — is checked against `retryableMethods` as sent, so a write it produces is not repeated unless its method is listed, and a request it turns into a listed method is retried.

- [#197](https://github.com/hacker-cb/1c-odata/pull/197) [`29996ce`](https://github.com/hacker-cb/1c-odata/commit/29996ce439d8651d36480d5791a0bbb65b3fd97e) Thanks [@hacker-cb](https://github.com/hacker-cb)! - **Breaking:** `parseInZone` places a wall-clock time a daylight-saving switch touches by one rule, `Temporal`'s `'compatible'`: a time the zone passes twice (the clocks go back) is the EARLIER instant, and a time the zone skips (the clocks go forward) moves forward by the gap — `2018-11-04T00:30` in `America/Sao_Paulo` is now 01:30 that day, not 23:30 the day before; `2025-10-26T02:30` in `Europe/Berlin` is now 02:30 CEST, an hour earlier than before. Every `Edm.DateTime` read from 1С goes through it. A new third argument, `parseInZone(naive, zone, { disambiguation: 'reject' })`, refuses a skipped time with an `InvalidArgumentError` instead — and, unlike `Temporal`'s `'reject'`, still reads a time passed twice as the earlier instant (new public types `ParseInZoneOptions`, `ZoneDisambiguation`).

  **Breaking:** `parseInZone` rejects what names no real date-time with an `InvalidArgumentError` instead of rolling it over or failing with a raw `RangeError`: `2026-02-30` used to become `2026-03-02` and `24:00` the next day; a month `13`, a year `0000` and a string that is not `YYYY-MM-DDTHH:mm[:ss[.fff]]` (a space may stand for the `T`) fail the same way, as does an unknown timezone or none at all (`Intl` used to take the host's zone). Reading a response, a field the schema types `Edm.DateTime` with such a value — or with anything but a string or `null` — is a `ParseError` naming the field and the value, and only the exact empty date `0001-01-01T00:00:00` reads as `null` (any string starting with it did); a field only the schema-less heuristic took for a date stays the string it came as. Migration: catch `InvalidArgumentError` where you call `parseInZone` on input you do not control; a read (`query().get()`, `entity().get()`, …) that must survive a corrupt date in a typed field catches `ParseError`, or reads with `shape: { dateMode: 'string' }` and converts with `parseInZone` itself.

  Years `0001`–`0999` — 1С's dates go down to `0001`, and a typo such as `0202` for `2020` happens — now read and write correctly: `parseInZone` used to fail on them with a raw `RangeError`, failing the whole collection read, and `formatInZone` wrote the year without its leading zeros (`999-05-01T…`) into filters, function-import arguments and written entities. `formatInZone` rejects an invalid `Date` and one whose year in the zone falls outside `0001`–`9999` with an `InvalidArgumentError`, and accepts a `Date` from another realm (`node:vm`).

  MCP `register_query` uses the client's `disambiguation: 'reject'` for naive periods instead of a check of its own: a time a daylight-saving switch skips is still refused. Changed: a bare day whose midnight a switch skips starts at the switch itself (00:15 in `Asia/Kathmandu` on 1986-01-01) rather than always at 01:00 (still 01:00 in `America/Sao_Paulo`), a bare `periodTo` whose 23:59:59 a switch skips ends at the day's last real second (22:59:59 in `America/Nuuk` on 2024-03-30) instead of being refused, and a bare day the zone skips whole is refused with `Invalid ISO date`; a naive period whose time the clocks pass twice is the earlier instant in every zone (in `Europe/Berlin` it was the later one); a naive period with a year below 1000 is read instead of refused; and a period with an offset that falls outside the years 0001–9999 in the server's zone is refused with `Invalid ISO date` instead of failing later.

- [#199](https://github.com/hacker-cb/1c-odata/pull/199) [`1f23acd`](https://github.com/hacker-cb/1c-odata/commit/1f23acd3d1f12965fb6e70fa0b9c54f0c5e8c7b7) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Register virtual-table methods (`client.register(…).balance()` / `turnovers()` / `balanceAndTurnovers()` / `sliceFirst()` / `sliceLast()` / `drCrTurnovers()` / `extDimensions()` / `recordsWithExtDimensions()`) page and sort on the 1С server: `ReadFiOptions` gains `skip` (`$skip`) and `orderBy` (`$orderby`, `[{ field, dir? }]`), and passing `count: true` (`ReadFiCountOptions`) makes the method resolve to a `ReadFiPage` — `{ value, count }` — instead of the bare row array. Calls without `count` are unchanged and still resolve to `R[]`; a subclass overriding one of these methods now declares the `count: true` overload too.

  The count is a second request, the table's `…/Func()/$count` with the same parameters, `$filter` and `$select` (the grouping), sent in parallel with the page — not `$inlinecount`, which the 1С documentation says makes `$skip` / `$top` ignored. If either request fails, the call fails and the other is aborted; so does a `/$count` body that is not wholly a non-negative integer (`12oops`, `1.5`, `-1`). The two requests see the data a moment apart, so on data changing meanwhile the count and the page can briefly disagree; and a 1С publication that returns a `$select` ungrouped may still count it grouped (seen on УТ 11.5 `Balance()`), so the count can fall short of the rows. 1С computes the whole virtual table for each request, so a page of a big table still costs that time — but only the page travels.

  An untyped caller passing a negative or fractional `skip`, an `orderBy` that is not an array of `{ field, dir? }` (a blank field, a field with a space, a comma or an empty path segment, or a `dir` other than `asc` / `desc` included) or a non-boolean `count` gets an `InvalidArgumentError` before any request.

  The `ReadFiOptions.select` documentation no longer promises a server-side roll-up on the aggregating tables: whether 1С sums the resources over the selected dimensions depends on the 1С configuration (it does on БП 3.0 `AccountingRegister` turnovers, not on УТ 11.5 `AccumulationRegister_ТоварыНаСкладах` balance).

- [#187](https://github.com/hacker-cb/1c-odata/pull/187) [`28ddb8a`](https://github.com/hacker-cb/1c-odata/commit/28ddb8ae0d03ed02784b654645c544225e9660dd) Thanks [@hacker-cb](https://github.com/hacker-cb)! - **Breaking:** names and keys that reach a URL path are now checked, and what does not pass is an `InvalidArgumentError` before any request. Rejected now: an entity-set or function name in a function-import or register virtual-table call (`client.functions.X.Y`, `client.register(…)`, document `post()` / `unpost()`, MCP `register_query`) that is not a plain 1С metadata name (letters, digits, `_`) — including a name the caller already percent-encoded; a ValueStorage property that is not such a name; a string entity key that is not a GUID; a composite key that is empty, an array, or has a field name that is not a 1С name. Migration: pass the plain (Cyrillic) name, never a percent-encoded one; pass a string key only as a `Ref_Key` GUID; pass a composite key as an object whose field names are 1С names (e.g. `{ Recorder: '…guid…', LineNumber: '1' }`).

  Function-import and register virtual-table URLs encode the entity set and function name as one path segment each: a name carrying `/`, `?`, `#`, `%`, `(` or `..` — e.g. a `register` argument passed to MCP `register_query` — can no longer reach another path of the host with the connection's credentials, push `$top` into a URL fragment or address a single entity. Collection, key, `$count`, `create` and ValueStorage URLs reject an entity set that is empty, `.`, `..`, has such a `/`- or `\`-separated part outside its parentheses and quotes, or is not encodable (a lone surrogate); `create` now percent-encodes the set name like the other URLs. Entity keys get the same guard, reachable through MCP `get_entity` (which now checks the GUID shape in its schema) and every entity handle (get / patch / put / delete / ValueStorage). A string the URL encoder cannot take (a lone UTF-16 surrogate) in a query option, a function-import argument or a key value fails with `InvalidArgumentError` instead of a raw `URIError`. Cyrillic names are percent-encoded on the wire as before.

- [#200](https://github.com/hacker-cb/1c-odata/pull/200) [`59ace8d`](https://github.com/hacker-cb/1c-odata/commit/59ace8d4599602d21b65f416239f515a2c57f610) Thanks [@hacker-cb](https://github.com/hacker-cb)! - A composite entity key takes typed values: `EntityKey` is now `string | Record<string, string | number | bigint | boolean | Date>`, and each value is written by its JS type, as the 1С docs show it — a `number` or `bigint` bare (`LineNumber=1`), a `boolean` as `true` / `false` (registers key on `Edm.Boolean` fields too), a `Date` as `datetime'…'` in the connection's `serverTimezone` (`Period=datetime'2025-01-01T00:00:00'`), a string as before (a GUID → `guid'…'`, anything else a quoted literal, which 1С converts to the field's type). A row read back keys itself: `client.entity('InformationRegister_КурсыВалют', { Period: row.Period, Валюта_Key: row.Валюта_Key })` — a `Date` key used to be an `InvalidArgumentError`. A `number` value, which untyped callers could already pass, now goes out bare (`LineNumber=1`) instead of quoted (`LineNumber='1'`); 1С accepts both. An invalid `Date`, a non-finite number, or a value of another type is an `InvalidArgumentError`; a `Date` from another realm (`node:vm`) is accepted; within one call a `Date` value is copied, so a caller reusing it cannot split an `expectVersion` check and its mutation across two rows. Values that do not key their row as read: the empty date (read as `null` — pass `ONEC_EMPTY_DATE`), an `Edm.Int64` past 2^53 under the default `int64Mode: 'number'`, a time a daylight-saving switch skips, and a string the schema-less date heuristic took for a date-time. Migration: code that reads the values of an `EntityKey` object now sees the wider union — narrow with `typeof` / `instanceof Date` before using a value as a string.

### Patch Changes

- [#196](https://github.com/hacker-cb/1c-odata/pull/196) [`496ab3d`](https://github.com/hacker-cb/1c-odata/commit/496ab3d631da878443a418b22958875889e0a23c) Thanks [@hacker-cb](https://github.com/hacker-cb)! - A `beforeRequest` hook that throws no longer leaves the request's timeout timer running, and the timeout now bounds the hook. Before, a failing hook — a token fetch that rejects, say — failed the call at once while the timer, started before the hook, kept a short-lived Node process (a CLI, a script, a test run) alive for the whole `timeout`. Now the hook's error still reaches the caller unchanged, and the call ends there: the timer is cleared and `req.signal` is aborted, so work the hook left running under that signal is cancelled rather than left without a deadline. A hook still pending when the timeout fires now fails the call with a `TimeoutError` — `onError` called with it — even where the hook ignores `req.signal`; before, the call waited for the hook however long it took, and a hook that rejected with the timeout's own abort surfaced as a bare `AbortError`. A caller's `AbortSignal` firing during the hook likewise ends the wait at once, with the abort's reason.

- [#198](https://github.com/hacker-cb/1c-odata/pull/198) [`bc82f74`](https://github.com/hacker-cb/1c-odata/commit/bc82f740a603a3df4f20be876ab86d3a135c73fe) Thanks [@hacker-cb](https://github.com/hacker-cb)! - An XML error body now counts as an OData error envelope only when its root is an `error` element in the OData metadata namespace (`http://schemas.microsoft.com/ado/2007/08/dataservices/metadata`), with `code` and `message` read from its direct children in that namespace (entities and CDATA decoded). The envelope must be well-formed and closed. The body's format is decided by the media type alone, case-insensitively — `Application/XML` and `Application/JSON` error bodies are recognised too, and a parameter mentioning `json` no longer sends an XML body to the JSON parser. Before, any non-2xx body with `xml` in its content type that held a bare `<code>` or `<message>` anywhere was taken for one — an XHTML proxy or IIS error page with an HTML `<code>` element on a 401 became a `PermissionError` with a made-up OData code, and on a 403 an `HTTPError` with `errorFormat: 'xml'`; such pages now take the no-envelope path (`errorFormat: 'none'`, the page in `rawBody`), like any HTML error page.

  The real 1С XML envelope is now recognised: 1С sends it prefixed — `<m:error xmlns:m="…"><m:code>9</m:code><m:message>…</m:message></m:error>` — which the old check missed, so it came out as `errorFormat: 'none'`. It now yields `errorFormat: 'xml'`, its `code` and `odata`, and the category subclass its status calls for (`PermissionError` on 401, `ConcurrencyError` on 412, `BusinessError` on 500 with code `-1`). The client asks for JSON — `Accept` on every request, `$format` on collection and keyed URLs — so this reaches you where a request asks for XML: `$metadata` (`fetchMetadataXml`), or a request without `$format` whose `Accept` you override (`withHeader('Accept', …)`, a `beforeRequest` hook).

## 0.8.0

### Minor Changes

- [#184](https://github.com/hacker-cb/1c-odata/pull/184) [`a2334fd`](https://github.com/hacker-cb/1c-odata/commit/a2334fd33035bd6f55b6ae5c8d477b9b116982c2) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Register virtual tables take `$select` and `$filter`. `ReadFiOptions` gains `select?: string[]` and `filter?: string`, honoured by every `RegisterHelper` virtual-table method (`balance`, `turnovers`, `balanceAndTurnovers`, `sliceFirst`, `sliceLast`, `drCrTurnovers`, `extDimensions`, `recordsWithExtDimensions`) and encoded like a collection query. On a virtual table `select` is also the grouping — 1С sums the resources over the selected dimensions only, so on the aggregating tables (`Balance`, `Turnovers`, `BalanceAndTurnovers`, `DrCrTurnovers`) e.g. `AccountingRegister_Хозрасчетный.Turnovers` for one account and month drops from 178 rows to 45 with six fields selected. `filter` is a raw OData expression on the resulting rows. MCP `register_query` takes the same `select` and `filter` parameters. Empty values send nothing; existing calls are unchanged.

### Patch Changes

- [#185](https://github.com/hacker-cb/1c-odata/pull/185) [`7432911`](https://github.com/hacker-cb/1c-odata/commit/7432911062c53652241da8f86d45b0358c6c7e56) Thanks [@hacker-cb](https://github.com/hacker-cb)! - IIS's `400 Bad Request — Invalid URL` page now gets its own message instead of the generic "no OData error envelope" text. Where a decoded path segment of the request is over 260 characters (http.sys `UrlSegmentMaxLength`, its default) the message names that limit and the usual cause — a register virtual table called with its parameters in the path, `…/Turnovers(StartPeriod=…,AccountCondition='…')`, where they all share one segment (about two GUIDs in a condition) — and points to `client.register(…)` (in the MCP server: `register_query`), which sends them in the query string with no such limit, or to splitting the condition over disjoint subsets. The MCP `query` tool's description and its virtual-table tip say the same; `register_query` is not affected by the limit.

- [#183](https://github.com/hacker-cb/1c-odata/pull/183) [`d717164`](https://github.com/hacker-cb/1c-odata/commit/d7171641b4eaa907d3b859b61ff9f554e2559aa4) Thanks [@hacker-cb](https://github.com/hacker-cb)! - `NetworkError` now names the underlying cause instead of undici's bare `fetch failed`: the code and text of `error.cause` are appended — `Network error: fetch failed (UNABLE_TO_GET_ISSUER_CERT_LOCALLY: unable to get local issuer certificate)`, `ENOTFOUND`, `ECONNREFUSED` — including the per-address errors of a multi-address connect failure, whose own message is empty. A certificate-trust failure also gets a hint to trust the issuing CA with `NODE_EXTRA_CA_CERTS` or the OS store with `NODE_USE_SYSTEM_CA=1`. The MCP server shows the same text, so `add_connection` (when it verifies a password) and every tool that reaches a base now say why it is unreachable. The original error stays in `error.cause`. README "Network configuration" documents `NODE_USE_SYSTEM_CA` and the MCP server's `env` block.

## 0.7.0

### Minor Changes

- [#126](https://github.com/hacker-cb/1c-odata/pull/126) [`3146289`](https://github.com/hacker-cb/1c-odata/commit/3146289e4304b1ea5bf531be6a8496456c6cf228) Thanks [@hacker-cb](https://github.com/hacker-cb)! - **Breaking:** the minimum supported Node version is now 24.18.0 (was 22.21.0).

  Node 22 "Jod" has left active LTS and is in maintenance; Node 24 "Krypton" is
  the active LTS line and is supported until 2028-04-30. Installing on Node 22
  will now be refused or warned about by npm/pnpm, depending on your client.

  No source change accompanies this. The library does not yet use any API that
  Node 22 lacks — the floor moves so that the version CI exercises and the version
  the packages advertise are one and the same. Keeping the advertised floor below the tested one meant the
  promise was never actually verified, which is the defect this closes.

  `@types/node` is pinned to the matching major for the same reason: types
  describing a runtime above the floor let an API that does not exist there
  typecheck green and fail at runtime for anyone who installed at the advertised
  minimum.

  If you are pinned to Node 22, stay on the previous release until you can move —
  v0.x carries no compatibility shims (see STABILITY.md).

## 0.6.0

## 0.5.0

### Patch Changes

- [#49](https://github.com/hacker-cb/1c-odata/pull/49) [`bc33cc0`](https://github.com/hacker-cb/1c-odata/commit/bc33cc0733238ee241d3106b9854c78bf02fb62b) Thanks [@hacker-cb](https://github.com/hacker-cb)! - fix(client): don't set a manual Content-Length on write requests

  The write path set an explicit `Content-Length` header (computed from the body)
  on POST / PATCH / PUT. `Content-Length` is a forbidden fetch header, and undici
  (Node's `fetch` backend) rejects a manual one with `UND_ERR_INVALID_ARG: invalid
content-length header` once it conflicts with the length undici derives from the
  body — which surfaces on the real dispatch path, e.g. behind a `ProxyAgent` and
  on undici ≥ 7. The client now sets only `Content-Type` on body writes and lets
  `fetch`/undici compute `Content-Length`; a body-less write still sends an
  explicit `Content-Length: 0` (1С's IIS host wants it to avoid a 411 Length
  Required).

## 0.4.1

### Patch Changes

- [#39](https://github.com/hacker-cb/1c-odata/pull/39) [`b187b01`](https://github.com/hacker-cb/1c-odata/commit/b187b014074601526a49928c74a3064feede3b12) Thanks [@hacker-cb](https://github.com/hacker-cb)! - fix(release): publish via `pnpm pack` so `workspace:*` deps are rewritten to concrete versions

  The release workflow published with `npm publish`, which does not rewrite the
  `workspace:` protocol. As a result `@1c-odata/metadata` and `@1c-odata/cli` (and
  transitively `@1c-odata/mcp`) shipped with `"@1c-odata/client": "workspace:*"` in
  their published manifests and were uninstallable from npm (`EUNSUPPORTEDPROTOCOL`).
  The workflow now publishes a `pnpm pack` tarball, which rewrites workspace deps to
  the released version, so a plain `npm install` / `npx` resolves them. (`@1c-odata/client`
  is dependency-free and was unaffected; it bumps with the fixed group.)

## 0.4.0

### Minor Changes

- [#29](https://github.com/hacker-cb/1c-odata/pull/29) [`27c207a`](https://github.com/hacker-cb/1c-odata/commit/27c207a770b6969872db5f07b7a334574313a12a) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Error-handling architecture: honest `HTTPError` envelope model, request context on every error, and a dedicated `MetadataError`.

  - `ODataError` now carries `request?: { method, url }`, populated on every request-originated error (`HTTPError`, `NetworkError`, `TimeoutError`) so a caught error knows which call produced it. It excludes headers by design — the `Authorization` header never lands in logs. Errors not tied to a request (`InvalidArgumentError`, `ValidationError`, `MetadataError`) omit it.
  - `HTTPError` no longer fabricates an OData body when the server didn't send one. `ErrorFormat` gains `'none'`; the parsed-envelope field is renamed `body` → `odata` and is now optional, as is `code` (both present only with a real JSON/XML `odata.error`); a new `rawBody` carries a truncated (≤512 char) snippet of the raw response. A non-2xx with no recognizable envelope (wrong entity-set path, missing base, over-long URL, HTML/proxy error page) now throws a real `HTTPError` with the status preserved and an actionable message — previously this surfaced as a `ParseError` that dropped the status code.
  - New `MetadataError` (extends `ODataError`) for schema-metadata failures: `loadMetadataIndex` / `parseMetadataIndex` and `parseEdmx` now throw it instead of `ParseError`. `ParseError` is reserved for HTTP response-body parse failures. `@1c-odata/metadata` re-exports `MetadataError` and `ODataError` so consumers can catch without a separate `@1c-odata/client` import.
  - `ConcurrencyError` from the client-side `expectVersion` guard no longer fabricates `errorFormat:'json'`/`body`/`code` — it reports `errorFormat:'none'` (no server response exists) while keeping `status: 412` and subclass identity.

  **Breaking (v0.x):**

  - `HTTPError.body` is renamed to `HTTPError.odata` and is now `ODataErrorBody | undefined`; `HTTPError.code` is now `string | undefined`. Guard before dereferencing (e.g. `err.odata?.message`).
  - A 401/412 _without_ an OData envelope now arrives as a generic `HTTPError` (with `status === 401`/`412`), not `PermissionError`/`ConcurrencyError`.
  - `loadMetadataIndex` / `parseMetadataIndex` / `parseEdmx` now throw `MetadataError` instead of `ParseError`. Catch `MetadataError` for local metadata/EDMX failures, or `ODataError` to cover both domains.

  `instanceof` identity, `HTTPError.status` (always present), and `Error.message` mutability are unchanged.

- [#27](https://github.com/hacker-cb/1c-odata/pull/27) [`f065038`](https://github.com/hacker-cb/1c-odata/commit/f0650388106795f5754d2f77574cfee8d45f50f9) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Fix the AccountingRegister `RegisterHelper` virtual-table methods, and add `$top` + per-call request options to every register FI.

  Extending live coverage to the full register surface (verified against УТ 11.5 + БП 3.0) surfaced that several `RegisterHelper` methods sent parameters 1С rejects — the same class of bug as the AccumulationRegister turnovers fix. MSW unit tests missed them because they only echo the URL the client builds:

  - **`drCrTurnovers()`** sent `StartDate`/`EndDate` (HTTP 501 live) and modelled non-existent `@odata.bind` `AccountDr`/`AccountCr` params. It now sends `StartPeriod`/`EndPeriod` via a `Period: { from?, to? }` range and exposes the real string filters (`AccountCondition`, `BalancedAccountCondition`, `Condition`, `Dimensions`, `ExtraDimensions`, `BalancedExtraDimensions`).
  - **`recordsWithExtDimensions()`** sent `StartDate`/`EndDate` (HTTP 501 live). Now `Period: { from?, to? }` → `StartPeriod`/`EndPeriod`, plus optional `Condition` / `Order` / `Top`.
  - **`extDimensions()`** sent a fabricated `Account_Key` parameter (the FI takes none). It now takes no FI arguments.
  - AccountingRegister `balance()` / `turnovers()` / `balanceAndTurnovers()` work too (these virtual tables exist on AccountingRegisters). `BalanceArgs` / `TurnoversArgs` gain the AccountingRegister-only `AccountCondition` / `ExtraDimensions` filters, and the shared methods now forward every supplied arg by presence — so account filters are no longer silently dropped on the shared FIs.

  All register FI methods now accept an optional trailing `ReadFiOptions` (`{ top? }` plus the per-call `signal` / `timeout` / `retry` from `RequestOptions`) → `$top`, so the large collections big registers return (e.g. a full AccountingRegister `Balance`) can be bounded or aborted instead of fetched whole.

  **Breaking (types):**

  - `DrCrTurnoversArgs` reworked: `{ StartDate, EndDate, AccountDr, AccountCr }` → `{ Period: { from?, to? }, Condition?, AccountCondition?, BalancedAccountCondition?, Dimensions?, ExtraDimensions?, BalancedExtraDimensions? }`.
  - `RecordsWithExtDimensionsArgs` reworked: `{ StartDate, EndDate }` → `{ Period: { from?, to? }, Condition?, Order?, Top? }`.
  - `ExtDimensionsArgs` removed; `extDimensions()` takes no arguments.

  InformationRegister `sliceFirst()` / `sliceLast()` are unchanged — they correctly invoke the FI on the registered set (the common case). The doc now notes the minority of registers whose slice binds to `_RecordType`: register the `_RecordType` set for those.

- [#19](https://github.com/hacker-cb/1c-odata/pull/19) [`968a14e`](https://github.com/hacker-cb/1c-odata/commit/968a14e3c52e70026a1c4eae5336d63c0ca386b3) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Split the runtime connection descriptor from the build-time codegen config.

  The single `defineConfig` / `CliConfig` object mixed three lifecycles in one file the app runtime had to import: the runtime connection (`baseUrl`/`auth`/`serverTimezone`/`shape`), build-only codegen settings (`include`, `fetchTimeout`, `metadataDir`, `generatedDir`), and secrets. They are now cleanly separated:

  - **`@1c-odata/client`** owns the runtime `Connection` — now just `baseUrl`, `auth`, `serverTimezone`, `shape` — plus a new `defineConnection` helper. `CliConfig` and `defineConfig` are **removed** from this package (the zero-dep runtime core no longer carries build-tool concepts).
  - **`@1c-odata/cli`** owns the build-time codegen config: new `defineCodegenConfig` + `CodegenConfig` / `CodegenTarget` types. A target wraps a `connection` plus codegen options.
  - The app runtime no longer imports `1c-odata.config.ts` — it builds its `Connection` directly (from env, a database, a vault, …), so build settings and secrets stay out of the runtime graph.

  **Migration — `1c-odata.config.ts`:**

  ```diff
  -import { defineConfig, parseConnectionUrl } from '@1c-odata/client'
  +import { parseConnectionUrl } from '@1c-odata/client'
  +import { defineCodegenConfig } from '@1c-odata/cli'

  -export default defineConfig({
  -  connections: {
  -    trade: {
  -      ...parseConnectionUrl(url),
  -      serverTimezone: 'Europe/Moscow',
  -      codegen: { include: ['Catalog_*'] },
  -    },
  -  },
  -})
  +export default defineCodegenConfig({
  +  targets: {
  +    trade: {
  +      connection: { ...parseConnectionUrl(url), serverTimezone: 'Europe/Moscow' },
  +      include: ['Catalog_*'],
  +    },
  +  },
  +})
  ```

  **Migration — runtime** (build the `Connection`, don't import the config file):

  ```diff
  -import config from '../1c-odata.config.js'
  -const client = new ODataV3Client(clientOptionsFromConnection(config.connections.trade!))
  +import { defineConnection, parseConnectionUrl } from '@1c-odata/client'
  +const conn = defineConnection({ ...parseConnectionUrl(process.env.ONEC_URL!), serverTimezone: 'Europe/Moscow' })
  +const client = new ODataV3Client(clientOptionsFromConnection(conn))
  ```

  Other breaking changes:

  - CLI selection flag renamed `--connection` → `--target` (e.g. `1c-odata fetch --target trade`).
  - `Connection.fetchTimeout` removed — set the `$metadata` download timeout per codegen target (`CodegenTarget.fetchTimeout`), at config level (`CodegenConfig.fetchTimeout`), or per call (`fetchMetadataIndex(conn, { timeout })`).
  - `Connection.codegen` removed — the `include` whitelist now lives directly on the codegen target.

- [#26](https://github.com/hacker-cb/1c-odata/pull/26) [`b1507e8`](https://github.com/hacker-cb/1c-odata/commit/b1507e8c98bba793527cfdb8a07059b06628f983) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Fix `RegisterHelper.turnovers()` / `balanceAndTurnovers()` sending the wrong period parameters to 1С.

  Both helpers previously flattened a date range to `StartDate`/`EndDate`. The 1С AccumulationRegister `Turnovers` / `BalanceAndTurnovers` virtual tables only accept `StartPeriod`/`EndPeriod`, so every range query was rejected with HTTP 501 («Параметр EndDate не поддерживается»). They now send `StartPeriod`/`EndPeriod`. Verified live against УТ 11.1, УТ 11.5 and БП 3.0: the new params return 200, the old ones 501. (`StartDate`/`EndDate` belong to the AccountingRegister `drCrTurnovers()` / `recordsWithExtDimensions()` tables and are intentionally left untouched.)

  **Breaking (type):** `TurnoversArgs.Period` is now an interval `{ from?: Date; to?: Date }` and no longer accepts a bare `Date`. Turnovers have no single-point form in 1С — there is no `Period` parameter on these tables, and a point query returned 501. The type forbids a bare `Date`; an untyped (JS) caller that still passes one now gets an `InvalidArgumentError` instead of a silent all-periods query. Migrate point usage to a range:

  ```diff
  - client.register('AccumulationRegister_X').turnovers({ Period: someDate })
  + client.register('AccumulationRegister_X').turnovers({ Period: { from: someDate } })
  ```

  `balance()` is unchanged — it correctly uses a single-point `Period`.

### Patch Changes

- [#35](https://github.com/hacker-cb/1c-odata/pull/35) [`70cef5e`](https://github.com/hacker-cb/1c-odata/commit/70cef5e9066422c15871874b47f79cb06efdc777) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Fix four TS ↔ 1С conversion correctness issues:

  - **Nested entities are now parsed with their own schema.** Reading an `$expand`ed tabular part or nested ComplexType previously looked every field up in the _parent_ entity's schema, so a nested `Edm.Int64` stayed a string, a nested `Edm.DateTime` fell back to the regex heuristic, and nested ValueStorage triples were never grouped — even though the generated types promised converted values, and the write path already recursed with the nested type. The parser now resolves each nested field's own type (mirroring `write-transform`), and parses expanded navigation entities schema-less instead of bleeding the parent schema into them.
  - **ValueStorage round-trips on write.** The read side groups `<base>_Base64Data` + `<base>_Type` into a single `{ contentType, base64Data }` object; writing that object straight back (read → modify → `patch`) now splits it into the two wire halves 1С expects (the same shape `writeStream` PATCHes), instead of silently sending an unrecognized body. `validateOnWrite` now skips ValueStorage triple members, so the grouped form is no longer rejected when a `<base>_Type` half is declared non-nullable (which occurs in real 1С schemas).
  - **Numeric filter literals no longer use exponential notation.** `formatNumberLiteral` expanded small fractions / large magnitudes (e.g. `1e-7`, `1e21`) that JavaScript renders exponentially into plain decimal strings — OData V3 has no exponential numeric literal, so `f.field.eq(0.0000001)` previously produced an invalid `$filter` (HTTP 400 or a silent mismatch).
  - **Datetime milliseconds survive a round-trip.** `formatInZone` now keeps a non-zero millisecond component (`…:00.250`) instead of truncating to whole seconds, and `parseInZone` resolves the zone offset at second precision before re-applying the fraction — fixing both the silent write-side loss and a redundant offset recomputation for fractional inputs. Second-precision values (all standard 1С datetimes) are unchanged.

- [#37](https://github.com/hacker-cb/1c-odata/pull/37) [`8a09e92`](https://github.com/hacker-cb/1c-odata/commit/8a09e92b7422e4e855b1b3e9bf726f61bcd53d9b) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Internal DRY cleanup (no runtime behavior change):

  - Export `Int64Mode` and `DateMode` type aliases and a `DEFAULT_SHAPE` constant from `@1c-odata/client`. The `'number' | 'bigint' | 'string'` / `'date' | 'string'` union literals and the `int64Mode: 'number'` / `dateMode: 'date'` defaults were previously hand-duplicated across the runtime parser, write transform, `buildMetadataIndex`, and every codegen emitter; they now reference a single source, so the cross-layer `DataShape` contract can't silently drift.
  - Factor the composite-key tabular-header prefix match shared by `computeClosure` and `linkTabularParts` into one `findHeaderByPrefix` helper (the `_RecordType` companion handling, which intentionally differs between the two, stays at each call site).
  - Collapse the duplicated `entitySetToType → schemas` lookup in `ODataV3Client`'s `validateBeforeWrite` and write transform into a single `schemaForSet` helper.

  Byte-identical metadata output and unchanged public behavior are pinned by the existing `metadata-parity` and public-surface tests.

- [#38](https://github.com/hacker-cb/1c-odata/pull/38) [`4415ac4`](https://github.com/hacker-cb/1c-odata/commit/4415ac4dae057a5c5131aad18ddedc0a7ba738de) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Error/retry ergonomics:

  - **`ConcurrencyError` exposes the compared versions as structured fields.** The client-side optimistic-concurrency guard (`MutationOptions.expectVersion`) now populates `error.expectedVersion` and `error.actualVersion` instead of burying them in the message string, so callers can react to a conflict without parsing text. New `ConcurrencyErrorOptions` type. (Both fields are `undefined` on the rare path where a real HTTP 412 maps to this class.)
  - **Export a ready-made `DEFAULT_RETRY_POLICY`.** Assembling a `RetryPolicy` previously meant spelling out all seven fields by hand. `DEFAULT_RETRY_POLICY` covers the common case — 3 retries of idempotent methods (`GET`/`PUT`/`DELETE`/`PATCH`; `POST` excluded) on `502`/`503`/`504` with exponential backoff + full jitter. Pass it as `retry`, or spread it to tweak a field (`{ ...DEFAULT_RETRY_POLICY, maxRetries: 5 }`). It is frozen, so a direct import cannot retune retries process-wide. Retries remain off unless a policy is supplied.

- [#36](https://github.com/hacker-cb/1c-odata/pull/36) [`c48e6dc`](https://github.com/hacker-cb/1c-odata/commit/c48e6dcb661ddbd30a715f9292c36723fa900197) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Fail loudly with actionable errors on the dynamic / live-metadata path:

  - **`fetchMetadataXml` rejects non-EDMX responses.** The most common dynamic-mode failure — a wrong base URL, or an unauthenticated request redirected to an HTML login/portal page returning `200` — previously flowed into `parseEdmx` and surfaced as a cryptic `Expected <edmx:Edmx> root element`. It now throws a `MetadataError` naming the URL, status, content-type, and the first bytes of the body.
  - **`MetadataError` from `fetchMetadataIndex` carries request context.** A parse failure on a live `$metadata` now attaches the source URL (`error.request`), so a multi-target / multi-tenant setup can tell which base produced the bad XML.
  - **`ODataV3Client` validates IANA timezone validity in its constructor**, not just presence. A client built directly via `new ODataV3Client({...})` (bypassing `validateConnection`) with a bogus `serverTimezone` now throws `InvalidArgumentError` immediately instead of silently shifting every parsed/written `DateTime`.

## 0.3.0

### Minor Changes

- [#12](https://github.com/hacker-cb/1c-odata/pull/12) [`0fff3c8`](https://github.com/hacker-cb/1c-odata/commit/0fff3c877f31526af8301646f3aa9663f5907f7c) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Filter DSL chaining is now correctly typed. Methods that return an expression (`f.Date.year()`, `f.Сумма.add(5)`, `concat`, `substring`, `cast`, `dateadd`, …) previously returned the bare branded `FieldExpr<V>` with no operator surface, so chains like `f.Date.year().eq(2025)` — the README example — failed to compile against the public types (the runtime Proxy always worked). They now return the new `ChainedFieldExpr<V>` (brand + operators), and `FieldExprMap` property access carries the brand, so field proxies type-check as arguments to `any`/`all` and operator parameters.

- [#9](https://github.com/hacker-cb/1c-odata/pull/9) [`39e3003`](https://github.com/hacker-cb/1c-odata/commit/39e3003a1f287d0cf21ed519699379cc04774c1e) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Schema-less write correctness. `Date` instances in write payloads now convert to naive ISO in `serverTimezone` even without a `metadataIndex` (and for entity sets / fields missing from a loaded index — forward-compat with newer server schemas). Previously they serialized as UTC strings with a `Z` suffix, which 1С reads as a shifted wall-clock time. `bigint` values now serialize as the Edm.Int64 wire string everywhere (previously `JSON.stringify` threw `TypeError`, breaking the `int64Mode: 'bigint'` read → write round-trip even WITH a schema). `null` without a schema stays `null` — pass `ONEC_EMPTY_DATE` explicitly to clear a date. `shape: { dateMode: 'string' }` disables all date handling on both paths, as before.

  Migration: if you relied on the UTC-`Z` passthrough, set `shape: { dateMode: 'string' }` or pass pre-formatted strings.

- [#9](https://github.com/hacker-cb/1c-odata/pull/9) [`39e3003`](https://github.com/hacker-cb/1c-odata/commit/39e3003a1f287d0cf21ed519699379cc04774c1e) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Schema-less usage helpers: new `UntypedEntity` type (typed 1С system fields + open index signature) for `query<UntypedEntity>(...)` without codegen, and `parseMetadataIndex(data, source?)` — the pure validation core of `loadMetadataIndex` for reviving a `MetadataIndex` from caches or other non-file transports.

## 0.2.0

### Minor Changes

- [#5](https://github.com/hacker-cb/1c-odata/pull/5) [`7383109`](https://github.com/hacker-cb/1c-odata/commit/73831096eefbc3fa45b30874b69221d3cc58f244) Thanks [@hacker-cb](https://github.com/hacker-cb)! - **Reject `NaN` / `Infinity` in numeric literals (silent data loss fix).**

  `$filter` numeric operators (`eq`, `gt`, `add`, etc.) and `FunctionImport` argument
  serialization previously formatted `NaN` / `+Infinity` / `-Infinity` as the bare
  strings `NaN` / `Infinity` / `-Infinity`. None of these are valid OData V3 literals
  — 1С either rejected them with HTTP 400 or (in the worst case) returned spurious
  results as if the comparison had been dropped.

  These three values now throw `InvalidArgumentError` synchronously when constructing
  the query, with `argument` pointing at the offending field name or FI parameter.

  **Migration:**

  - Code paths that always pass finite numbers are unaffected.
  - Callers that derive numeric inputs from reductions over potentially-empty arrays
    (e.g. `Math.max(...arr)` → `-Infinity` when `arr === []`) must guard before
    passing the value to the DSL.

  **Also removes `mapResponseToError` from the public API.**

  This helper was exported from `@1c-odata/client` but never listed in `STABILITY.md`.
  It is now `@internal` — still used by the library's transport internally, but no
  longer part of the documented surface. The 1С platform-specific error decision
  tree (500+code"-1" → `BusinessError`, 401 → `PermissionError`, 412 →
  `ConcurrencyError`, etc.) is still applied automatically to every request; consumers
  catch the resulting typed `ODataError` subclass as before.

  If you imported `mapResponseToError` directly, replace it with a `try { ... } catch (e) { if (e instanceof BusinessError) ... }` flow at the call site.

## 0.1.0

### Minor Changes

- [#2](https://github.com/hacker-cb/1c-odata/pull/2) [`ee75158`](https://github.com/hacker-cb/1c-odata/commit/ee75158ff4e8b3b57fb1e17963ae1fc3621c42f8) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Initial public release. API is pre-1.0 and unstable — see [STABILITY.md](https://github.com/hacker-cb/1c-odata/blob/master/STABILITY.md) for the semver policy, public surface, and error / connection / codegen contracts.
