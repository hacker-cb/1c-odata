# syntax=docker/dockerfile:1
#
# Production image for @1c-odata/mcp-server. Build context is the REPO ROOT (the
# mcp-server build needs its workspace deps @1c-odata/client + @1c-odata/mcp), so
# build via the bundled compose.yml or:
#   docker build -f packages/mcp-server/deploy/Dockerfile -t onec-mcp .

# ── Builder: install the workspace, build, emit a self-contained deploy tree ────
FROM node:24-bookworm-slim AS builder
WORKDIR /repo
# corepack pins pnpm from the root package.json "packageManager" field.
RUN corepack enable
# Source only — node_modules/dist are .dockerignore'd, so the build is hermetic.
COPY . .
# Install (per-package `prepare` builds each dist/ topologically) then build
# explicitly for good measure (turbo-cached, so it's a no-op if prepare ran).
RUN pnpm install --frozen-lockfile
RUN pnpm turbo build
# Emit dist/ + drizzle/ + a resolved production node_modules (workspace deps
# injected, verified to run standalone) into /app.
RUN pnpm --filter @1c-odata/mcp-server deploy --prod --legacy /app

# ── Runtime: just Node + the deploy tree, unprivileged ──────────────────────────
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
# Static OCI labels so a local `docker compose --build` image is traceable and the
# GHCR package auto-links to the repo. CI (docker/metadata-action in
# release-image.yml) overrides the dynamic ones (version/revision/created) per release.
LABEL org.opencontainers.image.source="https://github.com/hacker-cb/1c-odata" \
      org.opencontainers.image.title="1c-odata-mcp-server" \
      org.opencontainers.image.description="Remote MCP server for 1С:Enterprise OData bases" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
COPY --from=builder /app ./
# The node image ships an unprivileged `node` user; drop root.
USER node
EXPOSE 3000
# `serve` reads the public URL / secrets / DATABASE_URL from env (see compose.yml).
# Bind all interfaces so the proxy on the compose network can reach it. ENTRYPOINT
# is the bin, so `docker compose run --rm mcp admin-create …` works too.
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve", "--host", "0.0.0.0", "--port", "3000"]
