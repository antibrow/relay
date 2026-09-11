import { afterEach, describe, expect, it } from 'vitest'
import { DIRECT_UPSTREAM, type Upstream } from '../src/core/store'
import { dial } from '../src/core/upstream'
import { nodeConnect } from '../src/adapters/socket-node'
import { startEchoServer, startHttpProxy } from './fake-servers'

const closers: { close(): void }[] = []
afterEach(() => { for (const c of closers.splice(0)) c.close() })

async function roundTrip(socket: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }, text: string) {
  const writer = socket.writable.getWriter()
  await writer.write(new TextEncoder().encode(text))
  writer.releaseLock()
  const reader = socket.readable.getReader()
  const { value } = await reader.read()
  reader.releaseLock()
  return new TextDecoder().decode(value)
}

describe('dial', () => {
  it('connects straight to the target when the upstream is direct', async () => {
    const echo = await startEchoServer()
    closers.push(echo)
    const { socket, leftover } = await dial(DIRECT_UPSTREAM, '127.0.0.1', echo.port, nodeConnect)
    expect(leftover).toEqual(new Uint8Array(0))
    expect(await roundTrip(socket, 'ping')).toBe('PING')
    socket.close()
  })

  it('tunnels through an http upstream', async () => {
    const echo = await startEchoServer()
    closers.push(echo)
    const proxy = await startHttpProxy()
    closers.push(proxy)
    const up: Upstream = { id: 'u', name: 'p', protocol: 'http', host: '127.0.0.1', port: proxy.port }
    const { socket } = await dial(up, '127.0.0.1', echo.port, nodeConnect)
    expect(await roundTrip(socket, 'ping')).toBe('PING')
    socket.close()
  })

  it('sends Proxy-Authorization when the upstream has credentials', async () => {
    const echo = await startEchoServer()
    closers.push(echo)
    const proxy = await startHttpProxy({ requireAuth: 'pu:pp' })
    closers.push(proxy)
    const up: Upstream = {
      id: 'u', name: 'p', protocol: 'http', host: '127.0.0.1', port: proxy.port,
      username: 'pu', password: 'pp',
    }
    const { socket } = await dial(up, '127.0.0.1', echo.port, nodeConnect)
    expect(await roundTrip(socket, 'ping')).toBe('PING')
    socket.close()
  })

  it('fails when the upstream refuses the CONNECT', async () => {
    const proxy = await startHttpProxy({ refuseWith: 403 })
    closers.push(proxy)
    const up: Upstream = { id: 'u', name: 'p', protocol: 'http', host: '127.0.0.1', port: proxy.port }
    await expect(dial(up, '127.0.0.1', 9, nodeConnect)).rejects.toThrow(/403/)
  })

  it('fails when credentials are wrong', async () => {
    const proxy = await startHttpProxy({ requireAuth: 'pu:pp' })
    closers.push(proxy)
    const up: Upstream = { id: 'u', name: 'p', protocol: 'http', host: '127.0.0.1', port: proxy.port }
    await expect(dial(up, '127.0.0.1', 9, nodeConnect)).rejects.toThrow(/407/)
  })

  // The bug this guards: the CONNECT reply and the first tunnel bytes arrive in
  // one segment, so anything read past the terminator has to reach the caller.
  it('returns bytes that arrived alongside the CONNECT reply', async () => {
    const echo = await startEchoServer()
    closers.push(echo)
    const proxy = await startHttpProxy({ piggyback: 'EARLY' })
    closers.push(proxy)
    const up: Upstream = { id: 'u', name: 'p', protocol: 'http', host: '127.0.0.1', port: proxy.port }
    const { socket, leftover } = await dial(up, '127.0.0.1', echo.port, nodeConnect)
    expect(new TextDecoder().decode(leftover)).toBe('EARLY')
    socket.close()
  })

  it('rejects an upstream row with no host or port', async () => {
    const up: Upstream = { id: 'u', name: 'broken', protocol: 'http' }
    await expect(dial(up, 'a.example', 443, nodeConnect)).rejects.toThrow(/host or port/)
  })
})
