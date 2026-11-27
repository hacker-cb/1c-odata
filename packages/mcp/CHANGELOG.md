# @1c-odata/mcp

## 0.11.1

### Patch Changes

- [#261](https://github.com/hacker-cb/1c-odata/pull/261) [`d3daa19`](https://github.com/hacker-cb/1c-odata/commit/d3daa19a13f42e5a91217ed80e6b88210e3f1a80) Thanks [@hacker-cb](https://github.com/hacker-cb)! - An agent can no longer route a connection's `ONEC_<NAME>_PASSWORD` to a server it chose through another MCP process. Every MCP process shares one data directory while the variable is set per process, and the guard from 0.11.0 looked only at its own process's environment: an agent in a process without the variable could re-point a connection (`add_connection` with `overwrite`, or `remove_connection` then `add_connection`) — or create a name nobody had added yet — and a process holding the variable then sent the password to that server. Now, whatever the process's environment:

  - `add_connection` never points an existing connection at another `baseUrl` or `login` — a person re-points one with the CLI `1c-odata-mcp add <name> --force`. An overwrite keeping both (a timezone, a label, a password) is taken as before.
  - A connection `add_connection` creates is marked `"addedBy": "agent"` in `config.json` and never takes its password from `ONEC_<NAME>_PASSWORD`, in any process: it uses a password given through `add_connection` / `set_credentials`, and `set_credentials` / `set-credentials` now take one for it even where the variable is set. The CLI `add` (also `--force`) writes no mark, so a person re-adding the connection makes the variable apply again. `list_connections` reports the mark as `addedBy: "agent"`, the CLI `list` as an `added by` line, and a missing password for such a connection says the variable is not used.

  `addedBy` is a new optional field of a `config.json` entry. An MCP process of an earlier version neither writes nor keeps it: update every MCP process sharing the data directory. Connections already in `config.json` count as added by a person.

- [#264](https://github.com/hacker-cb/1c-odata/pull/264) [`80a317c`](https://github.com/hacker-cb/1c-odata/commit/80a317ce75b2f2b285490a37d36e0a116927df52) Thanks [@hacker-cb](https://github.com/hacker-cb)! - A connection an agent added (`"addedBy": "agent"`) now reads only a password stored for its own server. Before, it read the stored password by name alone: an agent in an MCP process that could not delete a connection's keychain entry — no `@napi-rs/keyring`, `--insecure-storage`, a locked keychain — could `remove_connection` it and `add_connection` the name again pointing at its own server, and a process reading the keychain sent the person's password there. An agent's connection now stores its password under `<name>@<16 hex of sha256(base URL)>` — the keychain account and the `credentials.json` key — while a person's keeps `<name>`, so the person's password, and one stored for another server, are never read for it. A login change through `set_credentials` keeps it. A person re-adding the connection (CLI `add --force`) without a password clears what the agent stored. Connections a person added store their password as before.

- [#266](https://github.com/hacker-cb/1c-odata/pull/266) [`0894275`](https://github.com/hacker-cb/1c-odata/commit/0894275e316cab572778fe293b10989f30374f8d) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Overwriting a connection — `add_connection` with `overwrite`, the CLI `add --force` — no longer drops the `shape` stored for it in `config.json` (how Int64 and DateTime values come back, e.g. `int64Mode: "string"`). Neither command takes a shape, so the overwrite rebuilt the entry without it, and reads then silently returned Int64 values as `number` instead. An overwrite now keeps the stored shape, as it keeps the label, including when it re-points the connection.

- [#264](https://github.com/hacker-cb/1c-odata/pull/264) [`80a317c`](https://github.com/hacker-cb/1c-odata/commit/80a317ce75b2f2b285490a37d36e0a116927df52) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Stored passwords now resolve **env → `credentials.json` → OS keychain** (was env → keychain → file). A password written while the keychain refused it — a locked keychain, `add_connection` / `set_credentials` / CLI `add` / `set-credentials` — went to the `credentials.json` fallback, but an old keychain copy that could not be deleted outranked it once the keychain answered again; after a re-pointed connection the old password went to the new server. The same happened where another process sharing the data directory wrote the file (`--insecure-storage`, or no keychain backend) and never touched the keychain. The file holds a password only where the keychain refused the newest write — a write the keychain takes deletes the file copy, and fails where it cannot — so reading it first always reads the newest password; the keychain copy is deleted best-effort. A host without a working keychain (headless Linux / CI) still falls back to the file as before. One consequence: a `credentials.json` with permissions looser than `0600` (or malformed) is read, and refused, before the keychain, so it now stops keychain-stored passwords from resolving too — `chmod 600` it or delete it.

- [#266](https://github.com/hacker-cb/1c-odata/pull/266) [`0894275`](https://github.com/hacker-cb/1c-odata/commit/0894275e316cab572778fe293b10989f30374f8d) Thanks [@hacker-cb](https://github.com/hacker-cb)! - A connection named like a property every object inherits — `constructor`, `toString`, both valid names — is no longer mistaken for an existing connection while `config.json` is absent (or holds no `connections` object). Before, `remove_connection` and the CLI `remove` reported it removed, `set_label`, `set_credentials` and the CLI `set-credentials` "changed" it by writing `label` / `login` onto the global `Object`, the interactive CLI `add` asked whether to overwrite it, and a read went on with a function in place of its descriptor. Each now answers that there is no such connection, and the interactive `add` takes the name as a new one.

- Updated dependencies [[`687d1b4`](https://github.com/hacker-cb/1c-odata/commit/687d1b46b1a6e576ab0d6c8a81c57768cd4b833c)]:
  - @1c-odata/client@0.11.1
  - @1c-odata/metadata@0.11.1

## 0.11.0

### Patch Changes

- [#243](https://github.com/hacker-cb/1c-odata/pull/243) [`6d68d6a`](https://github.com/hacker-cb/1c-odata/commit/6d68d6a4035df02a696c7288f9be8450e8dcf348) Thanks [@hacker-cb](https://github.com/hacker-cb)! - MCP `add_connection` and `set_credentials` now stop when the MCP client cancels the call (`notifications/cancelled`): the `$metadata` download that verifies the credentials — 10+ MB on a big base — is aborted instead of running to its end, and a call cancelled before its write begins stores nothing — even one waiting for another call's write to the config. A write once begun completes, so the stored password and the config never disagree. `verifyConnectivity()` (from `@1c-odata/mcp/internal`) takes an optional `signal` for this.

- [#247](https://github.com/hacker-cb/1c-odata/pull/247) [`21890bb`](https://github.com/hacker-cb/1c-odata/commit/21890bbaea991880b54fdd0f8f47809937446581) Thanks [@hacker-cb](https://github.com/hacker-cb)! - **Security:** a password supplied through `ONEC_<NAME>_PASSWORD` can no longer be sent to a server an agent chose. The env password outranks a stored one on read, and an overwrite that changed a connection's base URL or login cleared only the stored one: MCP `add_connection` with `overwrite: true` and another `baseUrl` pointed the connection at that server, and the next read sent the env password there — as did `remove_connection` followed by `add_connection` under the same name. Now, while `ONEC_<NAME>_PASSWORD` is set: `add_connection` refuses to create a connection under that name (an agent cannot create one; a person adds it through the CLI `add`, which still may), `add_connection` with `overwrite` and the CLI `add --force` refuse to change its base URL or login, and every add refuses to store a password for it — reads would keep the env one (an overwrite keeping the target without a password — a label, a timezone — still goes through), and `set_credentials` / `set-credentials` refuse to change its credentials, which reads would not use (they reported `verified: true` for a pair the reads never sent). Each refusal is an `InvalidArgumentError` naming the variable, raised before any request — the env password reaches no new target, not even to verify. Migration: unset the variable before re-pointing or re-crediting such a connection, or add the new target under another name. An overwrite to the same target written differently (a trailing `/` in a hand-edited `config.json`) no longer clears the stored password, and a connection named after a property every object inherits (`constructor`) is no longer taken for an existing one. Re-pointing a connection without a new password now fails closed: where the OS keychain errors on deleting the old password (rather than finding none), the overwrite is refused and the config keeps the old target — before, the error was ignored, the new URL saved, and the old password, read again once the keychain answered, went to the new server. `--insecure-storage`, which never reads the keychain, stays best-effort there.

- [#248](https://github.com/hacker-cb/1c-odata/pull/248) [`23e31b2`](https://github.com/hacker-cb/1c-odata/commit/23e31b2c14e5a8d4de0608d6d7cfd44cf738d479) Thanks [@hacker-cb](https://github.com/hacker-cb)! - MCP `query` and `register_query` no longer end the paging on a full page that lands exactly on 1С's count. On a register virtual table with `select`, production УТ 11.x bases count the rows rolled up by the `select` and return them un-rolled, so the count is below the rows (seen on `AccumulationRegister_ТоварыНаСкладах` balance: a count of 921 with full pages still coming at `skip` 900; with `select: ["ВНаличииBalance"]` a count of 1). A full page with `skip + top` equal to that count answered `hasMore: false`, and a client paging by `hasMore` silently lost the rows past it. Now a full page always answers `hasMore: true`; an empty page ends the paging, and a short one does where the count agrees, as before. The price is one empty page where the rows really end on a page boundary.

- [#252](https://github.com/hacker-cb/1c-odata/pull/252) [`28e0df5`](https://github.com/hacker-cb/1c-odata/commit/28e0df56a4138cde32b7d6c9b9bb7b36f67aad65) Thanks [@hacker-cb](https://github.com/hacker-cb)! - MCP `query` and `register_query` now mark a page they cannot place with an optional `pagination.ambiguous` — before, only the summary text said so, and in `structuredContent` such a page read as an ordinary last one (the requested `skip`, rows that may be the table's first, `hasMore: false`), so a client reading only the structured result could join duplicates to the pages before it. `"skipIgnoredOrCountShort"`: at a `skip`, 1С sent as many rows as it counted (or, ignoring `$top`, more) — it either ignored `$skip` or counts fewer rows than it has (a `select` on a register virtual table, counted rolled up). `"skipUnverified"` (`query` only): at a `skip`, 1С ignored `$top` and no count was asked for, so whether it kept to `$skip` is unknown. A first page (no `skip`) where 1С ignored `$top` without a count is no longer taken for such a page: no `$skip` was sent, so its rows start at the first, and it now answers `hasMore: true` (rows past `top` came back) where it answered `false`. The field is present only on such a page, which ends the paging (`hasMore: false`); every other response is unchanged. The tool descriptions and a new README section on paging describe it.

- [#240](https://github.com/hacker-cb/1c-odata/pull/240) [`4826b7d`](https://github.com/hacker-cb/1c-odata/commit/4826b7dc555fc56d28ff4e96e6a3bb1a8a1c2494) Thanks [@hacker-cb](https://github.com/hacker-cb)! - `1c-odata-mcp serve` now exits once the MCP client closes its end of stdin (EOF, or the stream closing) — the shutdown signal of the MCP stdio transport. Before, the server never noticed: a call the client had abandoned kept its requests to 1С open until 1С answered, and the process stayed up meanwhile. Now the server closes, which aborts every tool call still running together with its requests to 1С (as a cancel does) and the connection pool's `$metadata` downloads in flight — those no single call's cancel aborts, being shared by every call waiting on the connection. A call still running when stdin ends gets no answer: a client that wants one waits for it before closing stdin. An error on stdin or stdout (the client gone mid-write) closes the server the same way and ends `serve` with that error and a non-zero exit code. `runServe()` now resolves when the server closes, as its documentation said, instead of right after it starts, and rejects with such a stream error. A server from `createMcpServer()` aborts its `$metadata` downloads in flight whenever a transport it is connected to closes, over any transport, and may be connected again after. `ConnectionPool` (from `@1c-odata/mcp/internal`) gains `abortDownloads()`, which aborts its `$metadata` downloads in flight and drops the entries still building, so the calls waiting on them fail and the next `get()` builds anew; entries already built stay.

- Updated dependencies [[`46a34c1`](https://github.com/hacker-cb/1c-odata/commit/46a34c1a9235262a03ddf957950cab88fa6732ae), [`f3d172d`](https://github.com/hacker-cb/1c-odata/commit/f3d172d131178aa0515f53eb943debe43ee14b71), [`aa0b7c9`](https://github.com/hacker-cb/1c-odata/commit/aa0b7c94ec502e24dd20c2d513385cd953c2fdae), [`815c221`](https://github.com/hacker-cb/1c-odata/commit/815c221cbf3e596039bb5c7a595c365bc8656a8d), [`e629dcc`](https://github.com/hacker-cb/1c-odata/commit/e629dccc502d43baf73d40ddaa2cb67726f9b24f), [`f79571c`](https://github.com/hacker-cb/1c-odata/commit/f79571c6aca37e8bc3f03c3d71545c9f87dadd61), [`f3d172d`](https://github.com/hacker-cb/1c-odata/commit/f3d172d131178aa0515f53eb943debe43ee14b71), [`f3d172d`](https://github.com/hacker-cb/1c-odata/commit/f3d172d131178aa0515f53eb943debe43ee14b71)]:
  - @1c-odata/client@0.11.0
  - @1c-odata/metadata@0.11.0

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
