import net from 'node:net'
import { Duplex } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { DIRECT_UPSTREAM, type Upstream } from '../src/core/store'
import type { Connect } from '../src/core/types'
import { forwardHttp } from '../src/core/legacy-forward'
import { nodeConnect } from '../src/adapters/socket-node'
import { startHttpProxy, startOriginServer, startSocks5Proxy } from './fake-servers'

const closers: { close(): void }[] = []
afterEach(() => { for (const c of closers.splice(0)) c.close() })

const get = (url: string) => new Request(url, { headers: { 'x-keep': 'yes' } })

/** Same wiring as nodeConnect, but keeps the raw net.Socket around so a test
 *  can assert on it directly - the RelaySocket interface has no way to ask
 *  "are you actually closed". */
function trackingConnect(): { connect: Connect; sockets: net.Socket[] } {
  const sockets: net.Socket[] = []
  const connect: Connect = (host, port) => {
    const sock = net.connect(port, host)
    sockets.push(sock)
    const opened = new Promise<void>((resolve, reject) => {
      sock.once('connect', () => resolve())
      sock.once('error', reject)
    })
    sock.on('error', () => {})
    const web = Duplex.toWeb(sock)
    return {
      readable: web.readable as ReadableStream<Uint8Array>,
      writable: web.writable as WritableStream<Uint8Array>,
      opened,
      close: () => sock.destroy(),
    }
  }
  return { connect, sockets }
}

describe('forwardHttp', () => {
  it('fetches through a direct exit and returns the body', async () => {
    const origin = await startOriginServer()
    closers.push(origin)
    const target = new URL(`http://127.0.0.1:${origin.port}/p`)
    const res = await forwardHttp(get(target.href), target, DIRECT_UPSTREAM, nodeConnect)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hello')
    expect(res.headers.get('content-type')).toBe('text/plain')
    expect(origin.lastRequest()).toContain('GET /p HTTP/1.1')
    expect(origin.lastRequest()).toContain('x-keep: yes')
  })

  // Only large, dynamically generated pages use chunked, so a missing deframer
  // looks like "big pages are garbled" rather than an obvious failure.
  it('deframes a chunked origin response', async () => {
    const origin = await startOriginServer({ chunked: true, body: 'x'.repeat(5000) })
    closers.push(origin)
    const target = new URL(`http://127.0.0.1:${origin.port}/big`)
    const res = await forwardHttp(get(target.href), target, DIRECT_UPSTREAM, nodeConnect)
    expect((await res.text()).length).toBe(5000)
  })

  it('sends an absolute-form request to an http upstream, with its credentials', async () => {
    const origin = await startOriginServer()
    closers.push(origin)
    // requireAuth makes the proxy itself enforce Proxy-Authorization, so a
    // missing or wrong header fails the fixture, not just this assertion.
    const proxy = await startHttpProxy({ requireAuth: 'pu:pp' })
    closers.push(proxy)
    const up: Upstream = {
      id: 'u', name: 'p', protocol: 'http', host: '127.0.0.1', port: proxy.port,
      username: 'pu', password: 'pp',
    }
    const target = new URL(`http://127.0.0.1:${origin.port}/p`)
    const res = await forwardHttp(get(target.href), target, up, nodeConnect)
    expect(await res.text()).toBe('hello')
    expect(origin.lastRequest()).toContain(`GET ${target.href} HTTP/1.1`)
  })

  it('tunnels through a socks5 upstream and speaks origin form', async () => {
    const origin = await startOriginServer()
    closers.push(origin)
    const proxy = await startSocks5Proxy()
    closers.push(proxy)
    const up: Upstream = { id: 'u', name: 's', protocol: 'socks5', host: '127.0.0.1', port: proxy.port }
    const target = new URL(`http://127.0.0.1:${origin.port}/p`)
    const res = await forwardHttp(get(target.href), target, up, nodeConnect)
    expect(await res.text()).toBe('hello')
    expect(origin.lastRequest()).toContain('GET /p HTTP/1.1')
  })

  // Without reader.unshift(leftover), this would still incidentally pass by
  // reading the real origin's own "hello" response instead - so the piggybacked
  // body must differ from the origin's, or a deleted unshift would go unnoticed.
  it('parses a response piggybacked on the socks5 connect reply', async () => {
    const origin = await startOriginServer()
    closers.push(origin)
    const piggyBody = 'PIGGY'
    const piggybacked = `HTTP/1.1 200 OK\r\nContent-Length: ${piggyBody.length}\r\nContent-Type: text/plain\r\n\r\n${piggyBody}`
    const proxy = await startSocks5Proxy({ piggyback: piggybacked })
    closers.push(proxy)
    const up: Upstream = { id: 'u', name: 's', protocol: 'socks5', host: '127.0.0.1', port: proxy.port }
    const target = new URL(`http://127.0.0.1:${origin.port}/p`)
    const res = await forwardHttp(get(target.href), target, up, nodeConnect)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(piggyBody)
  })

  it('streams a request body to the origin', async () => {
    const origin = await startOriginServer()
    closers.push(origin)
    const target = new URL(`http://127.0.0.1:${origin.port}/p`)
    const req = new Request(target.href, { method: 'POST', headers: { 'x-keep': 'yes' }, body: 'payload=1' })
    const res = await forwardHttp(req, target, DIRECT_UPSTREAM, nodeConnect)
    expect(await res.text()).toBe('hello')
    expect(origin.lastRequest()).toContain('POST /p HTTP/1.1')
    expect(origin.lastRequest()).toContain('payload=1')
  })

  it('closes the upstream socket once a successful response body is fully drained', async () => {
    const origin = await startOriginServer({ keepAlive: true })
    closers.push(origin)
    const { connect, sockets } = trackingConnect()
    const target = new URL(`http://127.0.0.1:${origin.port}/p`)
    const res = await forwardHttp(get(target.href), target, DIRECT_UPSTREAM, connect)
    expect(await res.text()).toBe('hello')
    expect(sockets).toHaveLength(1)
    expect(sockets[0]!.destroyed).toBe(true)
  })

  // There is no TLS client here: this path exists for plain-http targets, and
  // https ones go through the tunnel instead. Saying so beats a hung request.
  it('refuses an https target', async () => {
    const target = new URL('https://a.example/')
    const res = await forwardHttp(get(target.href), target, DIRECT_UPSTREAM, nodeConnect)
    expect(res.status).toBe(400)
    expect(await res.text()).toMatch(/tunnel/i)
  })

  it('returns 502 when the origin is unreachable', async () => {
    const target = new URL('http://127.0.0.1:1/')
    const res = await forwardHttp(get(target.href), target, DIRECT_UPSTREAM, nodeConnect)
    expect(res.status).toBe(502)
  })
})
