import { describe, expect, it } from 'vitest'
import { keyringLoadFailure } from '../../src/secret-store.js'

/**
 * The keychain downgrade warning names why the backend is unavailable and
 * what fixes it: an optional dependency the install skipped, or one installed
 * that fails to load (a native binary for another platform or Node ABI) —
 * which reinstalling fixes, and which "not installed" would hide.
 */
describe('why @napi-rs/keyring is unavailable', () => {
  it.each([
    ['ERR_MODULE_NOT_FOUND', "Cannot find package '@napi-rs/keyring' imported from /app/dist/cli.js"],
    ['MODULE_NOT_FOUND', "Cannot find module '@napi-rs/keyring'\nRequire stack:\n- /app/dist/cli.js"],
  ])('%s for the package itself: not installed', (code, message) => {
    expect(keyringLoadFailure(Object.assign(new Error(message), { code }))).toEqual({
      reason: '@napi-rs/keyring not installed',
      fix: 'install the keychain backend',
    })
  })

  it('a native binary that fails to load: named, with a reinstall as the fix', () => {
    const err = Object.assign(new Error('keyring.linux-x64-gnu.node: invalid ELF header'), {
      code: 'ERR_DLOPEN_FAILED',
    })
    expect(keyringLoadFailure(err)).toEqual({
      reason: '@napi-rs/keyring could not be loaded (keyring.linux-x64-gnu.node: invalid ELF header)',
      fix: 'reinstall @napi-rs/keyring for this platform and Node version',
    })
  })

  it('the loader’s wrapped error: its first line and its first cause, on one line', () => {
    const err = Object.assign(
      new Error(
        'Cannot find native binding. npm has a bug related to optional dependencies.\nPlease try reinstalling.',
      ),
      { cause: [new Error('/app/node_modules/@napi-rs/keyring/keyring.darwin-arm64.node: wrong architecture\nmore')] },
    )
    const { reason } = keyringLoadFailure(err)
    expect(reason).toBe(
      '@napi-rs/keyring could not be loaded (Cannot find native binding. npm has a bug related to optional dependencies.: /app/node_modules/@napi-rs/keyring/keyring.darwin-arm64.node: wrong architecture)',
    )
    expect(reason).not.toContain('\n')
  })

  it('a platform package of it missing: named, not "not installed"', () => {
    const err = Object.assign(new Error("Cannot find module '@napi-rs/keyring-linux-x64-gnu'"), {
      code: 'MODULE_NOT_FOUND',
    })
    expect(keyringLoadFailure(err).reason).toMatch(/^@napi-rs\/keyring could not be loaded \(Cannot find module/)
  })
})
