import { afterEach, describe, expect, it } from 'vitest'
import type { Upstream } from '../src/core/store'
import { dial } from '../src/core/upstream'
import { nodeConnect } from '../src/adapters/socket-node'
import { startEchoServer, startSocks5Proxy } from './fake-servers'

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

const up = (port: number, extra: Partial<Upstream> = {}): Upstream => ({
  id: 'u', name: 's', protocol: 'socks5', host: '127.0.0.1', port, ...extra,
})

describe('socks5 upstream', () => {
  it('tunnels with no authentication', async () => {
    const echo = await startEchoServer()
    closers.push(echo)
    const proxy = await startSocks5Proxy()
    closers.push(proxy)
    const { socket } = await dial(up(proxy.port), '127.0.0.1', echo.port, nodeConnect)
    expect(await roundTrip(socket, 'ping')).toBe('PING')
    socket.close()
  })

  it('performs the username/password sub-negotiation', async () => {
    const echo = await startEchoServer()
    closers.push(echo)
    const proxy = await startSocks5Proxy({ requireAuth: ['su', 'sp'] })
    closers.push(proxy)
    const { socket } = await dial(up(proxy.port, { username: 'su', password: 'sp' }), '127.0.0.1', echo.port, nodeConnect)
    expect(await roundTrip(socket, 'ping')).toBe('PING')
    socket.close()
  })

  it('fails on wrong credentials', async () => {
    const proxy = await startSocks5Proxy({ requireAuth: ['su', 'sp'] })
    closers.push(proxy)
    await expect(dial(up(proxy.port, { username: 'su', password: 'bad' }), '127.0.0.1', 9, nodeConnect))
      .rejects.toThrow(/credentials/)
  })

  it('fails when the upstream demands auth we cannot provide', async () => {
    const proxy = await startSocks5Proxy({ requireAuth: ['su', 'sp'] })
    closers.push(proxy)
    await expect(dial(up(proxy.port), '127.0.0.1', 9, nodeConnect)).rejects.toThrow()
  })

  it('fails when the upstream refuses the connect', async () => {
    const proxy = await startSocks5Proxy({ refuseWith: 5 })
    closers.push(proxy)
    await expect(dial(up(proxy.port), '127.0.0.1', 9, nodeConnect)).rejects.toThrow(/rep 5/)
  })

  // The reply length depends on the address type it reports. Assuming IPv4 eats
  // the first bytes of the tunnel when the upstream answers with a domain or IPv6.
  it.each([1, 3, 4] as const)('handles a reply carrying address type %i', async (atyp) => {
    const echo = await startEchoServer()
    closers.push(echo)
    const proxy = await startSocks5Proxy({ atyp })
    closers.push(proxy)
    const { socket } = await dial(up(proxy.port), '127.0.0.1', echo.port, nodeConnect)
    expect(await roundTrip(socket, 'ping')).toBe('PING')
    socket.close()
  })

  it('returns bytes that arrived alongside the reply', async () => {
    const echo = await startEchoServer()
    closers.push(echo)
    const proxy = await startSocks5Proxy({ piggyback: 'EARLY' })
    closers.push(proxy)
    const { socket, leftover } = await dial(up(proxy.port), '127.0.0.1', echo.port, nodeConnect)
    expect(new TextDecoder().decode(leftover)).toBe('EARLY')
    socket.close()
  })
})
