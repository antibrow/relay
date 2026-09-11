import { describe, expect, it } from 'vitest'
import { createKvStore } from '../src/adapters/store-kv'
import { buildRelayEnv } from '../src/core/router'
import { nodeConnect } from '../src/adapters/socket-node'
import { randomKeyBase64Url } from '../src/protocol/crypto'
import { fakeKv } from './fake-kv'

const store = createKvStore(fakeKv())
const build = (raw: Parameters<typeof buildRelayEnv>[0]) => buildRelayEnv(raw, store, nodeConnect)

describe('buildRelayEnv', () => {
  it('decodes the key when one is set', () => {
    expect(build({ FP_RELAY_KEY: randomKeyBase64Url() }).key).toHaveLength(32)
  })

  it('leaves the key undefined when unset, rather than throwing', () => {
    expect(build({}).key).toBeUndefined()
  })

  // A key that fails to decode must not take the whole deployment down: the
  // encrypted path turns off, the admin surface still comes up so it can be fixed.
  it('treats an unusable key as no key', () => {
    expect(build({ FP_RELAY_KEY: 'not-a-key' }).key).toBeUndefined()
  })

  it('requires the literal 1 to enable plaintext', () => {
    expect(build({}).allowPlaintext).toBe(false)
    expect(build({ ALLOW_PLAINTEXT: 'true' }).allowPlaintext).toBe(false)
    expect(build({ ALLOW_PLAINTEXT: '1' }).allowPlaintext).toBe(true)
  })

  it('passes the admin key through', () => {
    expect(build({ ADMIN_KEY: 'k' }).adminKey).toBe('k')
    expect(build({}).adminKey).toBeUndefined()
  })
})
