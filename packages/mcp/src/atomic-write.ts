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
 * replace an existing file, so on win32 a failed rename moves the target aside to
 * a backup first, renames the temp into place, and restores the backup if that
 * fails — so the original is never lost (a brief non-atomic window, win32-only).
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

/**
 * win32 fallback when `rename` won't overwrite an existing target: move the
 * target to a backup, rename the temp into place, then drop the backup. If the
 * second rename fails, restore the original from the backup so a failed write
 * never deletes the existing config/credentials.
 */
function replaceWin32(tmp: string, path: string): boolean {
  const backup = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.bak`
  try {
    renameSync(path, backup) // move the existing target aside (atomic)
  } catch {
    return false // couldn't back it up — leave the target intact, signal failure
  }
  try {
    renameSync(tmp, path)
    bestEffortUnlink(backup)
    return true
  } catch {
    // Restore the original; if even that fails, it survives as `backup`.
    bestEffortUnlink(path)
    try {
      renameSync(backup, path)
    } catch {
      // best effort — the original is still recoverable from the .bak sibling
    }
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
