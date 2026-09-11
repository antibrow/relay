import { describe, expect, it } from 'vitest'
import type { Account, RelayStore, Upstream } from '../src/core/store'
import { DIRECT_UPSTREAM } from '../src/core/store'
import { constantTimeEqual, parseBasicAuth, parseCred, resolveIdentity, requireIdentity } from '../src/core/auth'
import { parseUpstreamUrl } from '../src/core/url'

const upstream: Upstream = { id: 'up1', name: 'res', protocol: 'http', host: 'gw.example', port: 8000 }
const account: Account = {
  id: 'a1', username: 'alice', password: 's3cret', upstreamId: 'up1',
  enabled: true, createdAt: '2026-09-10T00:00:00.000Z',
}

function storeWith(accounts: Account[], upstreams: Upstream[]): RelayStore {
  return {
    async listAccounts() { return accounts },
    async getAccountByUsername(u) { return accounts.find((a) => a.username === u) ?? null },
    async putAccount() {}, async deleteAccount() {}, async touchAccount() {},
    async listUpstreams() { return upstreams },
    async getUpstream(id) { return upstreams.find((u) => u.id === id) ?? null },
    async putUpstream() {}, async deleteUpstream() {},
  }
}

describe('parseUpstreamUrl', () => {
  it('parses an http upstream with credentials', () => {
    expect(parseUpstreamUrl('http://u:p@gw.example:8000')).toEqual({
      protocol: 'http', host: 'gw.example', port: 8000, username: 'u', password: 'p',
    })
  })

  it('parses socks5 and defaults the port', () => {
    expect(parseUpstreamUrl('socks5://gw.example')).toEqual({
      protocol: 'socks5', host: 'gw.example', port: 1080, username: undefined, password: undefined,
    })
  })

  it('defaults http to port 80 and https to port 443', () => {
    expect(parseUpstreamUrl('http://gw.example')?.port).toBe(80)
    expect(parseUpstreamUrl('https://gw.example')?.port).toBe(443)
  })

  it('percent-decodes credentials', () => {
    expect(parseUpstreamUrl('http://u%40x:p%3Aq@gw.example:80')?.username).toBe('u@x')
    expect(parseUpstreamUrl('http://u%40x:p%3Aq@gw.example:80')?.password).toBe('p:q')
  })

  it('returns null for malformed percent-encoding in the userinfo', () => {
    expect(parseUpstreamUrl('http://a%zz:p@gw.example:8000')).toBeNull()
  })

  it('keeps an explicitly typed port that equals the scheme default', () => {
    expect(parseUpstreamUrl('http://gw.example:80')?.port).toBe(80)
    expect(parseUpstreamUrl('https://gw.example:443')?.port).toBe(443)
  })

  it('rejects an unknown scheme or an unparseable string', () => {
    expect(parseUpstreamUrl('ftp://gw.example')).toBeNull()
    expect(parseUpstreamUrl('not a url')).toBeNull()
  })
})

describe('parseCred', () => {
  it('splits on the first colon only', () => {
    expect(parseCred('alice:p:with:colons')).toEqual({ username: 'alice', password: 'p:with:colons' })
  })

  it('rejects a credential with no colon or an empty username', () => {
    expect(parseCred('alice')).toBeNull()
    expect(parseCred(':p')).toBeNull()
  })
})

describe('parseBasicAuth', () => {
  it('decodes a Basic header', () => {
    const header = `Basic ${btoa('alice:s3cret')}`
    expect(parseBasicAuth(header)).toEqual({ username: 'alice', password: 's3cret' })
  })

  it('rejects a missing or non-Basic header', () => {
    expect(parseBasicAuth(null)).toBeNull()
    expect(parseBasicAuth('Bearer abc')).toBeNull()
    expect(parseBasicAuth('Basic !!!not-base64!!!')).toBeNull()
  })
})

describe('constantTimeEqual', () => {
  it('compares by value', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true)
    expect(constantTimeEqual('abc', 'abd')).toBe(false)
    expect(constantTimeEqual('abc', 'abcd')).toBe(false)
  })
})

describe('resolveIdentity', () => {
  const store = storeWith([account], [upstream])

  // Empty credentials keep the single-tenant deployment working exactly as it did
  // before accounts existed: exit straight from the relay.
  it('falls back to direct when there is no credential', async () => {
    expect(await resolveIdentity(store, null)).toEqual({ upstream: DIRECT_UPSTREAM })
  })

  it('resolves an account to its upstream', async () => {
    const id = await resolveIdentity(store, { username: 'alice', password: 's3cret' })
    expect(id?.account?.id).toBe('a1')
    expect(id?.upstream).toEqual(upstream)
  })

  it('rejects a wrong password, an unknown user and a disabled account', async () => {
    expect(await resolveIdentity(store, { username: 'alice', password: 'nope' })).toBeNull()
    expect(await resolveIdentity(store, { username: 'ghost', password: 'x' })).toBeNull()
    const off = storeWith([{ ...account, enabled: false }], [upstream])
    expect(await resolveIdentity(off, { username: 'alice', password: 's3cret' })).toBeNull()
  })

  // A dangling upstreamId must not silently become "no proxy at all" for a
  // deployment that expects every account to egress through a residential hop...
  // but failing closed would take the whole account offline over a stale row.
  // Direct is the documented behaviour; the admin UI surfaces the dangling row.
  it('falls back to direct when the upstream row is gone', async () => {
    const orphan = storeWith([account], [])
    expect((await resolveIdentity(orphan, { username: 'alice', password: 's3cret' }))?.upstream)
      .toEqual(DIRECT_UPSTREAM)
  })
})

describe('requireIdentity', () => {
  const store = storeWith([account], [upstream])

  it('rejects an absent credential instead of falling back to direct', async () => {
    expect(await requireIdentity(store, null)).toBeNull()
  })

  it('still resolves a valid credential', async () => {
    expect((await requireIdentity(store, { username: 'alice', password: 's3cret' }))?.account?.id).toBe('a1')
  })
})
