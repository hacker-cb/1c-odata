// src/http/admin/templates.ts
/* Inline Eta templates for the admin panel. String-mode (see views.ts). All data
 * interpolation is escaped `<%= %>`; `<%~ %>` (raw) is used ONLY to compose our
 * own trusted sub-fragments (`it._r(...)`), never for request data. Cyrillic labels
 * live safely in this UTF-8 `.ts`. */

export const ADMIN_CSS = `
:root{font-family:system-ui,sans-serif;line-height:1.4}
body{margin:0;color:#111}nav{background:#1e293b;padding:.6rem 1rem}
nav a{color:#e2e8f0;margin-right:1rem;text-decoration:none}nav a:hover{text-decoration:underline}
main{padding:1rem;max-width:60rem;margin:0 auto}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #cbd5e1;padding:.35rem .5rem;text-align:left}
th{background:#f1f5f9}.badge{padding:.1rem .5rem;border-radius:.4rem;font-size:.8rem;color:#fff}
.badge.ok{background:#16a34a}.badge.auth_failed{background:#d97706}.badge.unreachable{background:#dc2626}
.err{color:#dc2626}.ok{color:#16a34a}form.inline{display:inline}
input,select{padding:.25rem}button{padding:.3rem .7rem;cursor:pointer}
fieldset{border:1px solid #cbd5e1;margin:1rem 0;padding:1rem}
`

/** Full page wrapper. `it.body`/`it.css` are trusted (rendered fragment / static CSS). */
export const LAYOUT = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title><%= it.title %> — 1C OData MCP admin</title>
<script src="/admin/assets/htmx.min.js"></script>
<style><%~ it.css %></style>
</head><body>
<nav><a href="/admin">Dashboard</a><a href="/admin/bases">Bases</a><a href="/admin/grants">Grants</a><a href="/admin/users">Users</a></nav>
<main id="main"><%~ it.body %></main>
</body></html>`

export const TEMPLATES: Record<string, string> = {
  // ---- Dashboard ----
  dashboard: `<h1>Dashboard</h1>
<p><%= it.serverInfo %></p>
<table><thead><tr><th>Base</th><th>Status</th><th>Last check</th><th>Error</th></tr></thead>
<tbody id="health-tbody" hx-get="/admin/health/table" hx-trigger="load, every 10s" hx-swap="innerHTML"><%~ it._r('_health_rows', { rows: it.rows }) %></tbody></table>`,

  _health_rows: `<% for (const h of it.rows) { %><tr>
<td><%= h.baseName %></td>
<td><span class="badge <%= h.status %>"><%= h.status %></span></td>
<td><%= h.lastCheck %></td>
<td class="err"><%= h.error || '' %></td></tr><% } %>`,

  // ---- Bases ----
  bases_list: `<h1>Bases</h1>
<button hx-get="/admin/bases/new" hx-target="#base-form-slot" hx-swap="innerHTML">New base</button>
<div id="base-form-slot"></div>
<table><thead><tr><th>Name</th><th>URL</th><th>Login</th><th>TZ</th><th>Secret</th><th></th></tr></thead>
<tbody id="bases-tbody"><% for (const b of it.bases) { %><%~ it._r('_base_row', { base: b }) %><% } %></tbody></table>`,

  _base_row: `<tr id="base-<%= it.base.name %>">
<td><%= it.base.name %></td><td><%= it.base.baseUrl %></td><td><%= it.base.login %></td>
<td><%= it.base.serverTimezone %></td><td><%= it.base.hasSecret ? '✓' : '—' %></td>
<td>
<button hx-get="/admin/bases/<%= it.base.name %>/edit" hx-target="#base-form-slot" hx-swap="innerHTML">Edit</button>
<button hx-delete="/admin/bases/<%= it.base.name %>" hx-target="#base-<%= it.base.name %>" hx-swap="outerHTML" hx-confirm="Delete base <%= it.base.name %>? Cascades to its secret, grants and health.">Delete</button>
</td></tr>`,

  _base_form: `<form <%= it.name ? 'hx-put=/admin/bases/'+it.name : 'hx-post=/admin/bases' %> hx-target="#bases-tbody" hx-swap="<%= it.name ? 'none' : 'beforeend' %>">
<fieldset><legend><%= it.name ? 'Edit '+it.name : 'New base' %></legend>
<% if (it.error) { %><p class="err"><%= it.error %></p><% } %>
<label>Name <input name="name" value="<%= it.name || '' %>" <%= it.name ? 'readonly' : '' %> required></label><br>
<label>Base URL <input name="baseUrl" value="<%= it.baseUrl || '' %>" required></label><br>
<label>Login <input name="login" value="<%= it.login || '' %>" required></label><br>
<label>Password <input name="password" type="password" placeholder="<%= it.name ? '(unchanged)' : '' %>"></label><br>
<label>Server timezone <input name="serverTimezone" value="<%= it.serverTimezone || 'Europe/Moscow' %>" required></label><br>
<label>Label <input name="label" value="<%= it.label || '' %>"></label><br>
<button type="button" hx-post="/admin/bases/verify" hx-target="#verify-result" hx-swap="innerHTML" hx-include="closest form">Verify</button>
<button type="submit">Save</button>
<span id="verify-result"></span>
</fieldset></form>`,

  // Out-of-band re-render of the edit/new form into its stable slot. The edit form
  // submits with hx-swap="none" (its success path is an OOB row), so a validation
  // /verify error returned as a plain body would be swallowed — this OOB wrapper
  // targets #base-form-slot so the error re-renders on the form for BOTH new & edit.
  _base_form_oob: `<div id="base-form-slot" hx-swap-oob="innerHTML"><%~ it._r('_base_form', it) %></div>`,

  _verify_result: `<% if (it.ok) { %><span class="ok">✓ verified</span><% } else { %><span class="err">✗ <%= it.error %></span><% } %>`,

  // ---- Grants ----
  grants_editor: `<h1>Grants</h1>
<table><thead><tr><th>User</th><% for (const b of it.bases) { %><th><%= b %></th><% } %></tr></thead>
<tbody><% for (const u of it.users) { %><tr><td><%= u.email %></td>
<% for (const b of it.bases) { %><%~ it._r('_grant_cell', { sub: u.id, base: b, granted: it.matrix[u.id+'|'+b] !== undefined, scope: it.matrix[u.id+'|'+b] || 'read' }) %><% } %>
</tr><% } %></tbody></table>`,

  _grant_cell: `<td id="grant-<%= it.sub %>-<%= it.base %>">
<input type="checkbox" <%= it.granted ? 'checked' : '' %>
 hx-post="/admin/grants/toggle" hx-target="#grant-<%= it.sub %>-<%= it.base %>" hx-swap="outerHTML"
 hx-vals='{"sub":"<%= it.sub %>","base":"<%= it.base %>","granted":"<%= it.granted ? '' : 'on' %>","scope":"<%= it.scope %>"}'>
<select <%= it.granted ? '' : 'disabled' %>
 hx-post="/admin/grants/toggle" hx-target="#grant-<%= it.sub %>-<%= it.base %>" hx-swap="outerHTML"
 hx-vals='{"sub":"<%= it.sub %>","base":"<%= it.base %>","granted":"on"}' name="scope">
<option value="read" <%= it.scope==='read' ? 'selected' : '' %>>read</option>
<option value="write" <%= it.scope==='write' ? 'selected' : '' %>>write</option>
</select></td>`,

  // ---- Users ----
  users_list: `<h1>Users</h1>
<form hx-post="/admin/users" hx-target="#users-tbody" hx-swap="beforeend">
<fieldset><legend>Create user</legend>
<input name="email" type="email" placeholder="email" required>
<input name="name" placeholder="name">
<input name="password" type="password" placeholder="password" required>
<select name="role"><option value="user">user</option><option value="admin">admin</option></select>
<button type="submit">Create</button></fieldset></form>
<table><thead><tr><th>Email</th><th>Name</th><th>Role</th></tr></thead>
<tbody id="users-tbody"><% for (const u of it.users) { %><%~ it._r('_user_row', { user: u }) %><% } %></tbody></table>`,

  _user_row: `<tr id="user-<%= it.user.id %>">
<td><%= it.user.email %></td><td><%= it.user.name %></td>
<td><select hx-post="/admin/users/<%= it.user.id %>/role" hx-target="#user-<%= it.user.id %>" hx-swap="outerHTML" name="role">
<option value="user" <%= it.user.role==='user' ? 'selected' : '' %>>user</option>
<option value="admin" <%= it.user.role==='admin' ? 'selected' : '' %>>admin</option>
</select></td></tr>`,
}
