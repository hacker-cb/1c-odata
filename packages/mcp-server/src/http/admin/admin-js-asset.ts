// src/http/admin/admin-js-asset.ts
/**
 * The panel's own client helpers, served same-origin at /admin/assets/admin.js
 * (the admin CSP is `script-src 'self'` — no inline scripts). Delegated click
 * handlers keyed on data attributes, so htmx-swapped fragments need no re-wiring:
 *
 *   data-gen-password="<selector>" — fill the referenced input with a fresh
 *     random password (crypto.getRandomValues, rejection-sampled — no modulo
 *     bias; ~20 chars over a 70-symbol alphabet ≈ 122 bits). Generated client-
 *     side so the value only ever crosses the wire inside the form submit.
 *   data-copy="<selector>" — copy the referenced input's value to the clipboard
 *     (navigator.clipboard on secure contexts, execCommand fallback for plain
 *     HTTP over a LAN) with a transient "✓ copied" label.
 *   data-dialog-close="<selector>" — close the referenced <dialog> (drawer Cancel,
 *     confirm-modal Cancel, the drawer's × button).
 *
 * Beyond the delegated clicks it wires two hypermedia behaviours to the shell's
 * persistent dialogs (both live OUTSIDE #main, so htmx content swaps never replace
 * them):
 *   - Drawer follow: the right-side drawer opens when #drawer-body receives content
 *     (an edit/new/password form htmx-swapped in) and closes when it is emptied (a
 *     successful save sends an OOB empty #drawer-body). Visibility simply tracks
 *     whether the body has content — no per-trigger open/close plumbing.
 *   - Styled confirm: htmx:confirm is intercepted so hx-confirm prompts render in
 *     the centered #confirm modal instead of the browser's native confirm(), then
 *     issueRequest() resumes the original request on OK.
 */
export const ADMIN_JS = `(function () {
  'use strict';
  var ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%^&*-_=+';
  var LENGTH = 20;
  function generate() {
    var out = '';
    // Rejection sampling: only accept values below the largest multiple of the
    // alphabet size, so every character is uniformly likely (no modulo bias).
    var max = Math.floor(4294967296 / ALPHABET.length) * ALPHABET.length;
    while (out.length < LENGTH) {
      var buf = new Uint32Array(LENGTH);
      crypto.getRandomValues(buf);
      for (var i = 0; i < buf.length && out.length < LENGTH; i++) {
        if (buf[i] < max) out += ALPHABET[buf[i] % ALPHABET.length];
      }
    }
    return out;
  }
  function copyText(input, done) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(input.value).then(done, function () {});
      return;
    }
    // Plain-HTTP fallback (LAN deployments): select + the legacy copy command.
    input.focus();
    input.select();
    try { document.execCommand('copy'); done(); } catch (e) { /* leave selected for manual copy */ }
  }
  // Resolve a selector taken from a data-* attribute safely. Our templates only
  // emit '#id' selectors; getElementById needs no CSS escaping and never throws on
  // an id with odd characters (and matches the literal id, which is what we want).
  // Anything else goes through querySelector in a try/catch so a malformed selector
  // can't throw and break the whole delegated click handler.
  function pick(sel) {
    if (!sel) return null;
    if (sel.charAt(0) === '#' && sel.indexOf(' ') === -1) return document.getElementById(sel.slice(1));
    try { return document.querySelector(sel); } catch (e) { return null; }
  }
  document.addEventListener('click', function (e) {
    var gen = e.target.closest('[data-gen-password]');
    if (gen) {
      var target = pick(gen.getAttribute('data-gen-password'));
      if (target) {
        target.type = 'text'; // show what will be copied/submitted
        target.value = generate();
      }
      return;
    }
    var copy = e.target.closest('[data-copy]');
    if (copy) {
      var src = pick(copy.getAttribute('data-copy'));
      if (!src) return;
      copyText(src, function () {
        var prev = copy.textContent;
        copy.textContent = '✓ copied';
        setTimeout(function () { copy.textContent = prev; }, 1500);
      });
      return;
    }
    var closer = e.target.closest('[data-dialog-close]');
    if (closer) closeDialog(pick(closer.getAttribute('data-dialog-close')));
  });

  // Open a dialog. Prefer the native modal (backdrop + focus containment); on an
  // engine without <dialog> support, fall back to the open attribute the CSS
  // already keys on — degraded but functional, and never throws (a bare showModal()
  // TypeError would abort admin.js and kill the copy/gen/confirm handlers too).
  function openDialog(dlg) {
    if (!dlg) return;
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }
  // Close a dialog and, for the drawer, reset its body so a dismissed form can't
  // linger behind the next open. Done imperatively (not via the 'close' event) so
  // it is deterministic across engines — Cancel / × / backdrop all route here.
  function closeDialog(dlg) {
    if (!dlg) return;
    if (typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open'); // mirror of openDialog's fallback
    if (dlg.id === 'drawer') {
      var body = document.getElementById('drawer-body');
      if (body) body.innerHTML = '';
    }
  }

  // ── Right-side drawer: visibility follows #drawer-body's content ──
  function syncDrawer() {
    var drawer = document.getElementById('drawer');
    var body = document.getElementById('drawer-body');
    if (!drawer || !body) return;
    var hasContent = body.children.length > 0;
    var isOpen = drawer.hasAttribute('open'); // true for both native .open and the fallback
    if (hasContent && !isOpen) openDialog(drawer);
    else if (!hasContent && isOpen) closeDialog(drawer);
  }
  // htmx settles the main swap and any OOB swaps; recheck after both.
  document.body.addEventListener('htmx:afterSwap', syncDrawer);
  document.body.addEventListener('htmx:oobAfterSwap', syncDrawer);

  function wireDialog(id) {
    var dlg = document.getElementById(id);
    if (!dlg) return;
    // A click on the ::backdrop registers as a click on the <dialog> itself
    // (content sits in child nodes) — treat it as dismiss.
    dlg.addEventListener('click', function (e) { if (e.target === dlg) closeDialog(dlg); });
    return dlg;
  }
  var drawer = wireDialog('drawer');
  // Backstop for the native 'close' event (e.g. Esc closes a <dialog> without
  // routing through closeDialog): clear the body there too.
  if (drawer) drawer.addEventListener('close', function () {
    var body = document.getElementById('drawer-body');
    if (body) body.innerHTML = '';
  });
  wireDialog('confirm');

  // ── Styled confirm: intercept htmx:confirm so hx-confirm uses our modal ──
  document.body.addEventListener('htmx:confirm', function (e) {
    var question = e.detail.question; // null when the element has no hx-confirm
    if (!question) return; // nothing to confirm → let htmx proceed normally
    e.preventDefault(); // defer the request until the user answers
    var modal = document.getElementById('confirm');
    var msg = document.getElementById('confirm-msg');
    var ok = document.getElementById('confirm-ok');
    if (!modal || !msg || !ok) {
      // Confirm markup missing (the shell always renders it, so this shouldn't
      // happen): fall back to the browser's NATIVE confirm rather than firing a
      // destructive request unconfirmed.
      if (window.confirm(question)) e.detail.issueRequest(true);
      return;
    }
    msg.textContent = question;
    // Replace the OK button to drop any handler bound for a previous prompt.
    var fresh = ok.cloneNode(true);
    ok.parentNode.replaceChild(fresh, ok);
    fresh.addEventListener('click', function () {
      closeDialog(modal);
      e.detail.issueRequest(true); // true = skip re-confirming, run the request now
    });
    openDialog(modal);
  });
})();
`
