---
'@1c-odata/client': minor
'@1c-odata/metadata': minor
'@1c-odata/cli': minor
'@1c-odata/mcp': minor
'@1c-odata/mcp-server': minor
---

**Breaking:** the minimum supported Node version is now 24.18.0 (was 22.21.0).

Node 22 "Jod" has left active LTS and is in maintenance; Node 24 "Krypton" is
the active LTS line and is supported until 2028-04-30. Installing on Node 22
will now be refused or warned about by npm/pnpm, depending on your client.

No source change accompanies this. The library does not yet use any API that
Node 22 lacks — the floor moves so that the version CI exercises, the version
the published container image runs, and the version the packages advertise are
one and the same. Keeping the advertised floor below the tested one meant the
promise was never actually verified, which is the defect this closes.

`@types/node` is pinned to the matching major for the same reason: types
describing a runtime above the floor let an API that does not exist there
typecheck green and fail at runtime for anyone who installed at the advertised
minimum.

If you are pinned to Node 22, stay on the previous release until you can move —
v0.x carries no compatibility shims (see STABILITY.md).
