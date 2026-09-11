import { describe, expect, it } from 'vitest'
import type { Account, Upstream } from '../src/core/store'
import { createKvStore } from '../src/adapters/store-kv'
import { fakeKv } from './fake-kv'

const upstream: Upstream = { id: 'up1', name: 'residential', protocol: 'socks5', host: 'gw.example', port: 1080 }
const account: Account = {
  id: 'a1', username: 'alice', password: 's3cret', upstreamId: 'up1',
  enabled: true, createdAt: '2026-09-10T00:00:00.000Z',
}

describe('kv store', () => {
  it('round-trips both kinds', async () => {
    const store = createKvStore(fakeKv())
    await store.putUpstream(upstream)
    await store.putAccount(account)
    expect(await store.getUpstream('up1')).toEqual(upstream)
    expect(await store.getAccountByUsername('alice')).toEqual(account)
    expect(await store.listAccounts()).toEqual([account])
    expect(await store.listUpstreams()).toEqual([upstream])
  })

  // The hot path is one keyed read. Listing there would turn every tunnel setup
  // into an O(accounts) KV scan.
  it('resolves an account with a single keyed read', async () => {
    const kv = fakeKv()
    const store = createKvStore(kv)
    await store.putAccount(account)
    kv.reads.length = 0
    await store.getAccountByUsername('alice')
    expect(kv.reads).toEqual(['acct:alice'])
    expect(kv.lists).toBe(0)
  })

  it('renaming an account leaves no stale username key', async () => {
    const store = createKvStore(fakeKv())
    await store.putAccount(account)
    await store.putAccount({ ...account, username: 'bob' })
    expect(await store.getAccountByUsername('alice')).toBeNull()
    expect(await store.getAccountByUsername('bob')).not.toBeNull()
    expect(await store.listAccounts()).toHaveLength(1)
  })

  it('deletes by id', async () => {
    const store = createKvStore(fakeKv())
    await store.putAccount(account)
    await store.deleteAccount('a1')
    expect(await store.getAccountByUsername('alice')).toBeNull()
    expect(await store.listAccounts()).toEqual([])
  })

  it('debounces lastSeenAt writes', async () => {
    const store = createKvStore(fakeKv())
    await store.putAccount(account)
    await store.touchAccount('a1', '2026-09-10T00:00:00.000Z')
    await store.touchAccount('a1', '2026-09-10T00:00:30.000Z')
    expect((await store.getAccountByUsername('alice'))!.lastSeenAt).toBe('2026-09-10T00:00:00.000Z')
    await store.touchAccount('a1', '2026-09-10T00:02:00.000Z')
    expect((await store.getAccountByUsername('alice'))!.lastSeenAt).toBe('2026-09-10T00:02:00.000Z')
  })

  it('rejects a cross-id username claim', async () => {
    const kv = fakeKv()
    const store = createKvStore(kv)
    await store.putAccount(account)
    await expect(store.putAccount({ ...account, id: 'a2' })).rejects.toThrow(
      /username alice already belongs to another account/,
    )
  })

  it('deletes every row owned by the id, even the one the pointer does not name', async () => {
    const kv = fakeKv()
    const store = createKvStore(kv)
    await store.putAccount(account)
    // The state a crash between putAccount's new-key write and its pointer write
    // leaves behind: two rows owned by a1, pointer still naming the old username.
    await kv.put('acct:bob', JSON.stringify({ ...account, username: 'bob' }))
    await store.deleteAccount('a1')
    expect(await store.getAccountByUsername('alice')).toBeNull()
    expect(await store.getAccountByUsername('bob')).toBeNull()
    expect(await store.listAccounts()).toEqual([])
  })

  it('lists accounts in createdAt order', async () => {
    const store = createKvStore(fakeKv())
    const a1 = { ...account, id: 'a1', username: 'alice', createdAt: '2026-09-10T12:00:00.000Z' }
    const a2 = { ...account, id: 'a2', username: 'bob', createdAt: '2026-09-10T08:00:00.000Z' }
    const a3 = { ...account, id: 'a3', username: 'charlie', createdAt: '2026-09-10T10:00:00.000Z' }
    // Insert in scrambled order.
    await store.putAccount(a1)
    await store.putAccount(a3)
    await store.putAccount(a2)
    const listed = await store.listAccounts()
    expect(listed).toEqual([a2, a3, a1])
  })

  it('lists upstreams in name order', async () => {
    const store = createKvStore(fakeKv())
    const u1 = { id: 'up1', name: 'zebra', protocol: 'socks5' as const }
    const u2 = { id: 'up2', name: 'apple', protocol: 'http' as const }
    const u3 = { id: 'up3', name: 'mango', protocol: 'direct' as const }
    // Insert in scrambled order.
    await store.putUpstream(u1)
    await store.putUpstream(u3)
    await store.putUpstream(u2)
    const listed = await store.listUpstreams()
    expect(listed).toEqual([u2, u3, u1])
  })

  // A real KVNamespace.list page caps at 1000 keys; pageSize: 2 here forces the
  // same shape with far fewer rows. Without following the cursor, both the
  // listing and the orphan scan would silently see only the first page.
  it('lists past a single KV page', async () => {
    const kv = fakeKv({ pageSize: 2 })
    const store = createKvStore(kv)
    const accounts = Array.from({ length: 5 }, (_, i) => ({
      ...account, id: `a${i}`, username: `user${i}`, createdAt: `2026-09-10T00:0${i}:00.000Z`,
    }))
    for (const a of accounts) await store.putAccount(a)
    const listed = await store.listAccounts()
    expect(listed.map((a) => a.username).sort()).toEqual(accounts.map((a) => a.username).sort())
  })

  it('the orphan scan in deleteAccount reaches every page, not just the first', async () => {
    const kv = fakeKv({ pageSize: 2 })
    const store = createKvStore(kv)
    const accounts = Array.from({ length: 5 }, (_, i) => ({
      ...account, id: `a${i}`, username: `user${i}`, createdAt: `2026-09-10T00:0${i}:00.000Z`,
    }))
    for (const a of accounts) await store.putAccount(a)
    // Leave the pointer aimed at a username that no longer holds the row, the
    // same crash state the "even the one the pointer does not name" test above
    // exercises. The orphan key is chosen to sort after the other keys so it lands
    // on a later page and can only be found by a scan that continues past the first.
    await kv.put('acct:zzz-orphan', JSON.stringify({ ...account, id: 'a3', username: 'zzz-orphan' }))
    await store.deleteAccount('a3')
    const listed = await store.listAccounts()
    expect(listed.some((a) => a.id === 'a3')).toBe(false)
    expect(await store.getAccountByUsername('zzz-orphan')).toBeNull()
  })

  it('lists upstreams in code-unit order with mixed case', async () => {
    const store = createKvStore(fakeKv())
    const u1 = { id: 'up1', name: 'Zebra', protocol: 'socks5' as const }
    const u2 = { id: 'up2', name: 'apple', protocol: 'http' as const }
    const u3 = { id: 'up3', name: 'Banana', protocol: 'direct' as const }
    await store.putUpstream(u1)
    await store.putUpstream(u2)
    await store.putUpstream(u3)
    const listed = await store.listUpstreams()
    // Code-unit order: uppercase letters come before lowercase in ASCII
    expect(listed).toEqual([u3, u1, u2])
  })
})
