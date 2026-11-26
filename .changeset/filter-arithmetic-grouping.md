---
"@1c-odata/client": patch
---

The filter DSL now writes every arithmetic operation (`add`, `sub`, `mul`, `div`) in its own parentheses. The old output of a chain gave the wrong order of operations: OData — and 1С — binds `mul`/`div` tighter than `add`/`sub`, so `f.Сумма.add(1).mul(2).eq(10)` was written `Сумма add 1 mul 2 eq 10` and computed `Сумма + 2`, silently selecting the wrong rows. It is now `((Сумма add 1) mul 2) eq 10`, computed in the order of the calls; an expression passed as the operand keeps its own grouping (`(Сумма mul (Сумма add 2))`). A single operation means the same as before — only its text gains the parentheses (`(Сумма add 5) gt 10`), so code comparing `toFilterString()` output to a fixed string needs updating.
