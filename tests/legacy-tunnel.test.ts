import http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { DIRECT_UPSTREAM, type Upstream } from '../src/core/store'
import { READY, startLegacyTunnel } from '../src/core/legacy-tunnel'
import { nodeConnect } from '../src/adapters/socket-node'
import { nodeWs } from '../src/adapters/ws-node'
import { startEchoServer, startHttpProxy } from './fake-servers'

const closers: { close(): void }[] = []
afterEach(() => { for (const c of closers.splice(0)) c.close() })

async function startServer(host: string, port: number, upstream: Upstream) {
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end() })
  const wss = new WebSocketServer({ server })
  wss.on('connection', (sock) => {
    startLegacyTunnel(nodeWs(sock), { host, port, upstream, connect: nodeConnect })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const p = (server.address() as { port: number }).port
  const handle = { port: p, close: () => { wss.close(); server.close() } }
  closers.push(handle)
  return handle
}

function collect(url: string) {
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'
  const frames: (string | Uint8Array)[] = []
  let closed = false
  let nextIndex = 0
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  ws.on('message', (d, isBinary) => frames.push(isBinary ? new Uint8Array(d as ArrayBuffer) : String(d)))
  ws.on('close', () => { closed = true })
  ws.on('error', () => {})
  return {
    frames,
    opened,
    get closed() { return closed },
    send: (t: string) => ws.send(Buffer.from(t)),
    close: () => ws.close(),
    waitFor: async (n: number) => {
      for (let i = 0; i < 200 && frames.length < n; i++) await new Promise((r) => setTimeout(r, 20))
      return frames
    },
    waitClosed: async () => {
      for (let i = 0; i < 200 && !closed; i++) await new Promise((r) => setTimeout(r, 20))
      return closed
    },
    // Consumes frames in arrival order, decoding each to text. Callers that care
    // about a byte stream rather than a message boundary accumulate the result
    // until it reaches the expected length, never index into `frames` directly.
    nextText: async () => {
      for (let i = 0; i < 200 && frames.length <= nextIndex; i++) await new Promise((r) => setTimeout(r, 20))
      const f = frames[nextIndex++]
      if (f === undefined) throw new Error('timed out waiting for the next frame')
      return typeof f === 'string' ? f : new TextDecoder().decode(f)
    },
  }
}

describe('legacy plaintext tunnel', () => {
  it('sends READY then relays raw bytes', async () => {
    const echo = await startEchoServer()
    closers.push(echo)
    const relay = await startServer('127.0.0.1', echo.port, DIRECT_UPSTREAM)
    const c = collect(`ws://127.0.0.1:${relay.port}/?host=127.0.0.1&port=${echo.port}`)
    await c.waitFor(1)
    expect(c.frames[0]).toBe('READY')
    c.send('ping')
    await c.waitFor(2)
    expect(new TextDecoder().decode(c.frames[1] as Uint8Array)).toBe('PING')
    c.close()
  })

  it('goes through the account upstream', async () => {
    const echo = await startEchoServer()
    closers.push(echo)
    const proxy = await startHttpProxy({ requireAuth: 'pu:pp' })
    closers.push(proxy)
    const up: Upstream = {
      id: 'up1', name: 'res', protocol: 'http', host: '127.0.0.1', port: proxy.port,
      username: 'pu', password: 'pp',
    }
    const relay = await startServer('127.0.0.1', echo.port, up)
    const c = collect(`ws://127.0.0.1:${relay.port}/?host=127.0.0.1&port=${echo.port}`)
    await c.waitFor(1)
    expect(c.frames[0]).toBe('READY')
    c.send('ping')
    await c.waitFor(2)
    expect(new TextDecoder().decode(c.frames[1] as Uint8Array)).toBe('PING')
    c.close()
  })

  // READY must not go out before the upstream is actually connected: the client
  // treats it as permission to start its TLS handshake.
  it('never sends READY when the target is unreachable', async () => {
    const relay = await startServer('127.0.0.1', 1, DIRECT_UPSTREAM)
    const c = collect(`ws://127.0.0.1:${relay.port}/?host=127.0.0.1&port=1`)
    expect(await c.waitClosed()).toBe(true)
    expect(c.frames).toEqual([])
  })

  it('forwards bytes that arrived alongside the upstream handshake reply', async () => {
    const echo = await startEchoServer()
    closers.push(echo)
    const proxy = await startHttpProxy({ piggyback: 'EARLY' })
    closers.push(proxy)
    const up: Upstream = { id: 'up1', name: 'res', protocol: 'http', host: '127.0.0.1', port: proxy.port }
    const relay = await startServer('127.0.0.1', echo.port, up)
    const c = collect(`ws://127.0.0.1:${relay.port}/?host=127.0.0.1&port=${echo.port}`)
    await c.waitFor(2)
    expect(c.frames[0]).toBe('READY')
    expect(new TextDecoder().decode(c.frames[1] as Uint8Array)).toBe('EARLY')
    c.close()
  })

  // Nothing awaits READY before sending here: this is exactly the invariant the
  // no-separate-queue design relies on. A regression to a naive per-message
  // writer.write() (losing the hold-until-dial-resolves property) would still
  // pass every other test in this file, because they all wait for READY first.
  it('holds inbound bytes sent before the delayed dial resolves, then delivers them in order', async () => {
    const echo = await startEchoServer()
    closers.push(echo)
    const proxy = await startHttpProxy({ delayMs: 300 })
    closers.push(proxy)
    const up: Upstream = { id: 'up1', name: 'res', protocol: 'http', host: '127.0.0.1', port: proxy.port }
    const relay = await startServer('127.0.0.1', echo.port, up)
    const c = collect(`ws://127.0.0.1:${relay.port}/?host=127.0.0.1&port=${echo.port}`)
    await c.opened
    c.send('one')
    c.send('two')
    c.send('three')
    expect(await c.nextText()).toBe(READY)
    let seen = ''
    while (seen.length < 'ONETWOTHREE'.length) seen += await c.nextText()
    expect(seen).toBe('ONETWOTHREE')
    c.close()
  })
})
