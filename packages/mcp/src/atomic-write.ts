import { renameSync, unlinkSync, writeFileSync } from 'node:fs'

/**
 * Atomically write `content` to `path` at mode 0600: write a sibling temp file,
 * then rename it over the target. The temp file is removed on failure.
 *
 * POSIX `rename` replaces the target atomically. Windows `rename` cannot always
 * replace an existing file, so on win32 a failed rename retries once after
 * unlinking the target (a brief non-atomic window, win32-only).
 */
export function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 })
  try {
    renameSync(tmp, path)
  } catch (err) {
    if (process.platform === 'win32' && replaceWin32(tmp, path)) return
    bestEffortUnlink(tmp)
    throw err
  }
}

/** win32 fallback: drop the existing target, then rename the temp over it. */
function replaceWin32(tmp: string, path: string): boolean {
  try {
    bestEffortUnlink(path)
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}

function bestEffortUnlink(file: string): void {
  try {
    unlinkSync(file)
  } catch {
    // best effort — missing/locked file must not mask the original error
  }
}
