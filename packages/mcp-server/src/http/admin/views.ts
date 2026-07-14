// src/http/admin/views.ts
import { Eta } from 'eta'
import type { Response } from 'express'
import { type AppSection, appShell, authShell, type NavUser } from '../../ui/shell.js'
import { TEMPLATES } from './templates.js'

/**
 * One process-wide Eta instance in string mode (autoEscape ON — base labels,
 * logins and 1С error strings are attacker-influenceable). We feed template
 * STRINGS (no views dir / file copy step): `compile` compiles + we cache the
 * compiled fns ourselves so each fragment compiles once.
 */
const eta = new Eta({ autoEscape: true })

/**
 * The IANA zone list for the base form's timezone <select>, computed once. A
 * server-rendered dropdown guarantees a valid `serverTimezone` (CLAUDE.md: it is
 * required with no default and a wrong value silently shifts DateTime parsing),
 * replacing the free-text input where a typo persisted a broken base. `Intl.
 * supportedValuesOf` is available on Node ≥ 22 (the package floor).
 *
 * `UTC` is prepended explicitly: `supportedValuesOf('timeZone')` omits it (and
 * `Etc/UTC`) on the runtimes we target, yet `saveBase`'s `isValidTimezone` accepts
 * it and the codebase's own configs/tests use it — so the select must offer it.
 */
const TIMEZONES: readonly string[] = ['UTC', ...Intl.supportedValuesOf('timeZone').filter((z) => z !== 'UTC')]

type RenderFn = (data: Record<string, unknown>) => string

const compiled = new Map<string, RenderFn>()

function get(name: string): RenderFn {
  let fn = compiled.get(name)
  if (fn === undefined) {
    const src = TEMPLATES[name]
    if (src === undefined) throw new Error(`unknown admin template "${name}"`)
    // Eta.compile → a render fn bound to this Eta instance (autoescape + config).
    fn = eta.compile(src).bind(eta) as RenderFn
    compiled.set(name, fn)
  }
  return fn
}

/**
 * Render a named fragment to an HTML string. Every fragment receives `_r` (to
 * include sub-fragments) and `timezones` (the base form's <select> options) —
 * both harmless where unused, so call sites don't thread them through.
 */
export function render(name: string, data: Record<string, unknown> = {}): string {
  // `data` spreads FIRST so the injected `timezones`/`_r` are fixed and a caller's
  // stray same-named field can't shadow them.
  return get(name)({ ...data, timezones: TIMEZONES, _r: render })
}

/**
 * Full admin page: fragment wrapped in the app shell (top-bar nav). `active`
 * highlights the current section. The signed-in identity for the nav's account
 * chip is read from `res.locals.navUser`, where the session gate stashed it —
 * call sites don't re-plumb it.
 */
export function page(
  res: Response,
  view: string,
  data: Record<string, unknown>,
  title: string,
  active?: AppSection,
): void {
  const user = (res.locals as { navUser?: NavUser }).navUser
  res.type('html').send(appShell({ title, active, body: render(view, data), ...(user !== undefined ? { user } : {}) }))
}

/** Pre-auth page (e.g. the setup wizard): fragment wrapped in the centered-card shell — no nav. */
export function authPage(res: Response, view: string, data: Record<string, unknown>, title: string): void {
  res.type('html').send(authShell({ title, body: render(view, data) }))
}

/** Bare fragment — htmx swaps this into a target; no layout. */
export function partial(res: Response, view: string, data: Record<string, unknown>): void {
  res.type('html').send(render(view, data))
}

/**
 * Error (or notice) response for htmx fragment endpoints: an OOB toast into the
 * app shell's `#flash` region. `HX-Reswap: none` suppresses the request's own
 * target swap (OOB fragments are still processed under swap "none"), so a 4xx/5xx
 * body can never corrupt the target — e.g. append an error <p> into a <tbody> or
 * outerHTML-delete a row whose DELETE actually failed.
 */
export function flash(res: Response, status: number, message: string, kind: 'err' | 'ok' = 'err'): void {
  res.status(status).setHeader('HX-Reswap', 'none').type('html').send(render('_flash', { kind, message }))
}

/**
 * Success response for a mutation whose target should swap to EMPTY (a set-password
 * form closing, a deleted row disappearing): the body is ONLY the OOB `#flash`
 * toast, so htmx strips the OOB node and the request's own swap (`innerHTML` /
 * `outerHTML`) receives '' — the form/row is removed AND the toast shows. Unlike
 * {@link flash} this sends NO `HX-Reswap: none` (200; the swap-to-empty is intended)
 * and always renders the `ok` kind.
 */
export function okFlashOob(res: Response, message: string): void {
  res.type('html').send(render('_flash', { kind: 'ok', message }))
}

/**
 * Response for a drawer form whose own swap target is a table (not the drawer):
 * send an OOB empty `#drawer-body` (admin.js then closes the drawer) plus an OOB
 * toast. Used for success (set-password; create/edit add their row fragment ahead
 * of this chrome) AND for an error that fires while the drawer is open — a plain
 * {@link flash} would render the toast behind the dialog's top layer, invisible, so
 * the drawer must be closed first for the message to show. `kind` defaults to `ok`.
 */
export function closeDrawer(res: Response, message: string, kind: 'ok' | 'err' = 'ok'): void {
  res.type('html').send(render('_drawer_close') + render('_flash', { kind, message }))
}

/**
 * Validation-error response for an OPEN drawer form: re-render the form (named by
 * `form`) OOB into `#drawer-body` with its inline `error`, at 400. The error must
 * show INSIDE the drawer — a #flash toast sits behind the dialog's top layer and
 * would be invisible. The body is OOB-only, so htmx strips it and the form's own
 * swap target (a table with beforeend/none) receives '' — the table is never
 * touched. `data` echoes the typed fields back (never a password).
 */
export function drawerFormError(res: Response, form: string, data: Record<string, unknown>): void {
  res
    .status(400)
    .type('html')
    .send(render('_drawer_form_oob', { ...data, _form: form }))
}
