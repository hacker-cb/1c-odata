// src/http/admin/templates.ts
/* Inline Eta templates for the admin panel — the fragments only; the page chrome
 * and the design system live in ../../ui/shell.ts (BASE_CSS + appShell/authShell).
 * String-mode (see views.ts). All data interpolation is escaped `<%= %>`; `<%~ %>`
 * (raw) is used ONLY to compose our own trusted sub-fragments (`it._r(...)`), never
 * for request data. Cyrillic labels live safely in this UTF-8 `.ts`.
 *
 * Editing surfaces (new/edit base, new/edit user, set-password) all render into the
 * shell's persistent right-side drawer (`#drawer-body`). The drawer opens when that
 * body receives content and closes when it is emptied — a successful save sends an
 * OOB empty `#drawer-body` (`_drawer_close`); a validation error re-renders the form
 * OOB into it (`_drawer_form_oob`), so the error shows INSIDE the modal (a #flash
 * toast would be hidden behind the dialog's top layer). See admin-js-asset.ts. */

export const TEMPLATES: Record<string, string> = {
  // ---- Flash toast ----
  // OOB fragment targeting the app shell's fixed `#flash` region. Error responses
  // send ONLY this (with `HX-Reswap: none`), so the failure surfaces as a toast
  // while the request's own swap target stays untouched. `kind` ∈ err | ok.
  _flash: `<div id="flash" hx-swap-oob="innerHTML"><p class="flash-msg <%= it.kind %>"><%= it.message %></p></div>`,

  // ---- Shared drawer chrome ----
  // OOB re-render of the currently-open drawer form (validation error path). `_form`
  // names the fragment (e.g. '_base_form', '_user_edit_form'); the whole `it` bag
  // flows through so the form echoes back the typed values + `error`. Because the
  // entire body is the OOB node, htmx strips it and the request's own swap receives
  // '' — harmless for the form's `#…-tbody` target (beforeend '' / none = no-op).
  _drawer_form_oob: `<div id="drawer-body" hx-swap-oob="innerHTML"><%~ it._r(it._form, it) %></div>`,
  // OOB: empty the drawer body → admin.js closes the drawer (used on a successful save).
  _drawer_close: `<div id="drawer-body" hx-swap-oob="innerHTML"></div>`,

  // ---- Dashboard ----
  // The health table auto-refreshes every 10s (re-reading the DB the background job
  // writes). "Check connections now" forces an on-demand re-probe of every base and
  // swaps the fresh rows into the same #health-tbody; the button dims while in flight.
  dashboard: `<div class="pagehead"><h1>Dashboard</h1>
<button class="btn-sm" hx-post="/admin/health/check" hx-target="#health-tbody" hx-swap="innerHTML">Check connections now</button></div>
<p class="meta"><%= it.serverInfo %></p>
<div class="tablecard"><table><thead><tr><th>Base</th><th>Status</th><th>Last check (UTC)</th><th>Error</th></tr></thead>
<tbody id="health-tbody" hx-get="/admin/health/table" hx-trigger="load, every 10s" hx-swap="innerHTML"><%~ it._r('_health_rows', { rows: it.rows }) %></tbody></table></div>`,

  _health_rows: `<% if (it.rows.length === 0) { %><tr><td colspan="4" class="empty">No bases configured yet.</td></tr><% } %><% for (const h of it.rows) { %><tr>
<td class="mono"><%= h.baseName %></td>
<td><span class="badge <%= h.status %>"><%= h.status.replace('_',' ') %></span></td>
<td class="mono"><%= h.lastCheck %></td>
<td class="err"><%= h.error || '' %></td></tr><% } %>`,

  // ---- Bases ----
  // Each row bag is { base } where base carries name/baseUrl/login/serverTimezone/
  // label/hasSecret/health (health defaults to 'unknown' when the job hasn't probed).
  bases_list: `<div class="pagehead"><h1>Bases</h1>
<button class="btn-primary btn-sm" hx-get="/admin/bases/new" hx-target="#drawer-body" hx-swap="innerHTML">New base</button></div>
<div class="tablecard"><table><thead><tr><th>Name</th><th>Label</th><th>URL</th><th>Login</th><th>TZ</th><th>Health</th><th>Secret</th><th></th></tr></thead>
<tbody id="bases-tbody"><tr class="emptyrow"><td colspan="8" class="empty">No bases yet — add one with <strong>New base</strong>.</td></tr><% for (const b of it.bases) { %><%~ it._r('_base_row', { base: b }) %><% } %></tbody></table></div>`,

  _base_row: `<tr id="base-<%= it.base.name %>">
<td class="mono"><%= it.base.name %></td>
<td><%= it.base.label || '' %></td>
<td class="mono longcell"><%= it.base.baseUrl %></td><td class="mono longcell"><%= it.base.login %></td>
<td class="mono"><%= it.base.serverTimezone %></td>
<td><span class="badge <%= it.base.health || 'unknown' %> static"><%= (it.base.health || 'unknown').replace('_',' ') %></span></td>
<td><% if (it.base.hasSecret) { %><span class="ok">✓ sealed</span><% } else { %><span class="err">— none</span><% } %></td>
<td>
<button class="btn-sm" hx-get="/admin/bases/<%= it.base.name %>/edit" hx-target="#drawer-body" hx-swap="innerHTML">Edit</button>
<button class="btn-danger btn-sm" hx-delete="/admin/bases/<%= it.base.name %>" hx-target="#base-<%= it.base.name %>" hx-swap="outerHTML" hx-confirm="Delete base <%= it.base.name %>? Cascades to its secret, grants and health.">Delete</button>
</td></tr>`,

  // Mode is keyed on the EXPLICIT `it.edit` flag, never on `it.name` being set: an
  // error re-render of the CREATE form carries the typed name, and inferring the
  // mode from it would flip that re-render into an hx-put edit form — one click
  // away from overwriting the very base whose existence caused the error.
  // The timezone is a native searchable combobox: an <input list> backed by a
  // <datalist> of Intl.supportedValuesOf zones (injected as it.timezones). It gives
  // typeahead filtering with zero JS under the admin CSP; a typo that isn't a real
  // IANA zone is rejected server-side by saveBase's isValidTimezone (CLAUDE.md: the
  // zone is required, no default, and a wrong value silently shifts DateTime parsing).
  _base_form: `<form <% if (it.edit) { %>hx-put="/admin/bases/<%= it.name %>"<% } else { %>hx-post="/admin/bases"<% } %> hx-target="#bases-tbody" hx-swap="<%= it.edit ? 'none' : 'beforeend' %>">
<fieldset><legend><%= it.edit ? 'Edit '+it.name : 'New base' %></legend>
<% if (it.error) { %><p class="err"><%= it.error %></p><% } %>
<label>Name <span class="req" aria-hidden="true">*</span> <input name="name" value="<%= it.name || '' %>" <%= it.edit ? 'readonly' : '' %> required></label>
<label>Base URL <span class="req" aria-hidden="true">*</span> <input name="baseUrl" type="url" value="<%= it.baseUrl || '' %>" placeholder="https://host/base/odata/standard.odata/" required></label>
<label>Login <span class="req" aria-hidden="true">*</span> <input name="login" value="<%= it.login || '' %>" required></label>
<label>Password <% if (!it.edit) { %><span class="req" aria-hidden="true">*</span> <% } %><input name="password" type="password" autocomplete="off" <%= it.edit ? '' : 'required' %> placeholder="<%= it.edit ? '(unchanged)' : '' %>"></label>
<% const tz = it.serverTimezone || '' %>
<label>Server timezone <span class="req" aria-hidden="true">*</span> <input name="serverTimezone" list="tzlist" value="<%= tz %>" placeholder="Type to search…" autocomplete="off" required>
<datalist id="tzlist"><% for (const z of it.timezones) { %><option value="<%= z %>"></option><% } %></datalist></label>
<label>Label <input name="label" value="<%= it.label || '' %>"></label>
<p class="formhint"><span class="req" aria-hidden="true">*</span> required field</p>
<div class="formactions">
<button type="submit" class="btn-primary btn-sm">Save</button>
<button type="button" class="btn-sm" hx-post="/admin/bases/verify" hx-target="#verify-result" hx-swap="innerHTML" hx-include="closest form">Verify</button>
<button type="button" class="btn-sm" data-dialog-close="#drawer">Cancel</button>
<span id="verify-result"></span>
</div>
</fieldset></form>`,

  _verify_result: `<% if (it.ok) { %><span class="ok">✓ verified</span><% } else { %><span class="err">✗ <%= it.error %></span><% } %>`,

  // ---- Grants ----
  grants_editor: `<h1>Grants</h1>
<p>Toggle a base for a user, then pick read or write scope.</p>
<p class="subtle">The remote MCP surface is read-only, so <code>write</code> is reserved — it is stored but grants no extra capability over HTTP today.</p>
<% if (it.users.length === 0 || it.bases.length === 0) { %><div class="tablecard"><table><tbody><tr><td class="empty"><% if (it.bases.length === 0) { %>No bases to grant — add one under Bases.<% } else { %>No users to grant — add one under Users.<% } %></td></tr></tbody></table></div><% } else { %>
<div class="tablecard"><table><thead><tr><th scope="col">User</th><% for (const b of it.bases) { %><th scope="col"><%= b %></th><% } %></tr></thead>
<tbody><% for (const u of it.users) { %><tr><th scope="row"><span class="uident"><% if (u.name) { %><span class="uname"><%= u.name %></span><% } %><span class="umail mono"><%= u.email %></span></span></th>
<% for (const b of it.bases) { %><%~ it._r('_grant_cell', { sub: u.id, base: b, granted: it.matrix[u.id+'|'+b] !== undefined, scope: it.matrix[u.id+'|'+b] || 'read' }) %><% } %>
</tr><% } %></tbody></table></div><% } %>`,

  // Screen readers get the USER from the row's <th scope="row"> and the BASE from
  // the column's <th scope="col">, so the cell's own aria-label needs only the
  // action — no email round-trip, which also keeps hx-vals free of any value that
  // could break its hand-assembled JSON (sub is a UUID, base is a restricted
  // ASCII connection name — both JSON-safe; an email with a quote is not).
  _grant_cell: `<td id="grant-<%= it.sub %>-<%= it.base %>">
<input type="checkbox" <%= it.granted ? 'checked' : '' %> aria-label="Grant access to <%= it.base %>"
 hx-post="/admin/grants/toggle" hx-target="#grant-<%= it.sub %>-<%= it.base %>" hx-swap="outerHTML"
 hx-vals='{"sub":"<%= it.sub %>","base":"<%= it.base %>","granted":"<%= it.granted ? '' : 'on' %>","scope":"<%= it.scope %>"}'>
<select <%= it.granted ? '' : 'disabled' %> aria-label="Scope for <%= it.base %>"
 hx-post="/admin/grants/toggle" hx-target="#grant-<%= it.sub %>-<%= it.base %>" hx-swap="outerHTML"
 hx-vals='{"sub":"<%= it.sub %>","base":"<%= it.base %>","granted":"on"}' name="scope">
<option value="read" <%= it.scope==='read' ? 'selected' : '' %>>read</option>
<option value="write" <%= it.scope==='write' ? 'selected' : '' %>>write</option>
</select></td>`,

  // ---- Users ----
  // `it.users` is a list of row bags: { user, self, created, roleAdmin } (see users.rowData).
  users_list: `<div class="pagehead"><h1>Users</h1>
<button class="btn-primary btn-sm" hx-get="/admin/users/new" hx-target="#drawer-body" hx-swap="innerHTML">New user</button></div>
<p>Sign-up is closed — provision users here.</p>
<div class="tablecard"><table><thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Status</th><th>Created</th><th></th></tr></thead>
<tbody id="users-tbody"><tr class="emptyrow"><td colspan="6" class="empty">No users yet — create one with <strong>New user</strong>.</td></tr><% for (const row of it.users) { %><%~ it._r('_user_row', row) %><% } %></tbody></table></div>`,

  // Self-mutation is blocked in the UI (no Ban/Delete on your own row) AND
  // server-side; the role select stays enabled everywhere — demoting yourself is
  // legitimate when another admin exists (the last-admin guard is server-side).
  _user_row: `<tr id="user-<%= it.user.id %>">
<td class="mono longcell"><%= it.user.email %><% if (it.self) { %> <span class="you">you</span><% } %></td>
<td><%= it.user.name %></td>
<td><select hx-post="/admin/users/<%= it.user.id %>/role" hx-target="#user-<%= it.user.id %>" hx-swap="outerHTML" name="role" aria-label="Role for <%= it.user.email %>">
<option value="user" <%= it.roleAdmin ? '' : 'selected' %>>user</option>
<option value="admin" <%= it.roleAdmin ? 'selected' : '' %>>admin</option>
</select></td>
<td><% if (it.user.banned) { %><span class="badge banned">banned</span><% } else { %><span class="badge ok static">active</span><% } %></td>
<td class="mono"><%= it.created %></td>
<td>
<button class="btn-sm" hx-get="/admin/users/<%= it.user.id %>/edit" hx-target="#drawer-body" hx-swap="innerHTML">Edit</button>
<button class="btn-sm" hx-get="/admin/users/<%= it.user.id %>/password" hx-target="#drawer-body" hx-swap="innerHTML">Password</button>
<% if (!it.self) { %><% if (it.user.banned) { %>
<button class="btn-sm" hx-post="/admin/users/<%= it.user.id %>/unban" hx-target="#user-<%= it.user.id %>" hx-swap="outerHTML">Unban</button>
<% } else { %>
<button class="btn-sm" hx-post="/admin/users/<%= it.user.id %>/ban" hx-target="#user-<%= it.user.id %>" hx-swap="outerHTML" hx-confirm="Ban <%= it.user.email %>? Sign-in is blocked and their sessions are revoked.">Ban</button>
<% } %>
<button class="btn-danger btn-sm" hx-delete="/admin/users/<%= it.user.id %>" hx-target="#user-<%= it.user.id %>" hx-swap="outerHTML" hx-confirm="Delete <%= it.user.email %>? Their grants are removed. This cannot be undone.">Delete</button>
<% } %>
</td></tr>`,

  // New-user form (into the drawer). Appends the row via beforeend; the empty-state
  // placeholder hides itself via CSS (:only-child) once a real row exists. On a
  // validation error createUser re-renders THIS form OOB with `error` + echoed
  // email/name/role (never the password — client-side only).
  _user_create_form: `<form hx-post="/admin/users" hx-target="#users-tbody" hx-swap="beforeend">
<fieldset><legend>Create user</legend>
<% if (it.error) { %><p class="err"><%= it.error %></p><% } %>
<label>Email <span class="req" aria-hidden="true">*</span> <input name="email" type="email" value="<%= it.email || '' %>" placeholder="name@example.com" required></label>
<label>Name <input name="name" value="<%= it.name || '' %>" placeholder="Full name"></label>
<label>Password <span class="req" aria-hidden="true">*</span> <span class="fieldrow"><input id="create-user-pw" name="password" type="password" autocomplete="new-password" placeholder="Temporary password" minlength="8" required>
<button type="button" class="btn-sm" data-gen-password="#create-user-pw">Generate</button>
<button type="button" class="btn-sm" data-copy="#create-user-pw">Copy</button></span></label>
<label>Role <select name="role"><option value="user" <%= it.role==='admin' ? '' : 'selected' %>>user</option><option value="admin" <%= it.role==='admin' ? 'selected' : '' %>>admin</option></select></label>
<p class="formhint"><span class="req" aria-hidden="true">*</span> required field</p>
<div class="formactions">
<button type="submit" class="btn-primary btn-sm">Create user</button>
<button type="button" class="btn-sm" data-dialog-close="#drawer">Cancel</button></div>
</fieldset></form>`,

  // Edit a user's identity (email + name). Role is changed inline in the row's
  // select (single source of truth), so it is deliberately not repeated here. The
  // form submits with hx-swap="none" — success replaces the row via an OOB fragment.
  _user_edit_form: `<form hx-post="/admin/users/<%= it.id %>" hx-target="#users-tbody" hx-swap="none">
<fieldset><legend>Edit user</legend>
<% if (it.error) { %><p class="err"><%= it.error %></p><% } %>
<label>Email <span class="req" aria-hidden="true">*</span> <input name="email" type="email" value="<%= it.email %>" required></label>
<label>Name <input name="name" value="<%= it.name || '' %>" placeholder="Full name"></label>
<p class="formhint"><span class="req" aria-hidden="true">*</span> required field</p>
<div class="formactions">
<button type="submit" class="btn-primary btn-sm">Save</button>
<button type="button" class="btn-sm" data-dialog-close="#drawer">Cancel</button></div>
</fieldset></form>`,

  // Set-password form (into the drawer). Success sends OOB `_drawer_close` + an ok
  // toast (closeDrawer); a short password re-renders THIS form OOB with the error.
  // minlength mirrors better-auth's default password policy.
  _user_password_form: `<form hx-post="/admin/users/<%= it.id %>/password" hx-target="#users-tbody" hx-swap="none">
<fieldset><legend>Set password — <%= it.email %></legend>
<% if (it.error) { %><p class="err"><%= it.error %></p><% } %>
<label>New password <span class="req" aria-hidden="true">*</span> <span class="fieldrow"><input id="pw-<%= it.id %>" name="password" type="password" autocomplete="new-password" minlength="8" required>
<button type="button" class="btn-sm" data-gen-password="#pw-<%= it.id %>">Generate</button>
<button type="button" class="btn-sm" data-copy="#pw-<%= it.id %>">Copy</button></span></label>
<p class="hint">Saving revokes the user's existing sessions; hand the new password over out of band.</p>
<div class="formactions">
<button type="submit" class="btn-primary btn-sm">Save password</button>
<button type="button" class="btn-sm" data-dialog-close="#drawer">Cancel</button></div>
</fieldset></form>`,

  // ---- Account (any signed-in role; served by the /account router) ----
  account_page: `<h1>Account</h1>
<p><span class="mono"><%= it.email %></span> · role <%= it.role %></p>
<form hx-post="/account/password" hx-swap="none">
<fieldset><legend>Change password</legend>
<label>Current password <span class="req" aria-hidden="true">*</span> <input name="current" type="password" autocomplete="current-password" required></label>
<label>New password <span class="req" aria-hidden="true">*</span> <span class="fieldrow"><input id="account-pw" name="password" type="password" autocomplete="new-password" minlength="8" required>
<button type="button" class="btn-sm" data-gen-password="#account-pw">Generate</button>
<button type="button" class="btn-sm" data-copy="#account-pw">Copy</button></span></label>
<p class="hint">Changing the password signs out your other sessions (this one stays).</p>
<p class="formhint"><span class="req" aria-hidden="true">*</span> required field</p>
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
<label>Email <span class="req" aria-hidden="true">*</span> <input name="email" type="email" value="<%= it.email || '' %>" autocomplete="username" required></label>
<label>Password <span class="req" aria-hidden="true">*</span> <input name="password" type="password" autocomplete="new-password" required></label>
<label>Confirm password <span class="req" aria-hidden="true">*</span> <input name="confirm" type="password" autocomplete="new-password" required></label>
<button type="submit" class="btn-primary btn-wide">Create admin</button>
</form>`,
}
