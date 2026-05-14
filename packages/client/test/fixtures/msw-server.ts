import type { RequestHandler } from 'msw'
import { setupServer } from 'msw/node'

/**
 * Test-scoped MSW server. Tests register handlers via `server.use(...)` per case.
 * Reset between tests via vitest's `beforeEach` hook.
 */
export function createMswServer(...handlers: RequestHandler[]) {
  return setupServer(...handlers)
}
