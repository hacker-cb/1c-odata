---
"@1c-odata/client": minor
"@1c-odata/mcp": minor
---

Register virtual tables take `$select` and `$filter`. `ReadFiOptions` gains `select?: string[]` and `filter?: string`, honoured by every `RegisterHelper` virtual-table method (`balance`, `turnovers`, `balanceAndTurnovers`, `sliceFirst`, `sliceLast`, `drCrTurnovers`, `extDimensions`, `recordsWithExtDimensions`) and encoded like a collection query. On a virtual table `select` is also the grouping — 1С sums the resources over the selected dimensions only, so on the aggregating tables (`Balance`, `Turnovers`, `BalanceAndTurnovers`, `DrCrTurnovers`) e.g. `AccountingRegister_Хозрасчетный.Turnovers` for one account and month drops from 178 rows to 45 with six fields selected. `filter` is a raw OData expression on the resulting rows. MCP `register_query` takes the same `select` and `filter` parameters. Empty values send nothing; existing calls are unchanged.
