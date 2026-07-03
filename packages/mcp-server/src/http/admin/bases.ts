// src/http/admin/bases.ts

import type { StoredConnection } from '@1c-odata/mcp/internal'
import { assertValidConnectionName, verifyConnectivity } from '@1c-odata/mcp/internal'
import type { Request, Response } from 'express'
import { decrypt, encrypt } from '../../store/crypto.js'
import { BaseRepo, SecretRepo } from '../../store/repos.js'
import type { AdminDeps } from './router.js'
import { partial, render } from './views.js'

/** Coarse redaction: verifyConnectivity errors may echo a URL; keep only the class + status hint. */
function redact(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/https?:\/\/[^\s"']+/g, '<url>').slice(0, 200)
}

/** 401/403 from $metadata → auth_failed; anything else → unreachable. */
export function classifyProbe(err: unknown): { status: 'auth_failed' | 'unreachable'; message: string } {
  const msg = err instanceof Error ? err.message : String(err)
  const authy = /\b(401|403|unauthor|forbidden|credential|password)\b/i.test(msg)
  return { status: authy ? 'auth_failed' : 'unreachable', message: redact(err) }
}

/**
 * Re-render the form with an error. Never echoes the password back into the DOM.
 * On EDIT (`editName` set) the form submitted with hx-swap="none", so a plain
 * fragment would be swallowed — render the OOB wrapper that targets the stable
 * #base-form-slot instead, so the error is visible on both the new and edit forms.
 */
function reform(res: Response, body: Record<string, unknown>, error: string, editName?: string): void {
  const { password: _pw, ...safe } = body
  partial(res, editName !== undefined ? '_base_form_oob' : '_base_form', { ...safe, error })
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
    reform(res, req.body, `Invalid base name "${name}" — ASCII letters/digits/-/_ only.`, editName)
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
  await deps.db.transaction(async (tx) => {
    // drizzle's transaction handle is a valid query executor for the repos' insert
    // upserts, but its type lacks the `$client` field of the top-level `AuthDb`
    // union, so cast through `unknown`. Ordering: base row before secret row (FK).
    const txDb = tx as unknown as typeof deps.db
    await new BaseRepo(txDb).upsert(name, descriptor)
    if (password !== '') {
      await new SecretRepo(txDb).put(name, encrypt(deps.keyring, name, password))
    }
  })
  await deps.healthRepo.upsert(name, 'ok') // seed green; the job re-probes on its interval

  // Evict the process-global cache so the next tool call re-fetches $metadata with
  // the new URL/credentials. MUST be the SHARED pool, not a ScopedPool.
  deps.sharedPool.refresh(name)

  const hasSecret = password !== '' ? true : await deps.secretRepo.has(name)
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
