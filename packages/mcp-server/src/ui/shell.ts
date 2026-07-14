// src/ui/shell.ts
//
// The one design system for every server-rendered surface — the admin panel
// (app chrome: top-bar nav) and the pre-auth pages (sign-in, consent, first-run
// setup: a centered card, no nav). Both embed the SAME `BASE_CSS` token sheet, so
// the whole product reads as one identity in light and dark.
//
// Constraints this file lives under (see http/admin/middleware.ts + http/auth-mount.ts):
//   - CSP allows an inline <style> everywhere (style-src includes 'unsafe-inline'),
//     so the design system ships as one inline sheet — no external stylesheet, no
//     web font (system stacks only), no build step.
//   - Admin/setup CSP forbids inline <script> (script-src 'self'): the app shell
//     loads htmx from same-origin and the design is otherwise pure CSS. Only the
//     sign-in/consent pages (looser CSP: script-src 'self' 'unsafe-inline') pass an
//     inline `scripts` string to `authShell` for their client-side submit handlers.

/** Direction: "Enterprise calm" — light-first, humanist sans, soft cards, indigo accent. */
const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
:root{
  color-scheme:light dark;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
  --bg:#f5f6f9;--s1:#ffffff;--s2:#fbfbfd;--bd:#e7e9ee;--tx:#1a1e27;--mut:#616978;--faint:#98a0ae;
  --ac:#6d5cf0;--ac-tx:#5a48e0;--ac-bg:#ece9fd;--on-ac:#ffffff;
  --ok:#15a34a;--ok-bg:#e4f7ea;--warn:#c26a05;--warn-bg:#fbf0dc;--dg:#dc2f2f;--dg-bg:#fce7e7;
  --radius:9px;--card-r:14px;
  --shadow:0 1px 2px rgba(20,22,30,.06),0 6px 16px rgba(20,22,30,.06);
}
@media (prefers-color-scheme:dark){:root{
  --bg:#0f1117;--s1:#171a21;--s2:#1c2029;--bd:#272b35;--tx:#e8eaf0;--mut:#8b93a1;--faint:#5f6876;
  --ac:#8b7dff;--ac-tx:#a99eff;--ac-bg:#211d3c;--on-ac:#0e0b24;
  --ok:#34d07a;--ok-bg:#12291c;--warn:#e8a13a;--warn-bg:#2e2410;--dg:#f06b6b;--dg-bg:#341717;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.35);
}}
body{margin:0;background:var(--bg);color:var(--tx);font-family:var(--sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:var(--ac-tx)}
h1,h2,h3{letter-spacing:-.01em;color:var(--tx)}

/* ── app chrome: top-bar nav ── */
.app{min-height:100vh;display:flex;flex-direction:column}
.nav{display:flex;align-items:center;gap:4px;padding:11px 20px;background:var(--s1);border-bottom:1px solid var(--bd);flex-wrap:wrap}
.nav .brand{display:flex;align-items:center;gap:9px;margin-right:14px;text-decoration:none;color:var(--tx)}
.glyph{width:28px;height:28px;border-radius:8px;background:var(--ac);color:var(--on-ac);display:grid;place-items:center;font-family:var(--mono);font-weight:700;font-size:14px;flex:none}
.wordmark{font-weight:600;font-size:15px}.wordmark .dim{color:var(--mut);font-weight:400}
.nav a.link{font-size:13.5px;color:var(--mut);text-decoration:none;padding:7px 13px;border-radius:20px;transition:background .12s,color .12s}
.nav a.link:hover{background:var(--s2);color:var(--tx)}
.nav a.link.on{background:var(--ac-bg);color:var(--ac-tx);font-weight:500}
.navspacer{flex:1}
.nav .signout{margin:0}
.content{width:100%;max-width:64rem;margin:0 auto;padding:24px 20px 64px}

/* ── typography inside a page ── */
.content h1{font-size:20px;font-weight:600;margin:0 0 4px}
.content > p{color:var(--mut);margin:0 0 20px;font-size:13.5px}
.content > p.meta{font-family:var(--mono);font-size:12.5px}
.pagehead{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 16px}
.pagehead h1{margin:0}
.verify-ok{color:var(--ok);font-size:12.5px;margin-left:8px}

/* ── card (fieldset) ── */
fieldset{border:1px solid var(--bd);background:var(--s1);border-radius:var(--card-r);margin:0 0 18px;padding:16px 18px;box-shadow:var(--shadow)}
/* Float the legend to a full-width block title INSIDE the card. A bare <legend>
   straddles the top border, which collides with the rounded corner + shadow and
   reads as "detached". float+100% takes it out of that border-piercing mode and
   clears the fields below it. */
legend{float:left;width:100%;padding:0;margin:0 0 14px;font-weight:600;font-size:14px}

/* ── forms ── */
label{display:block}
fieldset label,.card label{margin:0 0 12px;font-size:12.5px;color:var(--mut)}
input,select,textarea{font:inherit;font-size:14px;color:var(--tx);background:var(--s2);border:1px solid var(--bd);border-radius:var(--radius);padding:9px 11px;transition:border-color .12s,box-shadow .12s}
fieldset input,fieldset select,.card input,.card select{display:block;width:100%;margin-top:5px}
input::placeholder{color:var(--faint)}
input:focus,select:focus,textarea:focus,button:focus-visible,a:focus-visible{outline:none;border-color:var(--ac);box-shadow:0 0 0 3px color-mix(in srgb,var(--ac) 24%,transparent)}
input[type=checkbox]{width:auto;display:inline-block;accent-color:var(--ac);cursor:pointer}
main form br{display:none}
/* input + inline buttons on one row (password fields with Generate/Copy) */
.fieldrow{display:flex;gap:7px;margin-top:5px}
.fieldrow input{flex:1;margin-top:0}
/* small "(you)" identity chip in the users table */
.you{display:inline-block;margin-left:7px;padding:1px 7px;border-radius:10px;background:var(--ac-bg);color:var(--ac-tx);font-size:11px;font-weight:500}
/* form action row (Save / Verify / Cancel + inline verify result) */
.formactions{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:4px}
/* empty-table placeholder cell */
td.empty{text-align:center;color:var(--mut);padding:22px 14px}
/* small print under a section (e.g. the grants write-scope note) */
.subtle{color:var(--faint);font-size:12px;margin:-8px 0 16px}

/* ── buttons ── */
button{font:inherit;font-size:13.5px;font-weight:500;padding:8px 14px;border-radius:var(--radius);cursor:pointer;border:1px solid var(--bd);background:var(--s1);color:var(--tx);display:inline-flex;align-items:center;gap:7px;transition:background .12s,border-color .12s,filter .12s}
button:hover{background:var(--s2);border-color:var(--faint)}
button:active{transform:translateY(.5px)}
.btn-primary{background:var(--ac);border-color:transparent;color:var(--on-ac)}
.btn-primary:hover{background:var(--ac);filter:brightness(1.06)}
.btn-danger{background:transparent;border-color:transparent;color:var(--dg)}
.btn-danger:hover{background:var(--dg-bg);border-color:transparent}
.btn-sm{padding:5px 10px;font-size:12.5px}
.btn-wide{width:100%;justify-content:center}
form.inline{display:inline}

/* ── table ── */
.tablecard{background:var(--s1);border:1px solid var(--bd);border-radius:var(--card-r);overflow:auto;box-shadow:var(--shadow)}
table{border-collapse:collapse;width:100%;font-size:13px}
thead th{text-align:left;font-family:var(--mono);font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--faint);font-weight:500;padding:10px 14px;background:var(--s2);border-bottom:1px solid var(--bd);white-space:nowrap}
tbody td{padding:10px 14px;border-bottom:1px solid var(--bd);vertical-align:middle}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover td{background:var(--s2)}
td select,td input{padding:4px 8px;font-size:12.5px}
.mono{font-family:var(--mono);font-size:12.5px}

/* ── inline status text (defined BEFORE the badge block so a .badge.ok keeps the badge size) ── */
.err{color:var(--dg);font-size:12.5px}
.ok{color:var(--ok);font-size:12.5px}

/* ── flash toasts (fixed OOB target #flash in the app shell; error fragments land
   here instead of the request's swap target, so a failure is always visible) ── */
#flash{position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:50;display:flex;flex-direction:column;gap:8px;pointer-events:none;width:max-content;max-width:min(92vw,480px)}
#flash .flash-msg{margin:0;padding:10px 14px;border-radius:var(--radius);font-size:13px;box-shadow:var(--shadow);border:1px solid;animation:flash-out .35s ease 6s forwards}
#flash .flash-msg.err{background:var(--dg-bg);border-color:color-mix(in srgb,var(--dg) 30%,transparent)}
#flash .flash-msg.ok{background:var(--ok-bg);border-color:color-mix(in srgb,var(--ok) 30%,transparent)}
@keyframes flash-out{to{opacity:0;visibility:hidden}}
@media (prefers-reduced-motion:reduce){#flash .flash-msg{animation:none}}

/* ── status badges (class == health status: ok / auth_failed / unreachable) ── */
.badge{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:11.5px;font-weight:500;padding:3px 9px;border-radius:20px}
.badge::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
.badge.ok{background:var(--ok-bg);color:var(--ok)}
.badge.auth_failed{background:var(--warn-bg);color:var(--warn)}
.badge.unreachable{background:var(--dg-bg);color:var(--dg)}
.badge.banned{background:var(--dg-bg);color:var(--dg)}
.badge.banned::before{animation:none}
.badge.unknown{background:var(--s2);color:var(--mut)}
.badge.ok::before{animation:pulse 1.8s ease-in-out infinite}
.badge.static::before{animation:none}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.badge.ok::before{animation:none}}

/* ── pre-auth surfaces: centered card, no nav ── */
.authwrap{min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding:56px 20px;
  background:radial-gradient(120% 70% at 50% -10%,color-mix(in srgb,var(--ac) 9%,var(--bg)),var(--bg) 62%)}
.card{width:100%;max-width:400px;background:var(--s1);border:1px solid var(--bd);border-radius:var(--card-r);padding:26px 24px;box-shadow:var(--shadow)}
.card .brand{display:flex;align-items:center;gap:9px;margin-bottom:18px}
.card h1,.card h2{font-size:19px;font-weight:600;margin:0 0 4px}
.card .hint{color:var(--mut);font-size:13px;margin:0 0 18px}
.card form{margin:0}
.card button{margin-top:4px}
.notice{font-size:12.5px;padding:9px 11px;border-radius:var(--radius);margin:0 0 16px;background:var(--warn-bg);color:var(--warn);border:1px solid color-mix(in srgb,var(--warn) 30%,transparent)}
.notice code{font-family:var(--mono);font-size:12px}
.clientid{font-family:var(--mono);font-size:12px;background:var(--s2);border:1px solid var(--bd);padding:2px 6px;border-radius:5px;color:var(--ac-tx)}
.scopes{list-style:none;padding:0;margin:6px 0 20px;display:flex;flex-direction:column;gap:7px}
.scopes li{display:flex;align-items:center;gap:9px;font-size:13px;padding:9px 11px;background:var(--s2);border:1px solid var(--bd);border-radius:var(--radius)}
.scopes code{font-family:var(--mono);font-size:12.5px}
.btn-row{display:flex;gap:9px;margin-top:4px}.btn-row button{flex:1;justify-content:center}
`

const HTMX_SRC = '/admin/assets/htmx.min.js'
const ADMIN_JS_SRC = '/admin/assets/admin.js'

/**
 * htmx 2.x by default does NOT swap 4xx/5xx responses — every error fragment the
 * admin handlers render (400 validation, 401 session-expired, 500 from the error
 * middleware) would vanish silently. Override `responseHandling` so error bodies
 * ARE processed; error responses then carry `HX-Reswap: none` + an OOB `#flash`
 * fragment (see views.flash), so only the toast updates — the request's own swap
 * target is left untouched (an empty-body outerHTML swap would delete it).
 */
const HTMX_CONFIG = `<meta name="htmx-config" content='{"responseHandling":[{"code":"204","swap":false},{"code":"[23]..","swap":true},{"code":"[45]..","swap":true,"error":true}]}'>`

/** Escape the few characters that could break out of an HTML text/attribute context. */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}

// Inline SVG favicon (data URI — no extra request, CSP-safe): the indigo "1c"
// brand mark, matching the nav glyph. `#6d5cf0` is --ac's light value.
const FAVICON = `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#6d5cf0"/><text x="16" y="22" font-family="ui-monospace,monospace" font-size="16" font-weight="700" fill="#fff" text-anchor="middle">1c</text></svg>',
)}">`

function head(title: string, extraHead = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — 1C OData MCP</title>
${FAVICON}${extraHead}
<style>${BASE_CSS}</style></head>`
}

const BRAND = `<span class="glyph">1c</span><span class="wordmark">1c-odata<span class="dim"> · mcp</span></span>`

/** The four admin sections, in nav order (shown to admins only). */
const NAV: { href: string; label: string; key: AppSection }[] = [
  { href: '/admin', label: 'Dashboard', key: 'dashboard' },
  { href: '/admin/bases', label: 'Bases', key: 'bases' },
  { href: '/admin/grants', label: 'Grants', key: 'grants' },
  { href: '/admin/users', label: 'Users', key: 'users' },
]

export type AppSection = 'dashboard' | 'bases' | 'grants' | 'users' | 'account'

/** The signed-in identity the top bar renders (email chip → /account, sign-out). */
export interface NavUser {
  email: string
  /** Admin sees the full section nav; a plain user only Account. */
  admin: boolean
}

export interface AppShellOptions {
  title: string
  /** Trusted, already-escaped fragment HTML (Eta-rendered). */
  body: string
  /** Highlights the current nav item. */
  active?: AppSection | undefined
  /** Renders the right-side account chip + sign-out; absent → sections only. */
  user?: NavUser | undefined
}

/**
 * Full admin page: top-bar nav + content. Loads htmx + the panel helpers
 * same-origin (admin CSP is `script-src 'self'`, so no inline script here).
 * `body` is a trusted fragment.
 */
export function appShell(opts: AppShellOptions): string {
  const sections = opts.user === undefined || opts.user.admin ? NAV : []
  const links = sections
    .map((n) => `<a class="link${n.key === opts.active ? ' on' : ''}" href="${n.href}">${n.label}</a>`)
    .join('')
  // The account chip is the ONE nav item every signed-in role gets. Sign-out is a
  // plain same-origin POST (CSRF-checked server-side); no JS needed.
  const account =
    opts.user === undefined
      ? ''
      : `<span class="navspacer"></span><a class="link${opts.active === 'account' ? ' on' : ''}" href="/account">${esc(opts.user.email)}</a>
<form method="post" action="/account/sign-out" class="signout"><button type="submit" class="btn-sm">Sign out</button></form>`
  return `${head(opts.title, `\n${HTMX_CONFIG}\n<script src="${HTMX_SRC}"></script>\n<script src="${ADMIN_JS_SRC}" defer></script>`)}
<body><div class="app">
<nav class="nav"><a class="brand" href="/admin">${BRAND}</a>${links}${account}</nav>
<div id="flash" aria-live="polite"></div>
<main class="content" id="main">${opts.body}</main>
</div></body></html>`
}

export interface AuthShellOptions {
  title: string
  /** Trusted, already-escaped card contents (heading, copy, form). */
  body: string
  /**
   * Optional inline client script. ONLY the sign-in/consent pages pass this — their
   * CSP allows `script-src 'unsafe-inline'`; the setup wizard (admin CSP) passes none.
   */
  scripts?: string
}

/**
 * A pre-auth page (sign-in / consent / first-run setup): one centered card on the
 * shared canvas, no admin nav. `body` fills the card after the brand mark.
 */
export function authShell(opts: AuthShellOptions): string {
  const script = opts.scripts !== undefined ? `\n<script>${opts.scripts}</script>` : ''
  return `${head(opts.title)}
<body><div class="authwrap"><div class="card">
<div class="brand">${BRAND}</div>
${opts.body}
</div></div>${script}</body></html>`
}
