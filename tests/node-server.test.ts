import { mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { randomKeyBase64Url } from '../src/protocol/crypto'
import { startNodeRelay } from '../src/node'
import { probe } from '../src/probe'
import { relayClient } from './fake-client'
import { startEchoServer, startOriginServer } from './fake-servers'

/** Declares a Content-Length longer than the body it actually sends, then
 *  destroys the connection - the shape a real upstream failure takes once
 *  headers are already out the door. */
function startTruncatingOrigin(opts: { declared: number; body: string }) {
  return new Promise<{ port: number; close(): void }>((resolve) => {
    const server = net.createServer((sock) => {
      let head = ''
      sock.on('error', () => {})
      sock.on('data', (chunk) => {
        head += chunk.toString('latin1')
        if (head.includes('\r\n\r\n')) {
          sock.write(
            `HTTP/1.1 200 OK\r\nContent-Length: ${opts.declared}\r\nContent-Type: text/plain\r\n\r\n${opts.body}`,
            () => sock.destroy(),
          )
        }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo
      resolve({ port: addr.port, close: () => server.close() })
    })
  })
}

const KEY = randomKeyBase64Url()
const dirs: string[] = []
const stops: (() => Promise<void>)[] = []
const closers: { close(): void }[] = []

afterEach(async () => {
  for (const s of stops.splice(0)) await s()
  for (const c of closers.splice(0)) c.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function relay(extra: Partial<Parameters<typeof startNodeRelay>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-node-'))
  dirs.push(dir)
  const server = await startNodeRelay({ port: 0, dbPath: join(dir, 'relay.db'), key: KEY, adminKey: 'k', ...extra })
  stops.push(server.close)
  return server
}

describe('node relay', () => {
  it('serves the encrypted tunnel', async () => {
    const echo = await startEchoServer()
    closers.push(echo)
    const server = await relay()
    const client = await relayClient(`ws://127.0.0.1:${server.port}/`, KEY, { host: '127.0.0.1', port: echo.port })
    expect(client.status).toBe(0)
    await client.send('ping')
    expect(await client.next()).toBe('PING')
    client.close()
  })

  it('serves the admin api', async () => {
    const server = await relay()
    const res = await fetch(`http://127.0.0.1:${server.port}/admin/accounts`, { headers: { 'x-admin-key': 'k' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('404s an ordinary request', async () => {
    const server = await relay()
    expect((await fetch(`http://127.0.0.1:${server.port}/`)).status).toBe(404)
  })

  it('rejects the plaintext tunnel unless plaintext is enabled', async () => {
    const echo = await startEchoServer()
    closers.push(echo)
    const server = await relay()
    const res = await fetch(`http://127.0.0.1:${server.port}/?host=127.0.0.1&port=${echo.port}`)
    expect(res.status).toBe(404)
  })

  it('serves the plaintext tunnel once enabled, for a valid account', async () => {
    const echo = await startEchoServer()
    closers.push(echo)
    const server = await relay({ allowPlaintext: true })
    await fetch(`http://127.0.0.1:${server.port}/admin/accounts`, {
      method: 'POST',
      headers: { 'x-admin-key': 'k', 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'p', upstreamId: 'direct' }),
    })
    const { WebSocket } = await import('ws')
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/?host=127.0.0.1&port=${echo.port}`, {
      headers: { 'proxy-authorization': `Basic ${Buffer.from('alice:p').toString('base64')}` },
    })
    const first = await new Promise<string>((resolve, reject) => {
      ws.once('message', (d) => resolve(String(d)))
      ws.once('close', () => reject(new Error('closed')))
      ws.once('error', reject)
    })
    expect(first).toBe('READY')
    ws.close()
  })

  it('closes the plaintext tunnel when the credential is wrong', async () => {
    const echo = await startEchoServer()
    closers.push(echo)
    const server = await relay({ allowPlaintext: true })
    const { WebSocket } = await import('ws')
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/?host=127.0.0.1&port=${echo.port}`)
    await expect(new Promise((resolve, reject) => {
      ws.once('message', resolve)
      ws.once('close', () => reject(new Error('closed')))
      ws.once('error', reject)
    })).rejects.toThrow()
  })

  // probe is the command an operator runs right after deploying, so it has to
  // exercise the real tunnel rather than just ping the endpoint.
  it('probe fetches a url through the tunnel', async () => {
    const origin = await startOriginServer({ body: 'from-origin' })
    closers.push(origin)
    const server = await relay()
    const out = await probe({
      relayUrl: `ws://127.0.0.1:${server.port}/`,
      key: KEY,
      targetUrl: `http://127.0.0.1:${origin.port}/ip`,
    })
    expect(out.status).toBe(200)
    expect(out.body).toBe('from-origin')
  })

  // Finding 1 (task 15, fix round 2): an upstream failure after the response
  // head is already out used to throw inside a .catch and take the whole
  // process down with it - a remote denial of service for every other client.
  it('stays alive when an upstream fails mid-response through the plaintext forward path', async () => {
    const origin = await startTruncatingOrigin({ declared: 1000, body: 'short' })
    closers.push(origin)
    const server = await relay({ allowPlaintext: true })
    await fetch(`http://127.0.0.1:${server.port}/admin/accounts`, {
      method: 'POST',
      headers: { 'x-admin-key': 'k', 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'p', upstreamId: 'direct' }),
    })
    const auth = `Basic ${Buffer.from('alice:p').toString('base64')}`
    // The upstream drops mid-response; whatever the client sees here, the
    // relay process itself must not go down with it.
    await fetch(`http://127.0.0.1:${server.port}/`, {
      headers: { 'x-proxy-target': `http://127.0.0.1:${origin.port}/`, 'proxy-authorization': auth },
    }).catch(() => {})
    // A second, ordinary request through the same server is the clearest way
    // to say the relay survived, not just that it had not exited yet.
    const res = await fetch(`http://127.0.0.1:${server.port}/admin/accounts`, { headers: { 'x-admin-key': 'k' } })
    expect(res.status).toBe(200)
  })

  // Headers.forEach visits set-cookie once per value; collapsing that into a
  // plain string map kept only the last one and silently dropped the rest.
  it('preserves repeated Set-Cookie headers through the plaintext forward path', async () => {
    const origin = await startOriginServer({
      body: 'ok',
      extraHeaders: ['Set-Cookie: a=1', 'Set-Cookie: b=2'],
    })
    closers.push(origin)
    const server = await relay({ allowPlaintext: true })
    await fetch(`http://127.0.0.1:${server.port}/admin/accounts`, {
      method: 'POST',
      headers: { 'x-admin-key': 'k', 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'p', upstreamId: 'direct' }),
    })
    const auth = `Basic ${Buffer.from('alice:p').toString('base64')}`
    const res = await fetch(`http://127.0.0.1:${server.port}/`, {
      headers: { 'x-proxy-target': `http://127.0.0.1:${origin.port}/`, 'proxy-authorization': auth },
    })
    expect(res.headers.getSetCookie().sort()).toEqual(['a=1', 'b=2'])
  })

  // Finding 2 (task 15, fix round 2): "connection closed" is not "message
  // complete" - a false 200 on a truncated body is worse than an honest failure.
  it('probe fails rather than reporting success on a truncated response', async () => {
    const origin = await startTruncatingOrigin({ declared: 1000, body: 'short' })
    closers.push(origin)
    const server = await relay()
    await expect(probe({
      relayUrl: `ws://127.0.0.1:${server.port}/`,
      key: KEY,
      targetUrl: `http://127.0.0.1:${origin.port}/`,
    })).rejects.toThrow()
  })

  // Finding 1 (task 16, fix round 1): a malformed FP_RELAY_KEY used to throw
  // synchronously at startup on Node, crashing the process, while the Worker
  // degraded gracefully for the same input - one requirement, two outcomes.
  it('stays up with a malformed key: no throw, admin still works, encrypted upgrade refused', async () => {
    const server = await relay({ key: 'not-a-key' })
    expect(server.keyAccepted).toBe(false)
    const res = await fetch(`http://127.0.0.1:${server.port}/admin/accounts`, { headers: { 'x-admin-key': 'k' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
    // Not relayClient(): with no key the server closes before any frame is
    // exchanged, which races relayClient's own open/nextRaw sequencing and is
    // flaky under load. A raw socket that only watches for message-vs-close
    // has no such race, matching the plaintext-credential-rejection test below.
    const { WebSocket } = await import('ws')
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`)
    await expect(new Promise((resolve, reject) => {
      ws.once('message', resolve)
      ws.once('close', () => reject(new Error('closed')))
      ws.once('error', reject)
    })).rejects.toThrow()
  })

  // Finding 3 (task 15, fix round 2): dechunk() had no coverage anywhere in
  // this task's suite, despite the brief explicitly requiring it.
  it('probe reassembles a chunked response', async () => {
    const origin = await startOriginServer({ chunked: true, body: 'chunked-body' })
    closers.push(origin)
    const server = await relay()
    const out = await probe({
      relayUrl: `ws://127.0.0.1:${server.port}/`,
      key: KEY,
      targetUrl: `http://127.0.0.1:${origin.port}/`,
    })
    expect(out.status).toBe(200)
    expect(out.body).toBe('chunked-body')
  })
})
