// src/store/db.ts
import { PGlite } from '@electric-sql/pglite'
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { Pool } from 'pg'
import * as schema from './schema.js'

/**
 * The Drizzle DB handle for better-auth's tables. Postgres dialect everywhere:
 * embedded PGlite for dev/tests, node-postgres (`pg.Pool`) for prod. Passing
 * `{ schema }` populates `db._.fullSchema`, which is exactly what the
 * `drizzleAdapter` falls back to when resolving each model — verified against
 * @better-auth/drizzle-adapter@1.6.23 dist/index.mjs
 * (`const schema = config.schema || db._.fullSchema`).
 */
export type AuthDb = ReturnType<typeof drizzlePglite<typeof schema>> | ReturnType<typeof drizzlePg<typeof schema>>

export type Dialect =
  | { kind: 'pglite'; dataDir?: string } // no dataDir → in-memory (memory://), one per process/test
  | { kind: 'pg'; connectionString: string }

export interface DbHandle {
  db: AuthDb
  /** The concrete driver, needed by migrate.ts to pick the pglite vs node-postgres migrator. */
  dialect: Dialect['kind']
  /** Release underlying resources: the pg pool, or the pglite client (in-memory or on-disk). */
  close(): Promise<void>
}

/** Build the Drizzle DB for the requested dialect. Both use `provider: "pg"` downstream. */
export function createDb(dialect: Dialect): DbHandle {
  if (dialect.kind === 'pglite') {
    const client = dialect.dataDir !== undefined ? new PGlite(dialect.dataDir) : new PGlite()
    const db = drizzlePglite(client, { schema })
    return {
      db,
      dialect: 'pglite',
      async close() {
        await client.close()
      },
    }
  }
  const pool = new Pool({ connectionString: dialect.connectionString })
  const db = drizzlePg(pool, { schema })
  return {
    db,
    dialect: 'pg',
    async close() {
      await pool.end()
    },
  }
}
