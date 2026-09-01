---
"@1c-odata/mcp-server": minor
---

Publish an official multi-arch (`amd64` + `arm64`) container image to GHCR at
`ghcr.io/hacker-cb/1c-odata-mcp-server` on every release, tagged with the exact
version (`X.Y.Z`), the minor (`X.Y`), and `latest`. Run the Compose stack straight
from the image via the new `deploy/compose.prod.yml` overlay — no repo checkout or
build toolchain required. The image carries SLSA build provenance, matching the npm
packages.
