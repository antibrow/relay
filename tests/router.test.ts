import { afterEach, describe, expect, it } from 'vitest'
import { createKvStore } from '../src/adapters/store-kv'
import { legacyTargetFromRequest, routeHttp, type RelayEnv } from '../src/core/router'
import { nodeConnect } from '../src/adapters/socket-node'
import { fakeKv } from './fake-kv'
import { startOriginServer } from './fake-servers'

const closers: { close(): void }[] = []
afterEach(() => { for (const c of closers.splice(0)) c.close() })

const env = (over: Partial<RelayEnv> = {}): RelayEnv => ({
  adminKey: undefined,
  allowPlaintext: false,
  store: createKvStore(fakeKv()),
  connect: nodeConnect,
  ...over,
})

const basic = (u: string, p: string) => `Basic ${btoa(`${u}:${p}`)}`

describe('legacyTargetFromRequest', () => {
  it('reads the target header', () => {
    const url = new URL('https://relay.example/')
    const req = new Request(url, { headers: { 'x-proxy-target': 'http://a.example/p' } })
    expect(legacyTargetFromRequest(req, url)?.href).toBe('http://a.example/p')
  })

  it('reads a target embedded in the path', () => {
    const url = new URL('https://relay.example/http://a.example/p')
    expect(legacyTargetFromRequest(new Request(url), url)?.href).toBe('http://a.example/p')
  })

  it('returns null for an ordinary path', () => {
    const url = new URL('https://relay.example/favicon.ico')
    expect(legacyTargetFromRequest(new Request(url), url)).toBeNull()
  })
})

describe('routeHttp', () => {
  it('404s anything it does not recognise, with no protocol hint', async () => {
    const res = await routeHttp(new Request('https://relay.example/'), env())
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('not found\n')
  })

  it('404s the plaintext forward path while plaintext is off', async () => {
    const req = new Request('https://relay.example/', {
      headers: { 'x-proxy-target': 'http://a.example/', 'proxy-authorization': basic('alice', 'p') },
    })
    expect((await routeHttp(req, env())).status).toBe(404)
  })

  it('401s the plaintext forward path when the credential is wrong', async () => {
    const store = createKvStore(fakeKv())
    await store.putAccount({
      id: 'a1', username: 'alice', password: 'p', upstreamId: 'direct',
      enabled: true, createdAt: '2026-09-10T00:00:00.000Z',
    })
    const req = new Request('https://relay.example/', {
      headers: { 'x-proxy-target': 'http://a.example/', 'proxy-authorization': basic('alice', 'wrong') },
    })
    const res = await routeHttp(req, env({ allowPlaintext: true, store }))
    expect(res.status).toBe(401)
  })

  // Plaintext mode with no credential must not fall through to a direct exit:
  // that would make an enabled deployment an open proxy.
  it('401s the plaintext forward path when no credential is offered at all', async () => {
    const req = new Request('https://relay.example/', {
      headers: { 'x-proxy-target': 'http://a.example/' },
    })
    const res = await routeHttp(req, env({ allowPlaintext: true }))
    expect(res.status).toBe(401)
  })

  it('forwards a plaintext request for a valid account', async () => {
    const origin = await startOriginServer()
    closers.push(origin)
    const store = createKvStore(fakeKv())
    await store.putAccount({
      id: 'a1', username: 'alice', password: 'p', upstreamId: 'direct',
      enabled: true, createdAt: '2026-09-10T00:00:00.000Z',
    })
    const req = new Request('https://relay.example/', {
      headers: {
        'x-proxy-target': `http://127.0.0.1:${origin.port}/p`,
        'proxy-authorization': basic('alice', 'p'),
      },
    })
    const res = await routeHttp(req, env({ allowPlaintext: true, store }))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hello')
  })

  it('serves the admin page and api when an admin key is set', async () => {
    const e = env({ adminKey: 'k' })
    const page = await routeHttp(new Request('https://relay.example/admin'), e)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    const api = await routeHttp(
      new Request('https://relay.example/admin/accounts', { headers: { 'x-admin-key': 'k' } }), e)
    expect(api.status).toBe(200)
  })

  it('404s the admin page when no admin key is set', async () => {
    expect((await routeHttp(new Request('https://relay.example/admin'), env())).status).toBe(404)
  })
})
