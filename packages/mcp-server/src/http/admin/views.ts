// src/http/admin/views.ts
import { Eta } from 'eta'
import type { Response } from 'express'
import { type AppSection, appShell, authShell } from '../../ui/shell.js'
import { TEMPLATES } from './templates.js'

/**
 * One process-wide Eta instance in string mode (autoEscape ON — base labels,
 * logins and 1С error strings are attacker-influenceable). We feed template
 * STRINGS (no views dir / file copy step): `compile` compiles + we cache the
 * compiled fns ourselves so each fragment compiles once.
 */
const eta = new Eta({ autoEscape: true })

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

/** Render a named fragment to an HTML string (partials can `include` other fragments via `it._r`). */
export function render(name: string, data: Record<string, unknown> = {}): string {
  return get(name)({ ...data, _r: render })
}

/** Full admin page: fragment wrapped in the app shell (top-bar nav). `active` highlights the current section. */
export function page(
  res: Response,
  view: string,
  data: Record<string, unknown>,
  title: string,
  active?: AppSection,
): void {
  res.type('html').send(appShell({ title, active, body: render(view, data) }))
}

/** Pre-auth page (e.g. the setup wizard): fragment wrapped in the centered-card shell — no nav. */
export function authPage(res: Response, view: string, data: Record<string, unknown>, title: string): void {
  res.type('html').send(authShell({ title, body: render(view, data) }))
}

/** Bare fragment — htmx swaps this into a target; no layout. */
export function partial(res: Response, view: string, data: Record<string, unknown>): void {
  res.type('html').send(render(view, data))
}
