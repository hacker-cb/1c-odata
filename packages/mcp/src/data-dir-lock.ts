import { randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

/**
 * Cross-process lock over a data directory (#269): every process sharing it —
 * MCP servers of different clients, the CLI — takes it around a whole
 * read-modify-write of `config.json` and the secrets that go with it.
 *
 * The lock is the file `<dataDir>/.lock`, created exclusively (`wx`) and holding
 * its owner — `{ pid, hostname, token, since }`. The owner refreshes its mtime
 * every {@link DataDirLockTimings.heartbeatMs} while it holds it, and deletes it
 * on release — only while the token in it is still its own.
 *
 * A lock is stale where its owner is gone: on this host (and, on Linux, in this
 * pid namespace), a pid that no longer runs; elsewhere, or where the file names
 * no owner, an mtime older than
 * {@link DataDirLockTimings.staleMs}. A live owner on this host is never judged
 * stale — a pid since reused by another process leaves the lock for a person to
 * delete, which the wait's error names. A stale lock is deleted only under a
 * second, short-lived lock — `<dataDir>/.lock.takeover` — and only after it is
 * read again and still judged stale there: a lock is never replaced while its
 * file is absent, so what is read under the takeover lock is what is deleted,
 * and two waiters never both take one lock.
 */

/** How long a lock is waited for, and when it counts as abandoned. Overridable for tests only. */
export interface DataDirLockTimings {
  /** Give up waiting after this long. */
  timeoutMs: number
  /** A lock whose owner cannot be checked (another host, unreadable) is stale once its mtime is this old. */
  staleMs: number
  /** The owner refreshes the lock's mtime this often. */
  heartbeatMs: number
}

export const DEFAULT_DATA_DIR_LOCK_TIMINGS: DataDirLockTimings = {
  timeoutMs: 10_000,
  staleMs: 60_000,
  heartbeatMs: 5_000,
}

/** The poll interval while waiting: starts here, doubles, and stops growing at {@link MAX_POLL_MS}. */
const FIRST_POLL_MS = 10
const MAX_POLL_MS = 250

/**
 * A takeover lock is held for a read and an unlink; one older than this was
 * left by a process that died in between, and is deleted.
 */
const TAKEOVER_STALE_MS = 5_000

/** Release retries a Windows sharing violation this many times, this far apart. */
const RELEASE_ATTEMPTS = 5
const RELEASE_RETRY_MS = 20

const LOCK_FILE = '.lock'
const TAKEOVER_SUFFIX = '.takeover'

/** Tokens of the locks this process holds or is taking: a lock naming this pid with any other token is abandoned. */
const heldHere = new Set<string>()

/** The owner a lock file names. */
interface LockOwner {
  pid: number
  hostname: string
  /** Linux: the owner's pid namespace — a container sharing the host name may not see its pid. */
  pidns?: string
  token: string
  since: string
}

/** This process's pid namespace on Linux (`pid:[4026531836]`), `undefined` elsewhere. */
const PID_NAMESPACE = (() => {
  if (process.platform !== 'linux') return undefined
  try {
    return readlinkSync('/proc/self/ns/pid')
  } catch {
    return undefined
  }
})()

/** The handle a task holds: {@link DataDirLock.assertHeld} before each write. */
export interface DataDirLock {
  /**
   * Throw where the lock is no longer this holder's — another process judged it
   * stale (this one stalled past {@link DataDirLockTimings.staleMs}) and took it.
   * Called right before each write, so a holder that lost the lock writes nothing more.
   */
  assertHeld(): void
}

/** Thrown where the data directory stays locked by another process past the wait. */
export class DataDirLockedError extends Error {
  readonly lockPath: string
  constructor(lockPath: string, owner: LockOwner | undefined) {
    const who =
      owner !== undefined ? `process ${owner.pid} on ${owner.hostname} since ${owner.since}` : 'another process'
    super(
      `The 1c-odata data directory is locked by ${who} — another 1c-odata-mcp is changing connections. Retry; if no such process runs, delete ${lockPath}.`,
    )
    this.name = 'DataDirLockedError'
    this.lockPath = lockPath
  }
}

/** The lock file of `dataDir`. */
export function dataDirLockPath(dataDir: string): string {
  return join(dataDir, LOCK_FILE)
}

/**
 * Run `task` holding the data-dir lock of `dataDir`, waiting for it up to
 * `timeoutMs`; `signal` aborts the wait (nothing has run then). The lock is
 * released however `task` ends.
 */
export async function withDataDirLock<T>(
  dataDir: string,
  task: (lock: DataDirLock) => Promise<T>,
  opts: { signal?: AbortSignal | undefined; timings?: Partial<DataDirLockTimings> } = {},
): Promise<T> {
  opts.signal?.throwIfAborted()
  const timings = { ...DEFAULT_DATA_DIR_LOCK_TIMINGS, ...opts.timings }
  const lockPath = dataDirLockPath(dataDir)
  const token = randomBytes(16).toString('hex')
  heldHere.add(token)
  try {
    await acquire(dataDir, lockPath, token, timings, opts.signal)
  } catch (err) {
    heldHere.delete(token)
    throw err
  }
  const heartbeat = setInterval(() => {
    // Refresh only a lock still this holder's: a lock taken over is another's to keep fresh, or to let go stale.
    if (stillHeld(lockPath, token)) touch(lockPath)
    else clearInterval(heartbeat)
  }, timings.heartbeatMs)
  heartbeat.unref()
  const lock: DataDirLock = {
    assertHeld() {
      if (stillHeld(lockPath, token)) return
      throw new Error(
        `The 1c-odata data-dir lock ${lockPath} was taken over by another process while this change ran (it stalled past ${timings.staleMs / 1000} s); nothing more was written. Check the connection and retry.`,
      )
    },
  }
  try {
    return await task(lock)
  } finally {
    clearInterval(heartbeat)
    heldHere.delete(token)
    release(lockPath, token)
  }
}

async function acquire(
  dataDir: string,
  lockPath: string,
  token: string,
  timings: DataDirLockTimings,
  signal: AbortSignal | undefined,
): Promise<void> {
  mkdirSync(dataDir, { recursive: true })
  const content = JSON.stringify({
    pid: process.pid,
    hostname: hostname(),
    ...(PID_NAMESPACE !== undefined ? { pidns: PID_NAMESPACE } : {}),
    token,
    since: new Date().toISOString(),
  } satisfies LockOwner)
  const deadline = Date.now() + timings.timeoutMs
  let poll = FIRST_POLL_MS
  for (;;) {
    signal?.throwIfAborted()
    if (tryCreate(lockPath, content)) return
    const held = readLock(lockPath)
    if (held !== undefined && isStale(held, timings) && takeOver(lockPath, timings)) continue
    // Gone between the create and the read — or not a file one can open (a dangling link): waited on like a held one.
    const left = deadline - Date.now()
    if (left <= 0) throw new DataDirLockedError(lockPath, held?.owner)
    await sleep(Math.min(poll, left), signal)
    poll = Math.min(poll * 2, MAX_POLL_MS)
  }
}

/**
 * Create `path` exclusively holding `content`; `false` where it already exists
 * (or, on Windows, is still being deleted). A create whose write fails removes
 * what it created: a lock never stands without its owner in it.
 */
function tryCreate(path: string, content: string): boolean {
  let fd: number
  try {
    fd = openSync(path, 'wx', 0o600)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST' || isBusy(err)) return false
    throw err
  }
  try {
    writeSync(fd, content)
  } catch (err) {
    closeSync(fd)
    bestEffortUnlink(path)
    throw err
  }
  closeSync(fd)
  return true
}

/** A lock file as read: its owner where it parses, and its mtime — both from one open file. */
interface HeldLock {
  owner: LockOwner | undefined
  mtimeMs: number
}

/**
 * The lock at `path`, or `undefined` where there is none (anymore). Its mtime
 * and text come from one descriptor, so they belong to the same file.
 */
function readLock(path: string): HeldLock | undefined {
  let fd: number
  try {
    // Non-blocking: a FIFO planted at the path must not hang the open.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    // Open elsewhere for a moment (Windows): held, owner unknown — waited on, never judged stale.
    if (isBusy(err)) return { owner: undefined, mtimeMs: Date.now() }
    throw unreadable(path, err)
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Error('not a regular file')
    return { owner: parseOwner(readFileSync(fd, 'utf8')), mtimeMs: stat.mtimeMs }
  } catch (err) {
    throw unreadable(path, err)
  } finally {
    closeSync(fd)
  }
}

function unreadable(path: string, err: unknown): Error {
  const reason = err instanceof Error ? err.message : String(err)
  return new Error(
    `Cannot read the 1c-odata data-dir lock ${path} (${reason}). If no 1c-odata-mcp is changing connections, delete it.`,
  )
}

/** The owner `raw` names, or `undefined` where it is not one (a lock still being written, a damaged file). */
function parseOwner(raw: string): LockOwner | undefined {
  try {
    const data = JSON.parse(raw) as Partial<LockOwner> | null
    if (
      data !== null &&
      typeof data === 'object' &&
      typeof data.pid === 'number' &&
      typeof data.hostname === 'string' &&
      typeof data.token === 'string' &&
      typeof data.since === 'string' &&
      (data.pidns === undefined || typeof data.pidns === 'string')
    ) {
      return {
        pid: data.pid,
        hostname: data.hostname,
        ...(data.pidns !== undefined ? { pidns: data.pidns } : {}),
        token: data.token,
        since: data.since,
      }
    }
  } catch {
    // not JSON (yet)
  }
  return undefined
}

function isStale(held: HeldLock, timings: DataDirLockTimings): boolean {
  const { owner } = held
  // Its pid is checkable only on this host, in this pid namespace.
  if (owner !== undefined && owner.hostname === hostname() && owner.pidns === PID_NAMESPACE) {
    // This process's own, under a token it no longer holds: a release that could not delete it.
    if (owner.pid === process.pid) return !heldHere.has(owner.token)
    return !isRunning(owner.pid)
  }
  return Date.now() - held.mtimeMs > timings.staleMs
}

/** Whether process `pid` runs on this host — signal 0 tests it, on Windows too. */
function isRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: it runs, under another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Delete the lock at `lockPath` where it is still stale, holding the takeover
 * lock while it reads and deletes it. `true` where the caller should try to
 * create its lock again at once; `false` — another process is taking over, wait.
 */
function takeOver(lockPath: string, timings: DataDirLockTimings): boolean {
  const guard = `${lockPath}${TAKEOVER_SUFFIX}`
  if (!tryCreate(guard, String(process.pid))) {
    const held = readLock(guard)
    if (held !== undefined && Date.now() - held.mtimeMs > TAKEOVER_STALE_MS) bestEffortUnlink(guard)
    return false
  }
  try {
    // Read again under the guard: only a takeover deletes another's lock, so what is read here is what is deleted.
    const held = readLock(lockPath)
    if (held !== undefined && isStale(held, timings)) unlinkSync(lockPath)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || isBusy(err)) return false
    throw err
  } finally {
    bestEffortUnlink(guard)
  }
}

/**
 * Whether the lock is still `token`'s. One that cannot be told apart for a
 * moment (busy on Windows, being rewritten) is read again; one still unclear
 * counts as held — only a lock read as another's, or gone, is lost.
 */
function stillHeld(lockPath: string, token: string): boolean {
  for (let attempt = 0; attempt < RELEASE_ATTEMPTS; attempt++) {
    const held = readLock(lockPath)
    if (held === undefined) return false
    if (held.owner !== undefined) return held.owner.token === token
    pause(RELEASE_RETRY_MS)
  }
  return true
}

/**
 * Delete the lock where it is still this holder's; never throws — it runs in a
 * `finally`. The read and the delete happen under the takeover lock, so no
 * takeover can replace the lock in between and have its new owner's deleted.
 * Where the guard stays taken (a takeover under way, a dead one's left), it
 * goes ahead without it rather than keep the lock.
 */
function release(lockPath: string, token: string): void {
  const guard = `${lockPath}${TAKEOVER_SUFFIX}`
  let guarded = false
  for (let attempt = 0; attempt < RELEASE_ATTEMPTS && !guarded; attempt++) {
    try {
      guarded = tryCreate(guard, String(process.pid))
    } catch {
      break
    }
    if (!guarded) pause(RELEASE_RETRY_MS)
  }
  try {
    for (let attempt = 0; attempt < RELEASE_ATTEMPTS; attempt++) {
      try {
        const held = readLock(lockPath)
        // Gone, or another's now (this process stalled past staleness): nothing of this holder's to delete.
        if (held === undefined || (held.owner !== undefined && held.owner.token !== token)) return
        if (held.owner !== undefined) {
          unlinkSync(lockPath)
          return
        }
        // Busy for a moment (Windows): read again.
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
        if (!isBusy(err)) return // unreadable: this process's next lock takes it over as its own
      }
      pause(RELEASE_RETRY_MS)
    }
  } finally {
    if (guarded) bestEffortUnlink(guard)
  }
}

function touch(lockPath: string): void {
  try {
    const now = new Date()
    utimesSync(lockPath, now, now)
  } catch {
    // Gone or unreachable: release reads what stands there.
  }
}

function bestEffortUnlink(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // already gone, or busy for a moment on Windows
  }
}

/** A Windows sharing violation: the file is open in another process, or being deleted, for a moment. */
function isBusy(err: unknown): boolean {
  if (process.platform !== 'win32') return false
  const code = (err as NodeJS.ErrnoException).code
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
}

/** Block for `ms` — release runs in a `finally` and stays synchronous. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    function onAbort(): void {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
