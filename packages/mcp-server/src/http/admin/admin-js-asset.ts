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
  document.addEventListener('click', function (e) {
    var gen = e.target.closest('[data-gen-password]');
    if (gen) {
      var target = document.querySelector(gen.getAttribute('data-gen-password'));
      if (target) {
        target.type = 'text'; // show what will be copied/submitted
        target.value = generate();
      }
      return;
    }
    var copy = e.target.closest('[data-copy]');
    if (copy) {
      var src = document.querySelector(copy.getAttribute('data-copy'));
      if (!src) return;
      copyText(src, function () {
        var prev = copy.textContent;
        copy.textContent = '✓ copied';
        setTimeout(function () { copy.textContent = prev; }, 1500);
      });
    }
  });
})();
`
