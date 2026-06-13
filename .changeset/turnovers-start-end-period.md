---
"@1c-odata/client": minor
---

Fix `RegisterHelper.turnovers()` / `balanceAndTurnovers()` sending the wrong period parameters to 1С.

Both helpers previously flattened a date range to `StartDate`/`EndDate`. The 1С AccumulationRegister `Turnovers` / `BalanceAndTurnovers` virtual tables only accept `StartPeriod`/`EndPeriod`, so every range query was rejected with HTTP 501 («Параметр EndDate не поддерживается»). They now send `StartPeriod`/`EndPeriod`. Verified live against УТ 11.1, УТ 11.5 and БП 3.0: the new params return 200, the old ones 501. (`StartDate`/`EndDate` belong to the AccountingRegister `drCrTurnovers()` / `recordsWithExtDimensions()` tables and are intentionally left untouched.)

**Breaking (type):** `TurnoversArgs.Period` is now an interval `{ from?: Date; to?: Date }` and no longer accepts a bare `Date`. Turnovers have no single-point form in 1С — there is no `Period` parameter on these tables, and a point query returned 501. The type forbids a bare `Date`; an untyped (JS) caller that still passes one now gets an `InvalidArgumentError` instead of a silent all-periods query. Migrate point usage to a range:

```diff
- client.register('AccumulationRegister_X').turnovers({ Period: someDate })
+ client.register('AccumulationRegister_X').turnovers({ Period: { from: someDate } })
```

`balance()` is unchanged — it correctly uses a single-point `Period`.
