// @1c-odata/mcp — MCP server for 1С:Enterprise OData V3 (read-only).
//
// Programmatic entry point. The bin lives in `cli.ts`; this module exposes the
// pieces needed to embed or test the server.
export { configPath, loadConfig, type McpConfig, resolveDataDir, type StoredConnection, saveConfig } from './config.js'
export {
  ConnectionPool,
  type ConnectionPoolOptions,
  type ConnectionSummary,
  type PoolEntry,
} from './connection-pool.js'
export { passwordEnvVar, type SecretSource, SecretStore } from './secret-store.js'
export { type CreateServerOptions, createMcpServer, runServe } from './server.js'
