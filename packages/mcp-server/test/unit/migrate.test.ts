import { existsSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { migrationsFolder } from '../../src/store/migrate.js'

describe('migrationsFolder', () => {
  it('resolves to the committed drizzle dir that actually holds SQL migrations', () => {
    // Guards the bundled-vs-source path hazard: the pg (prod) migrate() path reads
    // this folder at runtime, and a wrong resolution (or a missing `files` entry)
    // would only surface as a prod boot failure otherwise.
    const dir = migrationsFolder()
    expect(existsSync(dir)).toBe(true)
    expect(readdirSync(dir).some((f) => f.endsWith('.sql'))).toBe(true)
  })
})
