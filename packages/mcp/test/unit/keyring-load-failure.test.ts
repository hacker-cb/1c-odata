import { describe, expect, it } from 'vitest'
import { keyringLoadFailure } from '../../src/secret-store.js'

/**
 * The keychain downgrade warning names why the backend is unavailable: an
 * optional dependency the install skipped, or one installed that fails to load
 * (a native binary for another platform or Node ABI) — which reinstalling fixes,
 * and which "not installed" would hide.
 */
describe('why @napi-rs/keyring is unavailable', () => {
  it.each([
    ['ERR_MODULE_NOT_FOUND', "Cannot find package '@napi-rs/keyring' imported from /app/dist/cli.js"],
    ['MODULE_NOT_FOUND', "Cannot find module '@napi-rs/keyring'"],
  ])('%s for the package itself: not installed', (code, message) => {
    expect(keyringLoadFailure(Object.assign(new Error(message), { code }))).toBe('@napi-rs/keyring not installed')
  })

  it('a native binary that fails to load: named, not "not installed"', () => {
    const err = Object.assign(new Error('keyring.linux-x64-gnu.node: invalid ELF header'), {
      code: 'ERR_DLOPEN_FAILED',
    })
    expect(keyringLoadFailure(err)).toBe(
      '@napi-rs/keyring could not be loaded (keyring.linux-x64-gnu.node: invalid ELF header)',
    )
  })

  it('a dependency of it missing: named, not "not installed"', () => {
    const err = Object.assign(new Error("Cannot find module '@napi-rs/keyring-linux-x64-gnu'"), {
      code: 'MODULE_NOT_FOUND',
    })
    expect(keyringLoadFailure(err)).toMatch(/^@napi-rs\/keyring could not be loaded \(Cannot find module/)
  })
})
