import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Create a temporary project directory and return its absolute path.
 * Caller must call `cleanup()` to remove the directory after the test.
 */
export function createTmpProject(): { tmp: string; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), '1c-odata-cli-e2e-'))
  return {
    tmp,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  }
}
