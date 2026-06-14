---
"@1c-odata/client": minor
---

Fix the AccountingRegister `RegisterHelper` virtual-table methods, and add `$top` + per-call request options to every register FI.

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
