// src/http/admin/templates.ts
/* Inline Eta templates for the admin panel — the fragments only; the page chrome
 * and the design system live in ../../ui/shell.ts (BASE_CSS + appShell/authShell).
 * String-mode (see views.ts). All data interpolation is escaped `<%= %>`; `<%~ %>`
 * (raw) is used ONLY to compose our own trusted sub-fragments (`it._r(...)`), never
 * for request data. Cyrillic labels live safely in this UTF-8 `.ts`. */

export const TEMPLATES: Record<string, string> = {
  // ---- Flash toast ----
  // OOB fragment targeting the app shell's fixed `#flash` region. Error responses
  // send ONLY this (with `HX-Reswap: none`), so the failure surfaces as a toast
  // while the request's own swap target stays untouched. `kind` ∈ err | ok.
  _flash: `<div id="flash" hx-swap-oob="innerHTML"><p class="flash-msg <%= it.kind %>"><%= it.message %></p></div>`,

  // ---- Dashboard ----
  dashboard: `<h1>Dashboard</h1>
<p class="meta"><%= it.serverInfo %></p>
<div class="tablecard"><table><thead><tr><th>Base</th><th>Status</th><th>Last check</th><th>Error</th></tr></thead>
<tbody id="health-tbody" hx-get="/admin/health/table" hx-trigger="load, every 10s" hx-swap="innerHTML"><%~ it._r('_health_rows', { rows: it.rows }) %></tbody></table></div>`,

  _health_rows: `<% for (const h of it.rows) { %><tr>
<td class="mono"><%= h.baseName %></td>
<td><span class="badge <%= h.status %>"><%= h.status.replace('_',' ') %></span></td>
<td class="mono"><%= h.lastCheck %></td>
<td class="err"><%= h.error || '' %></td></tr><% } %>`,

  // ---- Bases ----
  bases_list: `<div class="pagehead"><h1>Bases</h1>
<button class="btn-primary btn-sm" hx-get="/admin/bases/new" hx-target="#base-form-slot" hx-swap="innerHTML">New base</button></div>
<div id="base-form-slot"></div>
<div class="tablecard"><table><thead><tr><th>Name</th><th>URL</th><th>Login</th><th>TZ</th><th>Secret</th><th></th></tr></thead>
<tbody id="bases-tbody"><% for (const b of it.bases) { %><%~ it._r('_base_row', { base: b }) %><% } %></tbody></table></div>`,

  _base_row: `<tr id="base-<%= it.base.name %>">
<td class="mono"><%= it.base.name %></td><td class="mono"><%= it.base.baseUrl %></td><td class="mono"><%= it.base.login %></td>
<td class="mono"><%= it.base.serverTimezone %></td><td><%= it.base.hasSecret ? '✓' : '—' %></td>
<td>
<button class="btn-sm" hx-get="/admin/bases/<%= it.base.name %>/edit" hx-target="#base-form-slot" hx-swap="innerHTML">Edit</button>
<button class="btn-danger btn-sm" hx-delete="/admin/bases/<%= it.base.name %>" hx-target="#base-<%= it.base.name %>" hx-swap="outerHTML" hx-confirm="Delete base <%= it.base.name %>? Cascades to its secret, grants and health.">Delete</button>
</td></tr>`,

  // Mode is keyed on the EXPLICIT `it.edit` flag, never on `it.name` being set: an
  // error re-render of the CREATE form carries the typed name, and inferring the
  // mode from it would flip that re-render into an hx-put edit form — one click
  // away from overwriting the very base whose existence caused the error.
  _base_form: `<form <% if (it.edit) { %>hx-put="/admin/bases/<%= it.name %>"<% } else { %>hx-post="/admin/bases"<% } %> hx-target="#bases-tbody" hx-swap="<%= it.edit ? 'none' : 'beforeend' %>">
<fieldset><legend><%= it.edit ? 'Edit '+it.name : 'New base' %></legend>
<% if (it.error) { %><p class="err"><%= it.error %></p><% } %>
<label>Name <input name="name" value="<%= it.name || '' %>" <%= it.edit ? 'readonly' : '' %> required></label>
<label>Base URL <input name="baseUrl" value="<%= it.baseUrl || '' %>" required></label>
<label>Login <input name="login" value="<%= it.login || '' %>" required></label>
<label>Password <input name="password" type="password" placeholder="<%= it.edit ? '(unchanged)' : '' %>"></label>
<label>Server timezone <input name="serverTimezone" value="<%= it.serverTimezone || 'Europe/Moscow' %>" required></label>
<label>Label <input name="label" value="<%= it.label || '' %>"></label>
<button type="button" class="btn-sm" hx-post="/admin/bases/verify" hx-target="#verify-result" hx-swap="innerHTML" hx-include="closest form">Verify</button>
<button type="submit" class="btn-primary btn-sm">Save</button>
<span id="verify-result"></span>
</fieldset></form>`,

  // Out-of-band re-render of the edit/new form into its stable slot, used for EVERY
  // form-validation error. The edit form submits with hx-swap="none" (its success
  // path is an OOB row) and the create form targets #bases-tbody with beforeend —
  // in both cases a plain _base_form body would land in the wrong place (swallowed,
  // or appended INSIDE the table). htmx removes the OOB element from the fragment,
  // so the create form's beforeend swap gets nothing and only the slot re-renders.
  _base_form_oob: `<div id="base-form-slot" hx-swap-oob="innerHTML"><%~ it._r('_base_form', it) %></div>`,

  _verify_result: `<% if (it.ok) { %><span class="ok">✓ verified</span><% } else { %><span class="err">✗ <%= it.error %></span><% } %>`,

  // ---- Grants ----
  grants_editor: `<h1>Grants</h1>
<p>Toggle a base for a user, then pick read or write scope.</p>
<div class="tablecard"><table><thead><tr><th>User</th><% for (const b of it.bases) { %><th><%= b %></th><% } %></tr></thead>
<tbody><% for (const u of it.users) { %><tr><td class="mono"><%= u.email %></td>
<% for (const b of it.bases) { %><%~ it._r('_grant_cell', { sub: u.id, base: b, granted: it.matrix[u.id+'|'+b] !== undefined, scope: it.matrix[u.id+'|'+b] || 'read' }) %><% } %>
</tr><% } %></tbody></table></div>`,

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
  // `it.users` is a list of row bags: { user, self, created } (see users.rowData).
  users_list: `<h1>Users</h1>
<p>Sign-up is closed — provision users here.</p>
<div id="user-form-slot"></div>
<form hx-post="/admin/users" hx-target="#users-tbody" hx-swap="beforeend">
<fieldset><legend>Create user</legend>
<label>Email <input name="email" type="email" placeholder="name@example.com" required></label>
<label>Name <input name="name" placeholder="Full name"></label>
<label>Password <span class="fieldrow"><input id="create-user-pw" name="password" type="password" autocomplete="new-password" placeholder="Temporary password" minlength="8" required>
<button type="button" class="btn-sm" data-gen-password="#create-user-pw">Generate</button>
<button type="button" class="btn-sm" data-copy="#create-user-pw">Copy</button></span></label>
<label>Role <select name="role"><option value="user">user</option><option value="admin">admin</option></select></label>
<button type="submit" class="btn-primary btn-sm">Create user</button></fieldset></form>
<div class="tablecard"><table><thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Status</th><th>Created</th><th></th></tr></thead>
<tbody id="users-tbody"><% for (const row of it.users) { %><%~ it._r('_user_row', row) %><% } %></tbody></table></div>`,

  // Self-mutation is blocked in the UI (no Ban/Delete on your own row) AND
  // server-side; the role select stays enabled everywhere — demoting yourself is
  // legitimate when another admin exists (the last-admin guard is server-side).
  _user_row: `<tr id="user-<%= it.user.id %>">
<td class="mono"><%= it.user.email %><% if (it.self) { %> <span class="you">you</span><% } %></td>
<td><%= it.user.name %></td>
<td><select hx-post="/admin/users/<%= it.user.id %>/role" hx-target="#user-<%= it.user.id %>" hx-swap="outerHTML" name="role" aria-label="Role for <%= it.user.email %>">
<option value="user" <%= it.roleAdmin ? '' : 'selected' %>>user</option>
<option value="admin" <%= it.roleAdmin ? 'selected' : '' %>>admin</option>
</select></td>
<td><% if (it.user.banned) { %><span class="badge banned">banned</span><% } else { %><span class="badge ok static">active</span><% } %></td>
<td class="mono"><%= it.created %></td>
<td>
<button class="btn-sm" hx-get="/admin/users/<%= it.user.id %>/password" hx-target="#user-form-slot" hx-swap="innerHTML">Password</button>
<% if (!it.self) { %><% if (it.user.banned) { %>
<button class="btn-sm" hx-post="/admin/users/<%= it.user.id %>/unban" hx-target="#user-<%= it.user.id %>" hx-swap="outerHTML">Unban</button>
<% } else { %>
<button class="btn-sm" hx-post="/admin/users/<%= it.user.id %>/ban" hx-target="#user-<%= it.user.id %>" hx-swap="outerHTML" hx-confirm="Ban <%= it.user.email %>? Sign-in is blocked and their sessions are revoked.">Ban</button>
<% } %>
<button class="btn-danger btn-sm" hx-delete="/admin/users/<%= it.user.id %>" hx-target="#user-<%= it.user.id %>" hx-swap="outerHTML" hx-confirm="Delete <%= it.user.email %>? Their grants are removed. This cannot be undone.">Delete</button>
<% } %>
</td></tr>`,

  // Rendered into #user-form-slot. Success responds with ONLY an OOB ok-flash:
  // htmx strips the OOB node, so the slot's innerHTML swap gets '' — form closed,
  // toast shown. minlength mirrors better-auth's default password policy.
  _user_password_form: `<form hx-post="/admin/users/<%= it.id %>/password" hx-target="#user-form-slot" hx-swap="innerHTML">
<fieldset><legend>Set password — <%= it.email %></legend>
<% if (it.error) { %><p class="err"><%= it.error %></p><% } %>
<label>New password <span class="fieldrow"><input id="pw-<%= it.id %>" name="password" type="password" autocomplete="new-password" minlength="8" required>
<button type="button" class="btn-sm" data-gen-password="#pw-<%= it.id %>">Generate</button>
<button type="button" class="btn-sm" data-copy="#pw-<%= it.id %>">Copy</button></span></label>
<p class="hint">Saving revokes the user's existing sessions; hand the new password over out of band.</p>
<button type="submit" class="btn-primary btn-sm">Save password</button>
<button type="button" class="btn-sm" hx-get="/admin/ui/close" hx-target="#user-form-slot" hx-swap="innerHTML">Cancel</button>
</fieldset></form>`,

  // ---- Account (any signed-in role; served by the /account router) ----
  account_page: `<h1>Account</h1>
<p><span class="mono"><%= it.email %></span> · role <%= it.role %></p>
<form hx-post="/account/password" hx-swap="none">
<fieldset><legend>Change password</legend>
<label>Current password <input name="current" type="password" autocomplete="current-password" required></label>
<label>New password <span class="fieldrow"><input id="account-pw" name="password" type="password" autocomplete="new-password" minlength="8" required>
<button type="button" class="btn-sm" data-gen-password="#account-pw">Generate</button>
<button type="button" class="btn-sm" data-copy="#account-pw">Copy</button></span></label>
<p class="hint">Changing the password signs out your other sessions (this one stays).</p>
<button type="submit" class="btn-primary btn-sm">Change password</button>
</fieldset></form>`,

  // ---- First-run setup wizard ----
  // Rendered through `authShell` (centered card, no nav) via views.authPage. The body
  // is just the card contents — the brand mark comes from the shell. A plain (non-htmx)
  // form: it POSTs back to /setup carrying the token in a hidden field so the same-origin
  // submit re-presents it. `it.token` is the validated token (already matched against the
  // stored value) — escaped like all data. `it.email` is echoed back on a re-render after
  // a failed submit (never the password). `it.error` is a redacted, trusted message.
  setup_wizard: `<h1>First-run setup</h1>
<p class="hint">Create the first administrator. This page closes once an admin exists.</p>
<form method="post" action="/setup">
<% if (it.error) { %><p class="err"><%= it.error %></p><% } %>
<input type="hidden" name="token" value="<%= it.token %>">
<label>Email <input name="email" type="email" value="<%= it.email || '' %>" autocomplete="username" required></label>
<label>Password <input name="password" type="password" autocomplete="new-password" required></label>
<label>Confirm password <input name="confirm" type="password" autocomplete="new-password" required></label>
<button type="submit" class="btn-primary btn-wide">Create admin</button>
</form>`,
}
