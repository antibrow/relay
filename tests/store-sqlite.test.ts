import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Account, Upstream } from '../src/core/store'
import { createSqliteStore } from '../src/adapters/store-sqlite'

let dir: string
let store: ReturnType<typeof createSqliteStore>

const upstream: Upstream = {
  id: 'up1', name: 'residential', protocol: 'http',
  host: 'gw.example', port: 8000, username: 'u', password: 'p',
}

const account: Account = {
  id: 'a1', username: 'alice', password: 's3cret', upstreamId: 'up1',
  enabled: true, createdAt: '2026-09-10T00:00:00.000Z',
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relay-store-'))
  store = createSqliteStore(join(dir, 'relay.db'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('sqlite store', () => {
  it('round-trips an upstream', async () => {
    await store.putUpstream(upstream)
    expect(await store.getUpstream('up1')).toEqual(upstream)
    expect(await store.listUpstreams()).toEqual([upstream])
  })

  it('round-trips an account and finds it by username', async () => {
    await store.putUpstream(upstream)
    await store.putAccount(account)
    expect(await store.getAccountByUsername('alice')).toEqual(account)
    expect(await store.getAccountByUsername('nobody')).toBeNull()
  })

  it('upserts by id', async () => {
    await store.putUpstream(upstream)
    await store.putAccount(account)
    await store.putAccount({ ...account, enabled: false, note: 'paused' })
    const all = await store.listAccounts()
    expect(all).toHaveLength(1)
    expect(all[0]!.enabled).toBe(false)
    expect(all[0]!.note).toBe('paused')
  })

  it('rejects a duplicate username under a different id', async () => {
    await store.putUpstream(upstream)
    await store.putAccount(account)
    await expect(store.putAccount({ ...account, id: 'a2' })).rejects.toThrow()
  })

  it('records lastSeenAt', async () => {
    await store.putUpstream(upstream)
    await store.putAccount(account)
    await store.touchAccount('a1', '2026-09-11T00:00:00.000Z')
    expect((await store.getAccountByUsername('alice'))!.lastSeenAt).toBe('2026-09-11T00:00:00.000Z')
  })

  it('deletes', async () => {
    await store.putUpstream(upstream)
    await store.putAccount(account)
    await store.deleteAccount('a1')
    await store.deleteUpstream('up1')
    expect(await store.listAccounts()).toEqual([])
    expect(await store.listUpstreams()).toEqual([])
  })

  it('keeps optional columns undefined rather than null', async () => {
    await store.putUpstream({ id: 'd', name: 'direct out', protocol: 'direct' })
    const got = (await store.getUpstream('d'))!
    expect(got.host).toBeUndefined()
    expect(got.note).toBeUndefined()
  })

  it('writes createdAt and lastSeenAt verbatim on update', async () => {
    await store.putUpstream(upstream)
    await store.putAccount(account)
    await store.putAccount({ ...account, createdAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-02-02T00:00:00.000Z' })
    const stored = (await store.getAccountByUsername('alice'))!
    expect(stored.createdAt).toBe('2026-01-01T00:00:00.000Z')
    expect(stored.lastSeenAt).toBe('2026-02-02T00:00:00.000Z')
  })
})
