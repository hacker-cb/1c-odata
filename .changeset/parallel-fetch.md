---
"@1c-odata/cli": patch
---

`1c-odata fetch` now downloads each target's `$metadata` concurrently (bounded to 4 in flight) instead of one base at a time. Fetching all targets previously paid the sum of every base's download latency; it now completes in roughly the slowest single base's time. Every target is still attempted when one fails (best-effort rather than stopping at the first error), and the first failure in target order is reported with its typed error identity (`HTTPError` / `PermissionError` / …) preserved.
