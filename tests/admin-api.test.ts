import { describe, expect, it } from 'vitest'
import { createKvStore } from '../src/adapters/store-kv'
import { handleAdminApi } from '../src/admin/api'
import { fakeKv } from './fake-kv'

const KEY = 'admin-secret'
const store = () => createKvStore(fakeKv())

// Regular function (not an arrow) so `arguments.length` is available: a plain
// default parameter also fires when a caller passes `undefined` explicitly,
// which is exactly how the "missing key" tests below invoke this helper. Only
// `arguments.length` can tell "omitted" apart from "passed as undefined".
function call(
  s: ReturnType<typeof store>,
  method: string,
  path: string,
  body?: unknown,
  key?: string,
  adminKey?: string,
): Promise<Response | null> {
  const k = arguments.length >= 5 ? key : KEY
  const ak = arguments.length >= 6 ? adminKey : KEY
  const url = new URL(`https://relay.example${path}`)
  const req = new Request(url, {
    method,
    headers: k ? { 'x-admin-key': k, 'content-type': 'application/json' } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return handleAdminApi(req, url, s, ak)
}

describe('admin api', () => {
  it('ignores paths it does not own', async () => {
    expect(await call(store(), 'GET', '/')).toBeNull()
  })

  // A deployment with no admin key must not expose the surface at all, and must
  // not advertise that it exists either.
  it('404s the whole surface when no admin key is configured', async () => {
    const res = await call(store(), 'GET', '/admin/accounts', undefined, undefined, undefined)
    expect(res?.status).toBe(404)
  })

  it('401s a wrong or missing key', async () => {
    expect((await call(store(), 'GET', '/admin/accounts', undefined, 'nope'))?.status).toBe(401)
    expect((await call(store(), 'GET', '/admin/accounts', undefined, undefined))?.status).toBe(401)
  })

  it('creates an upstream and returns it with an id', async () => {
    const s = store()
    const res = await call(s, 'POST', '/admin/upstreams', {
      name: 'res', protocol: 'socks5', host: 'gw.example', port: 1080, username: 'u', password: 'p',
    })
    expect(res?.status).toBe(200)
    const created = (await res!.json()) as { id: string; password?: string }
    expect(created.id).toMatch(/^[0-9a-f]{16}$/)
    expect(created.password).toBe('***')
    expect(await s.getUpstream(created.id)).toMatchObject({ password: 'p' })
  })

  it('creates an account, masking the password in the response', async () => {
    const s = store()
    await s.putUpstream({ id: 'up1', name: 'res', protocol: 'direct' })
    const res = await call(s, 'POST', '/admin/accounts', { username: 'alice', password: 's3cret', upstreamId: 'up1' })
    const created = (await res!.json()) as { id: string; password: string; enabled: boolean; createdAt: string }
    expect(created.password).toBe('***')
    expect(created.enabled).toBe(true)
    expect(Number.isNaN(Date.parse(created.createdAt))).toBe(false)
    expect((await s.getAccountByUsername('alice'))!.password).toBe('s3cret')
  })

  it('keeps the stored password when an update omits it', async () => {
    const s = store()
    await s.putUpstream({ id: 'up1', name: 'res', protocol: 'direct' })
    const created = (await (await call(s, 'POST', '/admin/accounts', {
      username: 'alice', password: 's3cret', upstreamId: 'up1',
    }))!.json()) as { id: string }
    await call(s, 'POST', '/admin/accounts', { id: created.id, username: 'alice', upstreamId: 'up1', enabled: false })
    const stored = (await s.getAccountByUsername('alice'))!
    expect(stored.password).toBe('s3cret')
    expect(stored.enabled).toBe(false)
  })

  it('keeps a disabled account disabled when an unrelated update omits enabled', async () => {
    const s = store()
    await s.putUpstream({ id: 'up1', name: 'res', protocol: 'direct' })
    const created = (await (await call(s, 'POST', '/admin/accounts', {
      username: 'alice', password: 'p', upstreamId: 'up1', enabled: false,
    }))!.json()) as { id: string }
    await call(s, 'POST', '/admin/accounts', { id: created.id, username: 'alice', upstreamId: 'up1', note: 'x' })
    const stored = (await s.getAccountByUsername('alice'))!
    expect(stored.enabled).toBe(false)
  })

  it('keeps the stored password when an update echoes back the literal mask', async () => {
    const s = store()
    await s.putUpstream({ id: 'up1', name: 'res', protocol: 'direct' })
    const created = (await (await call(s, 'POST', '/admin/accounts', {
      username: 'alice', password: 's3cret', upstreamId: 'up1',
    }))!.json()) as { id: string; password: string }
    await call(s, 'POST', '/admin/accounts', {
      id: created.id, username: 'alice', upstreamId: 'up1', password: created.password,
    })
    expect((await s.getAccountByUsername('alice'))!.password).toBe('s3cret')
  })

  it('keeps the stored upstream password when an update omits it', async () => {
    const s = store()
    const created = (await (await call(s, 'POST', '/admin/upstreams', {
      name: 'res', protocol: 'socks5', host: 'gw.example', port: 1080, password: 'p',
    }))!.json()) as { id: string }
    await call(s, 'POST', '/admin/upstreams', {
      id: created.id, name: 'res', protocol: 'socks5', host: 'gw.example', port: 1080,
    })
    expect((await s.getUpstream(created.id))!.password).toBe('p')
  })

  it('clears host and port when an upstream is converted to direct', async () => {
    const s = store()
    const created = (await (await call(s, 'POST', '/admin/upstreams', {
      name: 'res', protocol: 'http', host: 'gw.example', port: 8080,
    }))!.json()) as { id: string }
    await call(s, 'POST', '/admin/upstreams', { id: created.id, name: 'res', protocol: 'direct' })
    const stored = (await s.getUpstream(created.id))!
    expect(stored.host).toBeUndefined()
    expect(stored.port).toBeUndefined()
  })

  it('rejects an account pointing at a missing upstream', async () => {
    const res = await call(store(), 'POST', '/admin/accounts', { username: 'a', password: 'b', upstreamId: 'ghost' })
    expect(res?.status).toBe(400)
  })

  it('rejects an invalid protocol and a missing username', async () => {
    expect((await call(store(), 'POST', '/admin/upstreams', { name: 'x', protocol: 'ftp' }))?.status).toBe(400)
    expect((await call(store(), 'POST', '/admin/accounts', { password: 'b', upstreamId: 'x' }))?.status).toBe(400)
  })

  it('lists with secrets masked', async () => {
    const s = store()
    await s.putUpstream({ id: 'up1', name: 'res', protocol: 'http', host: 'h', port: 1, password: 'p' })
    const rows = (await (await call(s, 'GET', '/admin/upstreams'))!.json()) as { password: string }[]
    expect(rows[0]!.password).toBe('***')
  })

  it('deletes an account', async () => {
    const s = store()
    await s.putUpstream({ id: 'up1', name: 'res', protocol: 'direct' })
    const created = (await (await call(s, 'POST', '/admin/accounts', {
      username: 'alice', password: 'p', upstreamId: 'up1',
    }))!.json()) as { id: string }
    expect((await call(s, 'DELETE', `/admin/accounts/${created.id}`))?.status).toBe(200)
    expect(await s.listAccounts()).toEqual([])
  })

  // Deleting a referenced upstream would silently turn those accounts into
  // direct exits, which is the one change nobody wants to happen by accident.
  it('refuses to delete an upstream that accounts still reference', async () => {
    const s = store()
    await s.putUpstream({ id: 'up1', name: 'res', protocol: 'direct' })
    await call(s, 'POST', '/admin/accounts', { username: 'alice', password: 'p', upstreamId: 'up1' })
    const res = await call(s, 'DELETE', '/admin/upstreams/up1')
    expect(res?.status).toBe(409)
    expect(await res!.text()).toContain('alice')
  })
})
