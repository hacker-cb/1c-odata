// src/http/admin/bases.ts

import type { StoredConnection } from '@1c-odata/mcp/internal'
import { assertValidConnectionName, verifyConnectivity } from '@1c-odata/mcp/internal'
import type { Request, Response } from 'express'
import { decrypt, encrypt } from '../../store/crypto.js'
import { BaseRepo, SecretRepo } from '../../store/repos.js'
import type { AdminDeps } from './router.js'
import { drawerFormError, partial, render } from './views.js'

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
 * ALWAYS renders through the OOB wrapper targeting the stable #drawer-body: neither
 * form's own swap target can host an error re-render (the edit form submits
 * hx-swap="none", the create form appends into #bases-tbody), and the error must
 * show INSIDE the open drawer (a #flash toast is hidden behind the dialog's top
 * layer). The mode flag is explicit — a create error must re-render a CREATE form
 * even though the typed `name` is present (see the _base_form template note).
 */
function reform(res: Response, body: Record<string, unknown>, error: string, editName?: string): void {
  const { password: _pw, ...safe } = body
  drawerFormError(res, '_base_form', {
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

/**
 * Drop any embedded `user:pass@` before persisting a base URL. A base password
 * belongs in the sealed secret, never in the stored `base_url` — a userinfo URL
 * would both leak the password (list view / list_connections) and be rejected by
 * ConnectionPool. Mirrors verifyConnectivity's internal stripping.
 */
function stripUserinfo(url: string): string {
  try {
    const u = new URL(url)
    if (u.username === '' && u.password === '') return url
    u.username = ''
    u.password = ''
    return u.toString()
  } catch {
    return url // not parseable — leave as-is; name/url validation elsewhere handles it
  }
}

/**
 * Cloud instance-metadata endpoints, which a probe must never reach: they answer
 * unauthenticated to anything running on the host and hand out cloud credentials, so
 * an admin pointing a "base" at one turns the probe into an SSRF exfiltration
 * channel. Matched on the URL host verbatim.
 *
 * Deliberately a POINTED denylist, not an allowlist or a private-range block:
 * admins legitimately host 1С on RFC1918 addresses and internal DNS names, so
 * blanket-blocking internal targets would break the product's normal case. This only
 * removes the endpoints that are never a 1С base under any topology.
 */
const METADATA_HOSTS = new Set([
  '169.254.169.254', // AWS IMDS / Azure IMDS / GCP / OpenStack / Oracle
  'fd00:ec2::254', // AWS IMDS over IPv6
  'metadata.google.internal', // GCP
  'metadata', // GCP's documented short alias (resolves via the GCE search domain)
])

/** An IPv4-mapped IPv6 host as the WHATWG parser serializes it: `::ffff:a9fe:a9fe`. */
const V4_MAPPED_HEX = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/
/** The dotted spelling of the same, in case a host reaches us un-normalized: `::ffff:169.254.169.254`. */
const V4_MAPPED_DOTTED = /^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/

/**
 * The URL host reduced to ONE spelling per address, so a single denylist entry can
 * match every way of writing it. The WHATWG parser already folds most variants for
 * us — decimal/octal IPv4 (`http://2852039166/`), an IPv4 trailing dot, IPv6
 * zero-expansion, and case — but two survive and are handled here:
 *   - a DNS name's root label (`metadata.google.internal.`), which the parser keeps, and
 *   - an IPv4-mapped IPv6 literal (`[::ffff:169.254.169.254]` → `::ffff:a9fe:a9fe`),
 *     which the kernel routes to the plain IPv4 address, so it must fold to it here.
 */
function canonicalHost(url: string): string | undefined {
  let host: string
  try {
    // `hostname` keeps IPv6 in brackets — strip them so a literal can match.
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return undefined // unparseable — the connectivity probe reports it far better
  }
  host = host.replace(/\.$/, '') // drop the DNS root label
  const hex = V4_MAPPED_HEX.exec(host)
  if (hex?.[1] !== undefined && hex[2] !== undefined) {
    const hi = Number.parseInt(hex[1], 16)
    const lo = Number.parseInt(hex[2], 16)
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
  }
  const dotted = V4_MAPPED_DOTTED.exec(host)
  return dotted?.[1] ?? host
}

/**
 * Reject a probe aimed at a cloud-metadata endpoint, returning the refusal message
 * (or undefined when the target is fine). Applied to the RESOLVED credential's URL,
 * so it covers both a caller-typed URL and a reused stored one.
 *
 * Not SSRF-proof by design: a host that merely RESOLVES to a metadata IP (a DNS name
 * an admin controls) is not caught — that would need resolution plus a
 * rebinding-safe re-check at connect time. The caller is an authenticated admin who
 * can already read the store, so this is defence-in-depth against misconfiguration
 * and casual abuse, not a hard boundary. What it does guarantee is that every
 * *spelling* of a listed address is refused, not just the canonical one.
 */
function blockedProbeTarget(url: string): string | undefined {
  const host = canonicalHost(url)
  return host !== undefined && METADATA_HOSTS.has(host)
    ? `Refusing to probe ${host} — cloud instance-metadata endpoints are not valid 1С bases.`
    : undefined
}

type ProbeCredential = { baseUrl: string; login: string; password: string }

/**
 * Resolve the (baseUrl, login, password) to probe. A typed password always
 * verifies against the request-supplied pair. A BLANK password reuses the base's
 * stored secret ONLY when the request's baseUrl+login still match the stored
 * descriptor — so a reused secret can never be sent to a caller-changed target,
 * which would exfiltrate a credential the panel is designed never to reveal.
 * Changing the URL/login therefore requires re-entering the password.
 */
async function resolveProbeCredential(
  deps: AdminDeps,
  name: string,
  reqBaseUrl: string,
  reqLogin: string,
  reqPassword: string,
): Promise<ProbeCredential | { error: string }> {
  if (reqPassword !== '') return { baseUrl: reqBaseUrl, login: reqLogin, password: reqPassword }
  if (name === '') return { error: 'Password required.' }
  const stored = await deps.baseRepo.get(name)
  const secret = await storedPassword(deps, name)
  if (stored === undefined || secret === '') return { error: 'Password required.' }
  if (reqBaseUrl !== stored.baseUrl || reqLogin !== stored.login) {
    return { error: 'Re-enter the password to verify a changed URL or login.' }
  }
  // Reuse the stored secret against the base's OWN stored pair — never the request's.
  return { baseUrl: stored.baseUrl, login: stored.login, password: secret }
}

/** POST /admin/bases/verify — probe only, no persistence. */
export async function verifyBase(req: Request, res: Response, deps: AdminDeps): Promise<void> {
  const baseUrl = String(req.body.baseUrl ?? '').trim()
  const login = String(req.body.login ?? '').trim()
  const reqPassword = String(req.body.password ?? '')
  const name = typeof req.body.name === 'string' ? req.body.name : ''
  const cred = await resolveProbeCredential(deps, name, baseUrl, login, reqPassword)
  if ('error' in cred) {
    partial(res, '_verify_result', { ok: false, error: cred.error })
    return
  }
  const blocked = blockedProbeTarget(cred.baseUrl)
  if (blocked !== undefined) {
    partial(res, '_verify_result', { ok: false, error: blocked })
    return
  }
  try {
    await verifyConnectivity(cred)
    partial(res, '_verify_result', { ok: true })
  } catch (err) {
    partial(res, '_verify_result', { ok: false, error: redact(err) })
  }
}

/**
 * The free, local-only form validations as one gate: the connection-name shape and
 * the IANA `serverTimezone` (REQUIRED with no default per CLAUDE.md — a wrong or
 * blank zone silently shifts DateTime parsing). Returns the refusal message, or
 * undefined when the input is well-formed. Both run before any query or probe.
 */
function validateBaseForm(name: string, serverTimezone: string): string | undefined {
  try {
    assertValidConnectionName(name)
  } catch {
    return `Invalid base name "${name}" — must start with an ASCII letter or digit, then letters, digits, hyphens or underscores.`
  }
  if (!isValidTimezone(serverTimezone)) {
    return `Invalid server timezone "${serverTimezone}" — use an IANA zone (e.g. "Europe/Moscow").`
  }
  return undefined
}

/**
 * The whole pre-persist gate: resolve which credential to probe, refuse a
 * cloud-metadata target, then actually verify connectivity. Returns the refusal
 * message, or undefined once the pair is verified — saving must NEVER persist an
 * unverified credential, so every early exit here aborts the save.
 */
async function verifyBeforeSave(
  deps: AdminDeps,
  name: string,
  baseUrl: string,
  login: string,
  password: string,
): Promise<string | undefined> {
  // A typed password verifies the request pair; a blank field reuses the stored
  // secret ONLY against the base's own stored URL+login (never a request-changed
  // target — that would exfiltrate it).
  const cred = await resolveProbeCredential(deps, name, baseUrl, login, password)
  if ('error' in cred) {
    return cred.error === 'Password required.' ? 'Password required to verify before saving.' : cred.error
  }
  // Refuse a cloud-metadata target BEFORE the probe. Saving always verifies first,
  // so this also keeps such a URL from entering the store THROUGH THE PANEL — but it
  // is not retroactive: a row written out-of-band (direct SQL) or before this guard
  // existed is still probed by the health job on its interval.
  const blocked = blockedProbeTarget(cred.baseUrl)
  if (blocked !== undefined) return blocked
  try {
    await verifyConnectivity(cred)
  } catch (err) {
    return `Verification failed: ${redact(err)}`
  }
  return undefined
}

/** Shared create/update. `editName` set on PUT (name is the path param, immutable). */
async function saveBase(req: Request, res: Response, deps: AdminDeps, editName?: string): Promise<void> {
  const name = editName ?? String(req.body.name ?? '')
  const baseUrl = String(req.body.baseUrl ?? '').trim()
  const login = String(req.body.login ?? '').trim()
  const password = String(req.body.password ?? '')
  const serverTimezone = String(req.body.serverTimezone ?? '').trim()
  const label = String(req.body.label ?? '').trim()

  const invalid = validateBaseForm(name, serverTimezone)
  if (invalid !== undefined) {
    reform(res, req.body, invalid, editName)
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

  // VERIFY FIRST — never persist an unverified credential pair.
  const failure = await verifyBeforeSave(deps, name, baseUrl, login, password)
  if (failure !== undefined) {
    reform(res, req.body, failure, editName)
    return
  }

  // Persist descriptor + (only if a new password was typed) the sealed secret,
  // atomically. Ordering: base row before secret row (FK). Strip any embedded
  // userinfo so the base password never lands in the stored base_url — and reuse
  // the SAME stripped value for the success-row render so the DOM matches the DB.
  const cleanBaseUrl = stripUserinfo(baseUrl)
  // Carry an existing DataShape override across an edit. The form never renders or
  // submits `shape`, so building the descriptor without it would upsert `shape: null`
  // and silently drop an override set out-of-band (SQL / import). A CREATE has no
  // prior row, hence no shape to preserve.
  const descriptor: StoredConnection = {
    baseUrl: cleanBaseUrl,
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
        // Carry an existing DataShape override across the edit: the form never renders
        // or submits `shape`, so upserting the form's descriptor alone would write
        // shape:null and silently drop an override set out-of-band (SQL / import).
        // Read it INSIDE the transaction so a concurrent write can't be lost between
        // the read and this upsert. A CREATE has no prior row, hence nothing to carry.
        const existingShape = (await baseRepo.get(name))?.shape
        await baseRepo.upsert(name, {
          ...descriptor,
          ...(existingShape !== undefined ? { shape: existingShape } : {}),
        })
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
  // loading the stored secret above — no extra query needed. health is 'ok': we
  // only reach persistence after verifyConnectivity resolved, and we just seeded it.
  const base = { name, baseUrl: cleanBaseUrl, login, serverTimezone, label, hasSecret: true, health: 'ok' }
  // On success the drawer closes (OOB) and a toast shows, for BOTH new and edit.
  const chrome = render('_drawer_close') + render('_flash', { kind: 'ok', message: `Base "${name}" saved.` })
  if (editName !== undefined) {
    // Edit form submits hx-swap="none" — the row updates via an OOB fragment.
    res.type('html').send(renderOob(name, base) + chrome)
    return
  }
  // Create form appends the row (beforeend); the empty-state placeholder hides
  // itself via CSS (:only-child) once a real row exists.
  res.type('html').send(render('_base_row', { base }) + chrome)
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
