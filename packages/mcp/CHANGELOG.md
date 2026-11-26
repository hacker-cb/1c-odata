# @1c-odata/mcp

## 0.10.0

### Patch Changes

- [#223](https://github.com/hacker-cb/1c-odata/pull/223) [`e57da5a`](https://github.com/hacker-cb/1c-odata/commit/e57da5ac51a9bfde50071c58ae5e83cee789c1ae) Thanks [@hacker-cb](https://github.com/hacker-cb)! - `V3QueryBuilder.count()` now sends the query's `$select` and `$expand` to `/$count` along with `$filter`. 1С counts the rows as it would roll them up by that `$select`: on a register virtual table in the path (`client.query('AccumulationRegister_X/Balance').select(…)`), where 1С does roll the rows up, the count now matches them — before, it left `$select` out and could be thousands of times the rows (234859 against 105 on one БП 3.0 turnovers). Where 1С returns the rows un-rolled (seen on production УТ 11.x bases), the count is the rolled-up number and below the rows — as `register(…)` virtual-table calls with `count: true` already counted. On an ordinary entity set the number is the same. `$orderby` / `$top` / `$skip` stay off the count, as before. A `$select` 1С rejects now fails `count()` as it fails `get()` (HTTP 400) — a navigation path in it needs its `expand()`, on the count as on the page — where before the count ignored it.

  The MCP `query` tool's `count` follows, and counts as `register_query` does; their descriptions now say that on a virtual table with `select` the count may be below the rows, to be paged while `hasMore` holds rather than by the count.

- [#219](https://github.com/hacker-cb/1c-odata/pull/219) [`edb8519`](https://github.com/hacker-cb/1c-odata/commit/edb85194362952e97d4b8169740a79c0db0e0956) Thanks [@hacker-cb](https://github.com/hacker-cb)! - A tool call the MCP client cancels (`notifications/cancelled`) now aborts its HTTP requests to 1С. `query` (its page and the parallel `/$count`), `get_entity`, `count` and `register_query` (its page and the table's `/$count`) hand the MCP request's abort signal to every request they make, so a cancelled heavy call (say, a big `register_query`) drops its connections to 1С instead of holding them open to the end for a reply no one reads. Whether 1С stops computing a request whose connection dropped is up to the 1С server and the web server in front of it. Resolving the connection is left out: its `$metadata` download is shared by every call waiting on that connection, and one caller's cancel does not fail the others.

- [#221](https://github.com/hacker-cb/1c-odata/pull/221) [`7ef6791`](https://github.com/hacker-cb/1c-odata/commit/7ef6791a9e6bd27390b56ef04c6a3624c3177acc) Thanks [@hacker-cb](https://github.com/hacker-cb)! - `register_query` no longer drops rows on a guess, and neither tool pages on a page it cannot place. Where 1С ignores `$top` and sends, at a `skip`, exactly as many rows as it counted, `register_query` took them for the whole table (`$skip` ignored too) and returned the rows from `skip` on — but a count short of the rows (a `select` 1С counts rolled up and returns un-rolled) looks the same, and then the rows asked for were dropped. `register_query` now places its pages as `query` does: a page past `top` is cut to `top` from its start, and a page at a `skip` holding exactly as many rows as 1С counted — or, past `top`, more — is ambiguous: `hasMore` is `false` (the byte budget included), the summary names both readings and how to narrow instead, and its truncation hint no longer suggests paging with `skip`. Both tools: a page past `top` at a `skip` with more rows than counted no longer offers paging on (before, where 1С ignored `$skip` as well, each next `skip` returned the same first rows with `hasMore: true`). `register_query`: an empty page now ends the paging (`hasMore: false`) even where the parallel `/$count` reported more rows — before, it reported `hasMore: true` and a client paging by `returned` asked for the same page again. The response shape is unchanged; to read past an ambiguous page, narrow the call (`condition`, `period`, `filter`, `select` — or `filter` on `query`) so the rows fit in one page.

- Updated dependencies [[`7107749`](https://github.com/hacker-cb/1c-odata/commit/71077490251dd188f72fde6e28be5be50a69d6dc), [`e57da5a`](https://github.com/hacker-cb/1c-odata/commit/e57da5ac51a9bfde50071c58ae5e83cee789c1ae), [`7f48030`](https://github.com/hacker-cb/1c-odata/commit/7f48030e7156536b2f05afe469f721d866a4c7cf), [`b37d5e2`](https://github.com/hacker-cb/1c-odata/commit/b37d5e22700755823969638a2044a199bfa44bf9), [`b37d5e2`](https://github.com/hacker-cb/1c-odata/commit/b37d5e22700755823969638a2044a199bfa44bf9), [`b37d5e2`](https://github.com/hacker-cb/1c-odata/commit/b37d5e22700755823969638a2044a199bfa44bf9), [`b37d5e2`](https://github.com/hacker-cb/1c-odata/commit/b37d5e22700755823969638a2044a199bfa44bf9), [`b09961c`](https://github.com/hacker-cb/1c-odata/commit/b09961cb9fa556462bc95b2163bbdda00f297fb5), [`fdbd37c`](https://github.com/hacker-cb/1c-odata/commit/fdbd37c0ba36a9857a509dc2c89d989cb9eeda9b)]:
  - @1c-odata/client@0.10.0
  - @1c-odata/metadata@0.10.0

## 0.9.1

### Patch Changes

- [#209](https://github.com/hacker-cb/1c-odata/pull/209) [`8d973aa`](https://github.com/hacker-cb/1c-odata/commit/8d973aa5cf636d8d214bb1fbb99f9fe1e62d08d2) Thanks [@hacker-cb](https://github.com/hacker-cb)! - MCP `query` with `count: true` no longer sends `$inlinecount`. By the 1С 8.3.27 documentation `$inlinecount` makes 1С drop `$skip` / `$top`, so on a publication that behaves as documented `query` with `count` and `skip` would silently return the start of the collection as the page asked for. The tool now reads the page alone and the exact total from the set's `/$count` (same `$filter`) in a parallel request — as `register_query` does — and a failure of either fails the call and aborts the other. The page never holds more than `top` rows: one 1С sends past `top` (a publication ignoring `$top`) is cut back to `top`. A page that cannot be placed — past `top` without `count`, or at a `skip` with exactly as many rows as 1С counted (it ignored `$skip`, or counts short) — offers no paging on (`hasMore: false`), and the summary says why. An empty page always ends the paging, whatever the count says. The client's `withCount()` is unchanged; its JSDoc now names the documented caveat and the `.count()` alternative.

- Updated dependencies [[`5b7df24`](https://github.com/hacker-cb/1c-odata/commit/5b7df24d16b07d8c6775a589523c3ac09efdd67f), [`6c9aa0d`](https://github.com/hacker-cb/1c-odata/commit/6c9aa0dcb153d1ba3b6a308651d90c40685d688c), [`6dd16fe`](https://github.com/hacker-cb/1c-odata/commit/6dd16fe27544cd8fcf7d612a2773331a974d74dd), [`8d973aa`](https://github.com/hacker-cb/1c-odata/commit/8d973aa5cf636d8d214bb1fbb99f9fe1e62d08d2)]:
  - @1c-odata/client@0.9.1
  - @1c-odata/metadata@0.9.1

## 0.9.0

### Minor Changes

- [#187](https://github.com/hacker-cb/1c-odata/pull/187) [`28ddb8a`](https://github.com/hacker-cb/1c-odata/commit/28ddb8ae0d03ed02784b654645c544225e9660dd) Thanks [@hacker-cb](https://github.com/hacker-cb)! - **Breaking:** names and keys that reach a URL path are now checked, and what does not pass is an `InvalidArgumentError` before any request. Rejected now: an entity-set or function name in a function-import or register virtual-table call (`client.functions.X.Y`, `client.register(…)`, document `post()` / `unpost()`, MCP `register_query`) that is not a plain 1С metadata name (letters, digits, `_`) — including a name the caller already percent-encoded; a ValueStorage property that is not such a name; a string entity key that is not a GUID; a composite key that is empty, an array, or has a field name that is not a 1С name. Migration: pass the plain (Cyrillic) name, never a percent-encoded one; pass a string key only as a `Ref_Key` GUID; pass a composite key as an object whose field names are 1С names (e.g. `{ Recorder: '…guid…', LineNumber: '1' }`).

  Function-import and register virtual-table URLs encode the entity set and function name as one path segment each: a name carrying `/`, `?`, `#`, `%`, `(` or `..` — e.g. a `register` argument passed to MCP `register_query` — can no longer reach another path of the host with the connection's credentials, push `$top` into a URL fragment or address a single entity. Collection, key, `$count`, `create` and ValueStorage URLs reject an entity set that is empty, `.`, `..`, has such a `/`- or `\`-separated part outside its parentheses and quotes, or is not encodable (a lone surrogate); `create` now percent-encodes the set name like the other URLs. Entity keys get the same guard, reachable through MCP `get_entity` (which now checks the GUID shape in its schema) and every entity handle (get / patch / put / delete / ValueStorage). A string the URL encoder cannot take (a lone UTF-16 surrogate) in a query option, a function-import argument or a key value fails with `InvalidArgumentError` instead of a raw `URIError`. Cyrillic names are percent-encoded on the wire as before.

- [#199](https://github.com/hacker-cb/1c-odata/pull/199) [`1f23acd`](https://github.com/hacker-cb/1c-odata/commit/1f23acd3d1f12965fb6e70fa0b9c54f0c5e8c7b7) Thanks [@hacker-cb](https://github.com/hacker-cb)! - **Breaking:** MCP `register_query` pages on the 1С server: each call reads one page (`$skip` / `$top`) and, in a parallel request, the exact row count (the table's `/$count`), instead of fetching up to 100 001 rows and slicing the page out of them. `total` is now exact however large the result — the `totalCapped` field, its "capped at N rows" summary note and the `ONEC_MCP_MAX_REGISTER_ROWS` environment variable are removed. Migration: drop `ONEC_MCP_MAX_REGISTER_ROWS` from the server's environment (it is ignored now) and stop reading `totalCapped`; `total` and `pagination.hasMore` carry the same meaning as before, without the cap. The count and the page are two requests, so on data changing meanwhile they can briefly disagree; if the count request fails, the call fails. A page of a heavy table now costs about 9–11 s on 1С (measured on a БП 3.0 `AccountingRegister_Хозрасчетный/Turnovers()` of 235 000 rows) where every page used to cost about 24 s and 232 MB transferred; a small table answers in tens of milliseconds as before. Should a 1С publication ignore `$top`, the page is cut back to `top` rows (paged from `skip` when the whole table came back) and the summary says so. Where 1С counts a `select` as grouped but returns its rows ungrouped, the rows outrun `total`: from that page on `hasMore` follows full pages and the summary says the count is not the number of rows.

  `register_query` also takes an optional `orderBy` (`[{ field, dir? }]`, the same shape as `query`'s): it sorts on the 1С server, so with `top` it returns a top-N — e.g. the ten largest debit turnovers. Sorting costs 1С time on a big table. Without `orderBy` the rows come in 1С's own order, which stayed the same from page to page in tests but is not promised by 1С — pass `orderBy` over fields that identify a row when pages must not overlap or skip rows.

  The `register_query` description (and that of its `select`) no longer promises that `select` rolls the rows of an aggregating table up: whether 1С does depends on the 1С configuration — it does on БП 3.0 `AccountingRegister_Хозрасчетный` turnovers (e.g. 178 rows → 45 with a narrower `select`), it does not on УТ 11.5 `AccumulationRegister_ТоварыНаСкладах` balance, whose rows come back un-rolled for the caller to sum, with `total` (1С's count, rolled up) below the number of rows.

### Patch Changes

- [#197](https://github.com/hacker-cb/1c-odata/pull/197) [`29996ce`](https://github.com/hacker-cb/1c-odata/commit/29996ce439d8651d36480d5791a0bbb65b3fd97e) Thanks [@hacker-cb](https://github.com/hacker-cb)! - **Breaking:** `parseInZone` places a wall-clock time a daylight-saving switch touches by one rule, `Temporal`'s `'compatible'`: a time the zone passes twice (the clocks go back) is the EARLIER instant, and a time the zone skips (the clocks go forward) moves forward by the gap — `2018-11-04T00:30` in `America/Sao_Paulo` is now 01:30 that day, not 23:30 the day before; `2025-10-26T02:30` in `Europe/Berlin` is now 02:30 CEST, an hour earlier than before. Every `Edm.DateTime` read from 1С goes through it. A new third argument, `parseInZone(naive, zone, { disambiguation: 'reject' })`, refuses a skipped time with an `InvalidArgumentError` instead — and, unlike `Temporal`'s `'reject'`, still reads a time passed twice as the earlier instant (new public types `ParseInZoneOptions`, `ZoneDisambiguation`).

  **Breaking:** `parseInZone` rejects what names no real date-time with an `InvalidArgumentError` instead of rolling it over or failing with a raw `RangeError`: `2026-02-30` used to become `2026-03-02` and `24:00` the next day; a month `13`, a year `0000` and a string that is not `YYYY-MM-DDTHH:mm[:ss[.fff]]` (a space may stand for the `T`) fail the same way, as does an unknown timezone or none at all (`Intl` used to take the host's zone). Reading a response, a field the schema types `Edm.DateTime` with such a value — or with anything but a string or `null` — is a `ParseError` naming the field and the value, and only the exact empty date `0001-01-01T00:00:00` reads as `null` (any string starting with it did); a field only the schema-less heuristic took for a date stays the string it came as. Migration: catch `InvalidArgumentError` where you call `parseInZone` on input you do not control; a read (`query().get()`, `entity().get()`, …) that must survive a corrupt date in a typed field catches `ParseError`, or reads with `shape: { dateMode: 'string' }` and converts with `parseInZone` itself.

  Years `0001`–`0999` — 1С's dates go down to `0001`, and a typo such as `0202` for `2020` happens — now read and write correctly: `parseInZone` used to fail on them with a raw `RangeError`, failing the whole collection read, and `formatInZone` wrote the year without its leading zeros (`999-05-01T…`) into filters, function-import arguments and written entities. `formatInZone` rejects an invalid `Date` and one whose year in the zone falls outside `0001`–`9999` with an `InvalidArgumentError`, and accepts a `Date` from another realm (`node:vm`).

  MCP `register_query` uses the client's `disambiguation: 'reject'` for naive periods instead of a check of its own: a time a daylight-saving switch skips is still refused. Changed: a bare day whose midnight a switch skips starts at the switch itself (00:15 in `Asia/Kathmandu` on 1986-01-01) rather than always at 01:00 (still 01:00 in `America/Sao_Paulo`), a bare `periodTo` whose 23:59:59 a switch skips ends at the day's last real second (22:59:59 in `America/Nuuk` on 2024-03-30) instead of being refused, and a bare day the zone skips whole is refused with `Invalid ISO date`; a naive period whose time the clocks pass twice is the earlier instant in every zone (in `Europe/Berlin` it was the later one); a naive period with a year below 1000 is read instead of refused; and a period with an offset that falls outside the years 0001–9999 in the server's zone is refused with `Invalid ISO date` instead of failing later.

- Updated dependencies [[`496ab3d`](https://github.com/hacker-cb/1c-odata/commit/496ab3d631da878443a418b22958875889e0a23c), [`81ee92b`](https://github.com/hacker-cb/1c-odata/commit/81ee92b7885c2082b467558773743ecc7c9e49f0), [`29996ce`](https://github.com/hacker-cb/1c-odata/commit/29996ce439d8651d36480d5791a0bbb65b3fd97e), [`1f23acd`](https://github.com/hacker-cb/1c-odata/commit/1f23acd3d1f12965fb6e70fa0b9c54f0c5e8c7b7), [`28ddb8a`](https://github.com/hacker-cb/1c-odata/commit/28ddb8ae0d03ed02784b654645c544225e9660dd), [`59ace8d`](https://github.com/hacker-cb/1c-odata/commit/59ace8d4599602d21b65f416239f515a2c57f610), [`bc82f74`](https://github.com/hacker-cb/1c-odata/commit/bc82f740a603a3df4f20be876ab86d3a135c73fe)]:
  - @1c-odata/client@0.9.0
  - @1c-odata/metadata@0.9.0

## 0.8.0

### Minor Changes

- [#184](https://github.com/hacker-cb/1c-odata/pull/184) [`a2334fd`](https://github.com/hacker-cb/1c-odata/commit/a2334fd33035bd6f55b6ae5c8d477b9b116982c2) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Register virtual tables take `$select` and `$filter`. `ReadFiOptions` gains `select?: string[]` and `filter?: string`, honoured by every `RegisterHelper` virtual-table method (`balance`, `turnovers`, `balanceAndTurnovers`, `sliceFirst`, `sliceLast`, `drCrTurnovers`, `extDimensions`, `recordsWithExtDimensions`) and encoded like a collection query. On a virtual table `select` is also the grouping — 1С sums the resources over the selected dimensions only, so on the aggregating tables (`Balance`, `Turnovers`, `BalanceAndTurnovers`, `DrCrTurnovers`) e.g. `AccountingRegister_Хозрасчетный.Turnovers` for one account and month drops from 178 rows to 45 with six fields selected. `filter` is a raw OData expression on the resulting rows. MCP `register_query` takes the same `select` and `filter` parameters. Empty values send nothing; existing calls are unchanged.

### Patch Changes

- [#185](https://github.com/hacker-cb/1c-odata/pull/185) [`7432911`](https://github.com/hacker-cb/1c-odata/commit/7432911062c53652241da8f86d45b0358c6c7e56) Thanks [@hacker-cb](https://github.com/hacker-cb)! - IIS's `400 Bad Request — Invalid URL` page now gets its own message instead of the generic "no OData error envelope" text. Where a decoded path segment of the request is over 260 characters (http.sys `UrlSegmentMaxLength`, its default) the message names that limit and the usual cause — a register virtual table called with its parameters in the path, `…/Turnovers(StartPeriod=…,AccountCondition='…')`, where they all share one segment (about two GUIDs in a condition) — and points to `client.register(…)` (in the MCP server: `register_query`), which sends them in the query string with no such limit, or to splitting the condition over disjoint subsets. The MCP `query` tool's description and its virtual-table tip say the same; `register_query` is not affected by the limit.

- [#183](https://github.com/hacker-cb/1c-odata/pull/183) [`d717164`](https://github.com/hacker-cb/1c-odata/commit/d7171641b4eaa907d3b859b61ff9f554e2559aa4) Thanks [@hacker-cb](https://github.com/hacker-cb)! - `NetworkError` now names the underlying cause instead of undici's bare `fetch failed`: the code and text of `error.cause` are appended — `Network error: fetch failed (UNABLE_TO_GET_ISSUER_CERT_LOCALLY: unable to get local issuer certificate)`, `ENOTFOUND`, `ECONNREFUSED` — including the per-address errors of a multi-address connect failure, whose own message is empty. A certificate-trust failure also gets a hint to trust the issuing CA with `NODE_EXTRA_CA_CERTS` or the OS store with `NODE_USE_SYSTEM_CA=1`. The MCP server shows the same text, so `add_connection` (when it verifies a password) and every tool that reaches a base now say why it is unreachable. The original error stays in `error.cause`. README "Network configuration" documents `NODE_USE_SYSTEM_CA` and the MCP server's `env` block.

- [#186](https://github.com/hacker-cb/1c-odata/pull/186) [`2b3bdb4`](https://github.com/hacker-cb/1c-odata/commit/2b3bdb4da9de71e13da462a5d8f0764cb8ad32e3) Thanks [@hacker-cb](https://github.com/hacker-cb)! - MCP `register_query` reads a period without a timezone as the 1С server's time — the connection's `serverTimezone`, the same conversion the client applies to naive date-times in 1С responses. A naive date-time such as `"2026-01-01T00:00:00"` (or `"2026-01-01 00:00"`) is now accepted instead of rejected. **Behaviour change:** bare dates are now whole days in the server's timezone — `period` / `periodFrom` its start (00:00:00), `periodTo` its end (23:59:59), so `periodFrom: "2026-01-01"` + `periodTo: "2026-01-31"` is the whole of January. They used to mean UTC midnight, which for `Europe/Moscow` sent `StartPeriod=…T03:00:00` (losing the first three hours) and ended the range at 03:00 of its last day. To keep the old boundary, spell it with its zone: `"2026-01-01T00:00:00Z"`. Values with `Z` or an offset are read as before. Impossible dates (`2026-02-30`), times (`24:00`) and local times a daylight-saving switch skips are now rejected instead of silently shifted; the error message names the zone used.

- Updated dependencies [[`7432911`](https://github.com/hacker-cb/1c-odata/commit/7432911062c53652241da8f86d45b0358c6c7e56), [`d717164`](https://github.com/hacker-cb/1c-odata/commit/d7171641b4eaa907d3b859b61ff9f554e2559aa4), [`a2334fd`](https://github.com/hacker-cb/1c-odata/commit/a2334fd33035bd6f55b6ae5c8d477b9b116982c2)]:
  - @1c-odata/client@0.8.0
  - @1c-odata/metadata@0.8.0

## 0.7.0

### Minor Changes

- [#56](https://github.com/hacker-cb/1c-odata/pull/56) [`1a64c54`](https://github.com/hacker-cb/1c-odata/commit/1a64c54e3afb80436c9222cae5c994f9d620f969) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Refactor `@1c-odata/mcp` for multi-tenant reuse (prep for a remote multi-tenant host).

  - New `@1c-odata/mcp/internal` subpath exposing the reusable building blocks — `ConnectionPool`, the new `ConnectionSource`/`FileConnectionSource` seam, `ReadPool`, the read-only tool registrators (`registerSchemaTools`/`registerDataTools`/`registerServerInfoTool`), and the response-limit helpers. The connection-management tools stay off this surface (admin-only).
  - `ConnectionPool` now takes a `ConnectionSource` (where connections and secrets come from) instead of `{ dataDir }`; the local stdio server injects a `FileConnectionSource` (config.json + keychain) and is unchanged. The read-only tool registrators now accept a `ReadPool`.
  - The programmatic building blocks previously reachable from the `@1c-odata/mcp` root (`ConnectionPool`, `SecretStore`, `passwordEnvVar`, …) moved to `@1c-odata/mcp/internal`; the root now exposes only the local-server entry (`createMcpServer`, `runServe`) and config/data-dir helpers. No CLI, MCP-tool, or on-disk contract changed.

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

### Patch Changes

- [#177](https://github.com/hacker-cb/1c-odata/pull/177) [`6be6fc6`](https://github.com/hacker-cb/1c-odata/commit/6be6fc624b570c098b79a856ef8d48518840723e) Thanks [@hacker-cb](https://github.com/hacker-cb)! - `--data-dir` and `ONEC_MCP_DATA_DIR` now accept a path starting with the home
  directory — a bare `~`, `~/…`, or on Windows also `~\…` — and `resolveDataDir`
  expands it via `os.homedir()`. MCP clients launch `serve` without a shell, so a
  `~` in their `args` / `env` used to reach the server literally and fail as
  "not absolute". The expansion happens before the keychain namespace is hashed,
  so `~/x` and its absolute spelling share one directory and one set of stored
  passwords. `~user/…` and `$HOME` are still not expanded and still fail, now
  with a hint saying which forms are.

  On Windows a drive-relative override such as `\onec` is now rejected: it passed
  the absolute-path check yet resolved against whichever drive the process
  started on, so the CLI and an MCP client could read different directories and
  keychain namespaces. Use a drive letter (`C:\onec`) or a UNC path. An unknown
  home directory on the default path now fails with the usual `resolveDataDir`
  error instead of a raw `os.homedir()` exception.

- [#58](https://github.com/hacker-cb/1c-odata/pull/58) [`bf78afc`](https://github.com/hacker-cb/1c-odata/commit/bf78afceb30cc89123e112f451a829e03930e57a) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Prep `@1c-odata/mcp/internal` for a DB-backed multi-tenant host. Additive only — no CLI, MCP-tool, on-disk, or local stdio behavior changed.

  - `SecretSource` gains a `'db'` variant so a DB-backed `ConnectionSource` can report the real password origin in `list_connections`. `SecretStore` itself never returns it (file/keychain/env only).
  - `@1c-odata/mcp/internal` now re-exports `verifyConnectivity` — the standalone `$metadata` reachability probe (no `dataDir` dependency), reused by a remote host to verify a base before saving it. The connection-management functions (`upsertConnection`/`removeConnection`/`updateConnectionCredentials`/`setConnectionLabel`) stay private — they are bound to the file-backed config.

- [#162](https://github.com/hacker-cb/1c-odata/pull/162) [`4c57cdb`](https://github.com/hacker-cb/1c-odata/commit/4c57cdba8e317db65074909ba268f0112bb0af1a) Thanks [@hacker-cb](https://github.com/hacker-cb)! - `@1c-odata/mcp/internal` re-exports for alternate hosts:

  - `assertValidConnectionName` / `isValidConnectionName`, so a DB-backed admin
    write path enforces the same ASCII connection-name rule as the file-backed
    store.
  - `InvalidArgumentError` (from `@1c-odata/client`), so a scoping wrapper throws
    the pool's canonical not-found error without a new dependency — an ungranted
    base is then byte-identical to a missing one.

- Updated dependencies [[`3146289`](https://github.com/hacker-cb/1c-odata/commit/3146289e4304b1ea5bf531be6a8496456c6cf228)]:
  - @1c-odata/client@0.7.0
  - @1c-odata/metadata@0.7.0

## 0.6.0

### Minor Changes

- [#52](https://github.com/hacker-cb/1c-odata/pull/52) [`fe30fdc`](https://github.com/hacker-cb/1c-odata/commit/fe30fdc3890b7ab99458567fb15eabbb64e23a6d) Thanks [@hacker-cb](https://github.com/hacker-cb)! - mcp: per-connection labels and credential-rotation tools

  - Connections now carry an optional human-readable `label` (free-form, may be Cyrillic). It is surfaced by
    `list_connections` and the CLI `list`, and falls back to the connection name when unset — so existing
    configs need no migration.
  - New `set_label` MCP tool and `1c-odata-mcp label <name> [label]` CLI command set or clear a connection's
    label (empty value reverts to the name). `add_connection` / `add --label` accept a label on creation.
  - New `set_credentials` MCP tool and `1c-odata-mcp set-credentials <name>` CLI command change a connection's
    login and/or password in place (together or separately), preserving its base URL, timezone and label. The
    change is verified against `$metadata` before being persisted when a password is available (the CLI also
    offers `--no-verify`), the password is keyed on the connection name (so a login change never orphans it),
    and no tool ever returns it.

- [#54](https://github.com/hacker-cb/1c-odata/pull/54) [`5b4df45`](https://github.com/hacker-cb/1c-odata/commit/5b4df45ec54f057514b8fc0ade82c9be1282d400) Thanks [@hacker-cb](https://github.com/hacker-cb)! - mcp: add a `server_info` tool

  New read-only `server_info` MCP tool reports the running server's version (the
  same value carried in the MCP `initialize` handshake, resolved from the
  package), the data directory holding config + credentials, and how many
  connections are configured. This makes the version answerable from within a
  conversation, not just from the host-level handshake / CLI `--version`. Never
  returns secrets.

### Patch Changes

- [#55](https://github.com/hacker-cb/1c-odata/pull/55) [`d90af38`](https://github.com/hacker-cb/1c-odata/commit/d90af38bfbccc6837fcd57c1d17940948094f259) Thanks [@hacker-cb](https://github.com/hacker-cb)! - mcp: print help on a bare CLI invocation instead of silently starting the server

  `1c-odata-mcp` with no subcommand now prints its help (the command list) instead
  of starting the stdio MCP server, which — when run by a human in a terminal —
  just hung waiting for JSON-RPC on stdin with no indication of what it was doing.
  The server is now reached only via the explicit `serve` subcommand, which is how
  MCP clients already launch it (`args: ["-y", "@1c-odata/mcp", "serve"]` — see the
  README). Standard client configs are unaffected; only a bare `1c-odata-mcp` used
  as a server entrypoint needs `serve` appended.

- Updated dependencies []:
  - @1c-odata/client@0.6.0
  - @1c-odata/metadata@0.6.0

## 0.5.0

### Minor Changes

- [#41](https://github.com/hacker-cb/1c-odata/pull/41) [`ea230be`](https://github.com/hacker-cb/1c-odata/commit/ea230be094c9deb3c93a5f7c7d95ba7d773346df) Thanks [@hacker-cb](https://github.com/hacker-cb)! - fix(mcp): isolate OS-keychain secrets per data directory

  This is a behavioral break (stored keychain secrets stop resolving — see below), so
  per the stability policy it ships as a minor bump in v0.x, not a patch.

  The keychain entry was keyed by a constant service name (`1c-odata`) plus the bare
  connection name, with no reference to the data directory — so two data dirs
  (separate projects/agents) that defined a connection with the same name shared one
  keychain secret: adding in one overwrote the other, removing deleted the other.
  `config.json` and `credentials.json` were already isolated per data dir; the
  keychain now matches them.

  The keychain service is now `1c-odata:<data-dir basename>:<first 8 hex of
sha256(canonical data dir)>` — the basename is a human-readable hint (visible in
  Keychain Access / Credential Manager) of which data dir a secret belongs to, the
  hash is the actual per-dir discriminator. The connection name stays the account.
  Two clients resolving the **same** data dir compute the same service and keep
  sharing (the agent-independent default-dir model is preserved); two **different**
  dirs isolate.

  **Behavior change — re-add passwords.** Secrets stored under the previous flat
  service are no longer found (no automatic migration). Re-add the password
  (`1c-odata-mcp add <name>`) or supply it via `ONEC_<NAME>_PASSWORD`. The non-secret
  `config.json`, the `credentials.json` file backend, and env-var passwords are
  unaffected.

### Patch Changes

- [#48](https://github.com/hacker-cb/1c-odata/pull/48) [`370921e`](https://github.com/hacker-cb/1c-odata/commit/370921ee855e48763c1d7c400827d5831f446cde) Thanks [@hacker-cb](https://github.com/hacker-cb)! - docs(mcp): document config locations, secrets, and custom-agent setup; clarify the add_connection name rule

  Expands the package README and adds an `@1c-odata/mcp` section to STABILITY.md:

  - Per-data-dir OS-keychain isolation and the service-name format
    (`1c-odata:<basename>:<8 hex of sha256(canonical data dir)>`, account = connection name),
    plus the no-migration / data-dir-move upgrade caveats.
  - The `ONEC_<NAME>_PASSWORD` slug rule, the connection-name charset, and the
    `-`/`_` env-var collision.
  - That an env-supplied password is verified but not persisted (must stay exported
    at `serve` time), and the non-TTY `add` behavior.
  - A `.mcp.json` `env`-block example and the lazy-load model for shipping a
    predefined connection set to a custom agent.
  - The 0600 `credentials.json` read refusal and the data-dir resolution order
    (relative paths throw).

  Also corrects the `add_connection` tool description to state the
  leading-alphanumeric connection-name rule the code enforces.

- Updated dependencies [[`bc33cc0`](https://github.com/hacker-cb/1c-odata/commit/bc33cc0733238ee241d3106b9854c78bf02fb62b)]:
  - @1c-odata/client@0.5.0
  - @1c-odata/metadata@0.5.0

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

- Updated dependencies [[`b187b01`](https://github.com/hacker-cb/1c-odata/commit/b187b014074601526a49928c74a3064feede3b12)]:
  - @1c-odata/client@0.4.1
  - @1c-odata/metadata@0.4.1

## 0.4.0

### Minor Changes

- [#25](https://github.com/hacker-cb/1c-odata/pull/25) [`5a47896`](https://github.com/hacker-cb/1c-odata/commit/5a478961d4e6d1c8f20a89a4a61d5ae75dff50c0) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Add `@1c-odata/mcp` — a read-only MCP (Model Context Protocol) server for 1С:Enterprise OData V3 bases, built on `@1c-odata/client` and `@1c-odata/metadata`.

  - **Schema tools**: `list_connections`, `list_entities` (filter by kind/name, paginated), `describe_entity` (properties, keys, navigation, value storages), `list_enums`, `refresh_metadata`.
  - **Data tools**: `query` (raw `$filter`/`$select`/`$expand`/`$orderby`, paging, optional count), `get_entity`, `count`, `register_query` (balance / turnovers / slices / accounting virtual tables, paginated via `top`/`skip`; the returned `total` is exact below the register-fetch cap, a `totalCapped` floor beyond it).
  - **Bounded output**: every read tool keeps its result within a configurable byte budget — large row sets are truncated to a usable sample (with `truncated`/`hasMore` and a nudge to narrow), and oversized individual fields (e.g. a base64 `ValueStorage`) are capped with a marker, so a single fat row or entity can't overflow it either. Opt-in `compact` additionally drops 1С `*_Type` / `@odata` annotation noise. `register_query` additionally caps the rows it fetches from a register FI (degrading to a `totalCapped` floor beyond the cap). Page size, byte budget, and register-fetch cap are env-configurable (`ONEC_MCP_DEFAULT_TOP`, `ONEC_MCP_MAX_TOP`, `ONEC_MCP_MAX_BYTES`, `ONEC_MCP_MAX_REGISTER_ROWS`); results serialize as compact JSON.
  - **Connection management** — CLI `1c-odata-mcp add`/`list`/`remove`/`test` (interactive no-echo password, or non-interactive via `--url`/`--login`/`--password-stdin`/env), plus MCP `add_connection`/`remove_connection` tools. Secrets resolve env → OS keychain (`@napi-rs/keyring`, optional) → `0600` file; no tool ever returns a password, and `config.json` carries none.
  - Works against any base at runtime via live `$metadata` (dynamic mode); read-only by design.

### Patch Changes

- Updated dependencies [[`70cef5e`](https://github.com/hacker-cb/1c-odata/commit/70cef5e9066422c15871874b47f79cb06efdc777), [`8a09e92`](https://github.com/hacker-cb/1c-odata/commit/8a09e92b7422e4e855b1b3e9bf726f61bcd53d9b), [`27c207a`](https://github.com/hacker-cb/1c-odata/commit/27c207a770b6969872db5f07b7a334574313a12a), [`4415ac4`](https://github.com/hacker-cb/1c-odata/commit/4415ac4dae057a5c5131aad18ddedc0a7ba738de), [`c48e6dc`](https://github.com/hacker-cb/1c-odata/commit/c48e6dcb661ddbd30a715f9292c36723fa900197), [`f065038`](https://github.com/hacker-cb/1c-odata/commit/f0650388106795f5754d2f77574cfee8d45f50f9), [`968a14e`](https://github.com/hacker-cb/1c-odata/commit/968a14e3c52e70026a1c4eae5336d63c0ca386b3), [`b1507e8`](https://github.com/hacker-cb/1c-odata/commit/b1507e8c98bba793527cfdb8a07059b06628f983)]:
  - @1c-odata/client@0.4.0
  - @1c-odata/metadata@0.4.0
