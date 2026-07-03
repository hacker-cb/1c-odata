// src/http/admin/views.ts
import { Eta } from 'eta'
import type { Response } from 'express'
import { ADMIN_CSS, LAYOUT, TEMPLATES } from './templates.js'

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
    const src = name === '_layout' ? LAYOUT : TEMPLATES[name]
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

/** Full page: fragment wrapped in the shared layout. For top-level GETs. */
export function page(res: Response, view: string, data: Record<string, unknown>, title: string): void {
  const body = render(view, data)
  res.type('html').send(render('_layout', { body, title, css: ADMIN_CSS }))
}

/** Bare fragment — htmx swaps this into a target; no layout. */
export function partial(res: Response, view: string, data: Record<string, unknown>): void {
  res.type('html').send(render(view, data))
}
