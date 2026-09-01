import { pino } from 'pino'

/**
 * Process logger. Unlike the stdio MCP server (where stdout IS the protocol
 * channel and must stay clean), this server speaks HTTP, so stdout is free for
 * logs. Level via `ONEC_MCP_LOG_LEVEL` (default `info`).
 */
export const logger = pino({ level: process.env.ONEC_MCP_LOG_LEVEL ?? 'info' })
