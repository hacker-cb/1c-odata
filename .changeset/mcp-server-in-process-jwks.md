---
'@1c-odata/mcp-server': patch
---

Fix JWT verification behind a reverse proxy without hairpin-NAT.

The resource server used to verify bearer tokens by fetching its own **public**
origin — first `${issuer}/.well-known/oauth-authorization-server`, then the
`jwks_uri` it advertises. In a single-host deploy the container often cannot
resolve or reach that origin (no hairpin-NAT / split-horizon DNS), so every
bearer check failed and OAuth mode was effectively dead.

The authorization server runs in the same process, so its signing keys are now
read in-process from better-auth instead of over the network. Public discovery is
unchanged — `/.well-known/*` still advertises the public `jwks_uri` that external
clients need. This also removes the URL-driven fetch, and with it the SSRF surface
that the `jwks_uri` origin-pin existed to contain.

No configuration change is required.
