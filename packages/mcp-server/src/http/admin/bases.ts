// src/http/admin/bases.ts

import type { StoredConnection } from '@1c-odata/mcp/internal'
import { assertValidConnectionName, verifyConnectivity } from '@1c-odata/mcp/internal'
import type { Request, Response } from 'express'
import { decrypt, encrypt } from '../../store/crypto.js'
import { BaseRepo, SecretRepo } from '../../store/repos.js'
import type { AdminDeps } from './router.js'
import { partial, render } from './views.js'

/** Sentinel: a CREATE lost the uniqueness race inside the save transaction (rolled back). */
class DuplicateBaseError extends Error {
  constructor() {
    super('base name already exists')
  }
}

/** Coarse redaction: verifyConnectivity errors may echo a URL; keep only the class + status hint. */
function redact(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/https?:\/\/[^\s"']+/g, '<url>').slice(0, 200)
}

/** Auth-ish $metadata errors (401/403, or "unauthorized"/"forbidden"/"credential"/"password" wording) → auth_failed; anything else → unreachable. */
export function classifyProbe(err: unknown): { status: 'auth_failed' | 'unreachable'; message: string } {
  const msg = err instanceof Error ? err.message : String(err)
  // Word tokens are matched as prefixes/substrings, NOT `\b…\b`: a trailing word
  // boundary fails mid-word, so `\bunauthor\b` misses "Unauthorized" and
  // `\bcredential\b` misses "credentials" — both common. Keep `\b…\b` only around
  // the numeric codes so "401" doesn't match inside e.g. "14013".
  const authy = /\b(?:401|403)\b|unauthor|forbidden|credential|password/i.test(msg)
  return { status: authy ? 'auth_failed' : 'unreachable', message: redact(err) }
}

/**
 * Re-render the form with an error. Never echoes the password back into the DOM.
 * ALWAYS renders through the OOB wrapper targeting the stable #base-form-slot:
 * neither form's own swap target can host an error re-render (the edit form
 * submits hx-swap="none", the create form appends into #bases-tbody). The mode
 * flag is explicit — a create error must re-render a CREATE form even though the
 * typed `name` is present (see the _base_form template note).
 */
function reform(res: Response, body: Record<string, unknown>, error: string, editName?: string): void {
  const { password: _pw, ...safe } = body
  partial(res, '_base_form_oob', {
    ...safe,
    // The mode flag is derived from the ROUTE, never from the body: `...safe`
    // would otherwise let a tampered `edit` field in a create POST flip the
    // re-render into an hx-put edit form aimed at the existing base.
    edit: editName !== undefined,
    ...(editName !== undefined ? { name: editName } : {}),
    error,
  })
}

/** A well-formed IANA zone name, checked exactly as `@1c-odata/client`'s validateConnection does. */
function isValidTimezone(tz: string): boolean {
  if (tz === '') return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** Resolve the stored secret for `name` back to plaintext, or '' when absent/undecryptable. */
async function storedPassword(deps: AdminDeps, name: string): Promise<string> {
  const sealed = await deps.secretRepo.get(name)
  if (!sealed) return ''
  try {
    return decrypt(deps.keyring, name, sealed)
  } catch {
    return ''
  }
}

/** POST /admin/bases/verify — probe only, no persistence. */
export async function verifyBase(req: Request, res: Response, deps: AdminDeps): Promise<void> {
  const baseUrl = String(req.body.baseUrl ?? '').trim()
  const login = String(req.body.login ?? '').trim()
  let password = String(req.body.password ?? '')
  if (password === '' && typeof req.body.name === 'string' && req.body.name !== '') {
    password = await storedPassword(deps, String(req.body.name))
  }
  if (password === '') {
    partial(res, '_verify_result', { ok: false, error: 'password required' })
    return
  }
  try {
    await verifyConnectivity({ baseUrl, login, password })
    partial(res, '_verify_result', { ok: true })
  } catch (err) {
    partial(res, '_verify_result', { ok: false, error: redact(err) })
  }
}

/** Shared create/update. `editName` set on PUT (name is the path param, immutable). */
async function saveBase(req: Request, res: Response, deps: AdminDeps, editName?: string): Promise<void> {
  const name = editName ?? String(req.body.name ?? '')
  const baseUrl = String(req.body.baseUrl ?? '').trim()
  const login = String(req.body.login ?? '').trim()
  const password = String(req.body.password ?? '')
  const serverTimezone = String(req.body.serverTimezone ?? '').trim()
  const label = String(req.body.label ?? '').trim()

  try {
    assertValidConnectionName(name)
  } catch {
    reform(
      res,
      req.body,
      `Invalid base name "${name}" — must start with an ASCII letter or digit, then letters, digits, hyphens or underscores.`,
      editName,
    )
    return
  }

  // serverTimezone is REQUIRED with no default (CLAUDE.md): a wrong/blank zone
  // silently shifts DateTime parsing. Reject a blank or non-IANA value before any
  // persistence, mirroring the connection-name gate above.
  if (!isValidTimezone(serverTimezone)) {
    reform(
      res,
      req.body,
      `Invalid server timezone "${serverTimezone}" — use an IANA zone (e.g. "Europe/Moscow").`,
      editName,
    )
    return
  }

  // A CREATE must never silently overwrite an existing base: upsert() would
  // replace its URL/login/secret and the swap would append a DUPLICATE row (same
  // DOM id) to the table. This pre-check (after the free local validations, before
  // the network probe) catches the common case with a friendly error; the
  // transaction below re-enforces it atomically for the concurrent-create race.
  const duplicateError = `Base "${name}" already exists — use Edit on its row instead.`
  if (editName === undefined && (await deps.baseRepo.get(name)) !== undefined) {
    reform(res, req.body, duplicateError)
    return
  }

  // Determine the password to verify (and possibly store). On edit with a blank
  // field, reuse the stored secret so verify runs against the exact live pair.
  let verifyPassword = password
  if (verifyPassword === '' && editName !== undefined) {
    verifyPassword = await storedPassword(deps, name)
  }
  if (verifyPassword === '') {
    reform(res, req.body, 'Password required to verify before saving.', editName)
    return
  }

  // VERIFY FIRST — never persist an unverified credential pair.
  try {
    await verifyConnectivity({ baseUrl, login, password: verifyPassword })
  } catch (err) {
    reform(res, req.body, `Verification failed: ${redact(err)}`, editName)
    return
  }

  // Persist descriptor + (only if a new password was typed) the sealed secret,
  // atomically. Ordering: base row before secret row (FK).
  const descriptor: StoredConnection = {
    baseUrl,
    login,
    serverTimezone,
    ...(label !== '' ? { label } : {}),
  }
  try {
    await deps.db.transaction(async (tx) => {
      // drizzle's transaction handle is a valid query executor for the repos' insert
      // upserts, but its type lacks the `$client` field of the top-level `AuthDb`
      // union, so cast through `unknown`. Ordering: base row before secret row (FK).
      const txDb = tx as unknown as typeof deps.db
      const baseRepo = new BaseRepo(txDb)
      if (editName !== undefined) {
        await baseRepo.upsert(name, descriptor)
      } else if (!(await baseRepo.create(name, descriptor))) {
        // Concurrent create won the race after our pre-check — roll back rather
        // than overwrite (the atomic enforcement of the invariant above).
        throw new DuplicateBaseError()
      }
      if (password !== '') {
        await new SecretRepo(txDb).put(name, encrypt(deps.keyring, name, password))
      }
    })
  } catch (err) {
    if (err instanceof DuplicateBaseError) {
      reform(res, req.body, duplicateError)
      return
    }
    throw err
  }
  await deps.healthRepo.upsert(name, 'ok') // seed green; the job re-probes on its interval

  // Evict the process-global cache so the next tool call re-fetches $metadata with
  // the new URL/credentials. MUST be the SHARED pool, not a ScopedPool.
  deps.sharedPool.refresh(name)

  // A secret necessarily exists here: create (and edit-with-password) just stored
  // one, and the edit-with-blank path only passed the verify gate by successfully
  // loading the stored secret above — no extra query needed.
  const hasSecret = true
  if (editName !== undefined) {
    // htmx PUT swaps the row by id via an OOB fragment (hx-swap=none on the form).
    res.type('html').send(renderOob(name, { name, baseUrl, login, serverTimezone, hasSecret }))
    return
  }
  partial(res, '_base_row', { base: { name, baseUrl, login, serverTimezone, hasSecret } })
}

/** Out-of-band row replacement for edits (the form target is #bases-tbody with hx-swap=none). */
function renderOob(name: string, base: Record<string, unknown>): string {
  const row = render('_base_row', { base })
  return row.replace('<tr ', `<tr hx-swap-oob="outerHTML:#base-${name}" `)
}

export const createBase = (deps: AdminDeps) => (req: Request, res: Response) => saveBase(req, res, deps)
export const updateBase = (deps: AdminDeps) => (req: Request, res: Response) =>
  saveBase(req, res, deps, String(req.params.name))

export async function deleteBase(req: Request, res: Response, deps: AdminDeps): Promise<void> {
  const name = String(req.params.name)
  await deps.baseRepo.delete(name) // cascades to secret/grants/health
  deps.sharedPool.refresh(name)
  res.status(200).type('html').send('') // outerHTML swap removes the row
}
