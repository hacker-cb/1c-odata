// @1c-odata/mcp — MCP server for 1С:Enterprise OData V3 (read-only).
//
// Programmatic entry point for embedding or testing the LOCAL stdio server. The
// bin lives in `cli.ts`. Reusable building blocks for a multi-tenant host —
// the connection pool, its source seam, the tool registrators — live under
// the `@1c-odata/mcp/internal` subpath instead.
export { configPath, loadConfig, type McpConfig, resolveDataDir, type StoredConnection, saveConfig } from './config.js'
export { type CreateServerOptions, createMcpServer, runServe } from './server.js'
