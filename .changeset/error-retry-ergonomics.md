---
"@1c-odata/client": patch
---

Error/retry ergonomics:

- **`ConcurrencyError` exposes the compared versions as structured fields.** The client-side optimistic-concurrency guard (`MutationOptions.expectVersion`) now populates `error.expectedVersion` and `error.actualVersion` instead of burying them in the message string, so callers can react to a conflict without parsing text. New `ConcurrencyErrorOptions` type. (Both fields are `undefined` on the rare path where a real HTTP 412 maps to this class.)
- **Export a ready-made `DEFAULT_RETRY_POLICY`.** Assembling a `RetryPolicy` previously meant spelling out all seven fields by hand. `DEFAULT_RETRY_POLICY` covers the common case — 3 retries of idempotent methods (`GET`/`PUT`/`DELETE`/`PATCH`; `POST` excluded) on `502`/`503`/`504` with exponential backoff + full jitter. Pass it as `retry`, or spread it to tweak a field (`{ ...DEFAULT_RETRY_POLICY, maxRetries: 5 }`). It is frozen, so a direct import cannot retune retries process-wide. Retries remain off unless a policy is supplied.
