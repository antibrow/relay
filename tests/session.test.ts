import http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { deriveKeys, keyFromBase64Url, open, randomKeyBase64Url, seal, SALT_LEN } from '../src/protocol/crypto'
import { encodeInit } from '../src/protocol/frames'
import type { Account, RelayStore, Upstream } from '../src/core/store'
import { startEncryptedSession } from '../src/core/session'
import { nodeConnect } from '../src/adapters/socket-node'
import { nodeWs } from '../src/adapters/ws-node'
import { relayClient } from './fake-client'
import { startEchoServer, startHttpProxy } from './fake-servers'

const KEY = randomKeyBase64Url()
const closers: { close(): void }[] = []
afterEach(() => { for (const c of closers.splice(0)) c.close() })

function memStore(accounts: Account[], upstreams: Upstream[]): RelayStore & { touched: string[] } {
  const touched: string[] = []
  return {
    touched,
    async listAccounts() { return accounts },
    async getAccountByUsername(u) { return accounts.find((a) => a.username === u) ?? null },
    async putAccount() {}, async deleteAccount() {},
    async touchAccount(id) { touched.push(id) },
    async listUpstreams() { return upstreams },
    async getUpstream(id) { return upstreams.find((u) => u.id === id) ?? null },
    async putUpstream() {}, async deleteUpstream() {},
  }
}

async function startServer(store: RelayStore) {
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end() })
  const wss = new WebSocketServer({ server })
  wss.on('connection', (sock) => {
    startEncryptedSession(nodeWs(sock), { key: keyFromBase64Url(KEY), store, connect: nodeConnect })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  const handle = { port, close: () => { wss.close(); server.close() } }
  closers.push(handle)
  return handle
}

const account: Account = {
  id: 'a1', username: 'alice', password: 's3cret', upstreamId: 'up1',
  enabled: true, createdAt: '2026-09-10T00:00:00.000Z',
}

describe('encrypted session', () => {
  it('tunnels with no credential (single-tenant mode)', async () => {
    const echo = await startEchoServer()
    closers.push(echo)
    const relay = await startServer(memStore([], []))
    const client = await relayClient(`ws://127.0.0.1:${relay.port}/`, KEY, { host: '127.0.0.1', port: echo.port })
    expect(client.status).toBe(0)
    await client.send('ping')
    expect(await client.next()).toBe('PING')
    client.close()
  })

  it('routes an authenticated account through its upstream', async () => {
    const echo = await startEchoServer()
    closers.push(echo)
    const proxy = await startHttpProxy({ requireAuth: 'pu:pp' })
    closers.push(proxy)
    const upstream: Upstream = {
      id: 'up1', name: 'res', protocol: 'http', host: '127.0.0.1', port: proxy.port,
      username: 'pu', password: 'pp',
    }
    const store = memStore([account], [upstream])
    const relay = await startServer(store)
    const client = await relayClient(`ws://127.0.0.1:${relay.port}/`, KEY, {
      host: '127.0.0.1', port: echo.port, cred: 'alice:s3cret',
    })
    expect(client.status).toBe(0)
    await client.send('ping')
    expect(await client.next()).toBe('PING')
    expect(store.touched).toContain('a1')
    client.close()
  })

  // Pins the property docs/PROTOCOL.md's Limits section and DEPLOY.md now state
  // plainly: on a multi-account relay, an omitted credential is not "no access" -
  // it resolves to the relay's own direct egress, same as the single-tenant case,
  // even though accounts exist and are the intended access path.
  it('tunnels through the direct exit with an empty credential even when accounts exist', async () => {
    const echo = await startEchoServer()
    closers.push(echo)
    const upstream: Upstream = {
      id: 'up1', name: 'res', protocol: 'http', host: '127.0.0.1', port: 9,
      username: 'pu', password: 'pp',
    }
    const store = memStore([account], [upstream])
    const relay = await startServer(store)
    const client = await relayClient(`ws://127.0.0.1:${relay.port}/`, KEY, { host: '127.0.0.1', port: echo.port })
    expect(client.status).toBe(0)
    await client.send('ping')
    expect(await client.next()).toBe('PING')
    // No account was resolved, so nothing was touched.
    expect(store.touched).toEqual([])
    client.close()
  })

  it('closes silently on a bad credential, sending no protocol reply', async () => {
    const relay = await startServer(memStore([account], []))
    await expect(relayClient(`ws://127.0.0.1:${relay.port}/`, KEY, {
      host: '127.0.0.1', port: 9, cred: 'alice:wrong',
    })).rejects.toThrow()
  })

  it('closes silently on a credential with no colon', async () => {
    const relay = await startServer(memStore([account], []))
    await expect(relayClient(`ws://127.0.0.1:${relay.port}/`, KEY, {
      host: '127.0.0.1', port: 9, cred: 'nocolon',
    })).rejects.toThrow()
  })

  it('closes silently when the frame cannot be decrypted', async () => {
    const relay = await startServer(memStore([], []))
    await expect(relayClient(`ws://127.0.0.1:${relay.port}/`, randomKeyBase64Url(), {
      host: '127.0.0.1', port: 9,
    })).rejects.toThrow()
  })

  it('closes the socket when the target is unreachable', async () => {
    const relay = await startServer(memStore([], []))
    await expect(relayClient(`ws://127.0.0.1:${relay.port}/`, KEY, { host: '127.0.0.1', port: 1 }))
      .rejects.toThrow()
  })

  // The race the promise chains exist for: data frames sent before the status
  // reply must still reach the upstream in send order.
  it('flushes frames that arrive before the upstream is ready, in order', async () => {
    const echo = await startEchoServer()
    closers.push(echo)
    const relay = await startServer(memStore([], []))
    const client = await relayClient(`ws://127.0.0.1:${relay.port}/`, KEY, { host: '127.0.0.1', port: echo.port })
    await Promise.all([client.send('a'), client.send('b'), client.send('c')])
    let seen = ''
    while (seen.length < 3) seen += await client.next()
    expect(seen).toBe('ABC')
    client.close()
  })

  it('splits an upstream burst into frames no larger than the plaintext limit', async () => {
    const echo = await startEchoServer()
    closers.push(echo)
    const relay = await startServer(memStore([], []))
    const client = await relayClient(`ws://127.0.0.1:${relay.port}/`, KEY, { host: '127.0.0.1', port: echo.port })
    // Non-homogeneous, so a reordering or aliasing bug changes the content and not
    // just its length.
    const sent = Array.from({ length: 40000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('')
    await client.send(sent)
    let seen = ''
    let frames = 0
    while (seen.length < 40000) {
      seen += await client.next()
      frames++
    }
    expect(seen).toBe(sent.toUpperCase())
    expect(frames).toBeGreaterThan(1)
    client.close()
  })

  it('delivers frames pipelined behind the init frame in send order', async () => {
    const echo = await startEchoServer()
    closers.push(echo)
    const relay = await startServer(memStore([], []))

    // A raw client, not relayClient: relayClient always waits for the status
    // frame before sending anything, which is exactly the case this test must
    // avoid to exercise real pipelining.
    const psk = keyFromBase64Url(KEY)
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN))
    const { c2s, s2c } = await deriveKeys(psk, salt)
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/`)
    ws.binaryType = 'arraybuffer'
    closers.push({ close: () => ws.close() })

    // Message delivery, decoupled from how many WebSocket messages the reply
    // arrives as: the upstream leg is a byte stream, so the three echoed bytes
    // can legitimately arrive coalesced into one frame instead of three. Only
    // accumulated content length is a property of a byte stream; a frame count
    // is not.
    const inbox: Uint8Array[] = []
    const waiters: ((v: Uint8Array) => void)[] = []
    let recvCtr = 0n
    // Decryption runs on the threadpool and can finish out of order relative to
    // WebSocket arrival, so a promise chain re-serializes delivery back into send
    // order (same shape as src/probe.ts and tests/fake-client.ts).
    let chain: Promise<void> = Promise.resolve()
    ws.on('message', (data) => {
      chain = chain.then(async () => {
        const pt = await open(s2c, recvCtr++, new Uint8Array(data as ArrayBuffer))
        const w = waiters.shift()
        if (w) w(pt)
        else inbox.push(pt)
      }).catch(() => {})
    })
    const nextText = () =>
      new Promise<string>((resolve) => {
        const pending = inbox.shift()
        if (pending) { resolve(new TextDecoder().decode(pending)); return }
        waiters.push((v) => resolve(new TextDecoder().decode(v)))
      })

    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })

    const sealedInit = await seal(c2s, 0n, encodeInit({ host: '127.0.0.1', port: echo.port }))
    const initFrame = new Uint8Array(SALT_LEN + sealedInit.length)
    initFrame.set(salt, 0)
    initFrame.set(sealedInit, SALT_LEN)
    ws.send(initFrame)
    // Sent right behind the init frame, before any status reply can have arrived.
    ws.send(await seal(c2s, 1n, new TextEncoder().encode('a')))
    ws.send(await seal(c2s, 2n, new TextEncoder().encode('b')))
    ws.send(await seal(c2s, 3n, new TextEncoder().encode('c')))

    await nextText() // status frame
    let seen = ''
    while (seen.length < 3) seen += await nextText()
    expect(seen).toBe('ABC')
    ws.close()
  })
})
