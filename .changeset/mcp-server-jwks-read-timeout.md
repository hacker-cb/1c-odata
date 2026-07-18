---
'@1c-odata/mcp-server': patch
---

Bound the JWKS read on the bearer-auth path.

Token verification shares a single in-flight read of the authorization server's
signing keys across every concurrent request. That read had no deadline, so a read
that *hung* — rather than failed — held every bearer check for the life of the
process, and none of the retry paths could run, because they all sit downstream of
that promise settling. A hang is reachable in a Postgres deploy: the connection
pool has no checkout deadline by default, so a saturated pool waits indefinitely,
and a lock can stall the query after checkout.

Each read now has a 5s deadline. Exceeding it frees the waiting requests and clears
the shared promise, so the next request retries; on the max-age refresh path the
timeout is absorbed and the last good key set keeps serving.

The deadline is per read, and one request can make two — an aged set whose refresh
times out, then a miss on a rotated-in key — so a single bearer check is bounded at
10s in that case rather than 5s.
