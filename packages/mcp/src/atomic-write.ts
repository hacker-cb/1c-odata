import { randomBytes } from 'node:crypto'
import { renameSync, unlinkSync, writeFileSync } from 'node:fs'

/**
 * Atomically write `content` to `path` at mode 0600: write a sibling temp file,
 * then rename it over the target. The temp file is removed on failure.
 *
 * The temp name is per-process AND random, and it is opened with the `wx` flag
 * (`O_CREAT | O_EXCL`): the write refuses a pre-existing file or symlink at that
 * path instead of following it, so an attacker who pre-plants a symlink in the
 * data dir can't redirect the write, and the 0600 mode always lands on a fresh
 * inode (a reused inode would keep its old, possibly too-open, mode).
 *
 * POSIX `rename` replaces the target atomically. Windows `rename` cannot always
 * replace an existing file, so on win32 a failed rename retries once after
 * unlinking the target (a brief non-atomic window, win32-only).
 */
export function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
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
