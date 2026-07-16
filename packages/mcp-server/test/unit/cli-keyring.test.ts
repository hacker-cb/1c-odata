// test/unit/cli-keyring.test.ts
//
// The `serve` startup path's keyring wiring. This exists because the rotation
// support was once complete in crypto.ts yet dead in the real server: resolveKeyring
// hand-listed the env vars it forwarded and silently dropped
// ONEC_MCP_ENC_KEYS_PREVIOUS — with the docs telling operators to rotate, that would
// have stranded every secret sealed under the retired key.
import { describe, expect, it } from 'vitest'
import type { ServeOptions } from '../../src/cli.js'
import { resolveKeyring } from '../../src/cli.js'
import { decrypt, encrypt, loadKeyring } from '../../src/store/crypto.js'

const KEY_OLD = Buffer.alloc(32, 1).toString('base64')
const KEY_NEW = Buffer.alloc(32, 2).toString('base64')
const noOpts = {} as ServeOptions

describe('resolveKeyring (serve startup)', () => {
  it('is undefined without a key — tenancy stays off', () => {
    expect(resolveKeyring({} as NodeJS.ProcessEnv, noOpts)).toBeUndefined()
    expect(resolveKeyring({ ONEC_MCP_ENC_KEY: '' } as NodeJS.ProcessEnv, noOpts)).toBeUndefined()
  })

  it('threads retired keys through, so a rotated deployment still reads old secrets', () => {
    // A secret sealed before the rotation, under the old key / id 1.
    const sealed = encrypt(
      loadKeyring({ ONEC_MCP_ENC_KEY: KEY_OLD, ONEC_MCP_ENC_KEY_ID: '1' } as NodeJS.ProcessEnv),
      'Trade',
      'p@ss',
    )
    // The env an operator has after following the rotation docs.
    const kr = resolveKeyring(
      {
        ONEC_MCP_ENC_KEY: KEY_NEW,
        ONEC_MCP_ENC_KEY_ID: '2',
        ONEC_MCP_ENC_KEYS_PREVIOUS: `1:${KEY_OLD}`,
      } as NodeJS.ProcessEnv,
      noOpts,
    )
    expect(kr).toBeDefined()
    expect(decrypt(kr!, 'Trade', sealed)).toBe('p@ss') // the retired key IS loaded
    expect(encrypt(kr!, 'Trade', 'x').keyId).toBe(2) // new writes use the current key
  })

  it('--enc-key overrides the env key without dropping the rest of the ring', () => {
    const sealed = encrypt(
      loadKeyring({ ONEC_MCP_ENC_KEY: KEY_OLD, ONEC_MCP_ENC_KEY_ID: '1' } as NodeJS.ProcessEnv),
      'Trade',
      's',
    )
    const kr = resolveKeyring(
      {
        ONEC_MCP_ENC_KEY: Buffer.alloc(32, 9).toString('base64'), // must lose to the flag
        ONEC_MCP_ENC_KEY_ID: '2',
        ONEC_MCP_ENC_KEYS_PREVIOUS: `1:${KEY_OLD}`,
      } as NodeJS.ProcessEnv,
      { encKey: KEY_NEW } as ServeOptions,
    )
    expect(kr?.current.key.toString('base64')).toBe(KEY_NEW)
    expect(decrypt(kr!, 'Trade', sealed)).toBe('s')
  })
})
