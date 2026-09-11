import http from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { parseBasicAuth, requireIdentity } from './core/auth'
import { startLegacyTunnel } from './core/legacy-tunnel'
import { buildRelayEnv, routeHttp, type RelayEnv } from './core/router'
import { startEncryptedSession } from './core/session'
import { nodeConnect } from './adapters/socket-node'
import { nodeWs } from './adapters/ws-node'
import { createSqliteStore } from './adapters/store-sqlite'

export interface NodeRelayOptions {
  port?: number
  host?: string
  dbPath: string
  key?: string
  adminKey?: string
  allowPlaintext?: boolean
}

export async function startNodeRelay(opts: NodeRelayOptions) {
  const store = createSqliteStore(opts.dbPath)
  // Routed through buildRelayEnv so a malformed key degrades the same way here
  // as on the Worker, instead of throwing at startup from a second copy of the
  // same try/catch.
  const env: RelayEnv = buildRelayEnv(
    {
      FP_RELAY_KEY: opts.key,
      ADMIN_KEY: opts.adminKey,
      ALLOW_PLAINTEXT: opts.allowPlaintext ? '1' : '0',
    },
    store,
    nodeConnect,
  )

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : toWebStream(req)
    const request = new Request(url, {
      method: req.method,
      headers: toHeaders(req.headers),
      body,
      // @ts-expect-error undici needs this whenever a body stream is present
      duplex: body ? 'half' : undefined,
    })
    routeHttp(request, env).then(async (out) => {
      // The array form, because Headers.forEach visits set-cookie once per value:
      // collapsing into a plain string map (the old code) keeps only the last one.
      const headers: Record<string, string | string[]> = {}
      out.headers.forEach((value, name) => {
        const existing = headers[name]
        if (existing === undefined) headers[name] = value
        else if (Array.isArray(existing)) existing.push(value)
        else headers[name] = [existing, value]
      })
      res.writeHead(out.status, headers)
      if (!out.body) { res.end(); return }
      const reader = out.body.getReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) res.write(value)
      }
      res.end()
    }).catch(() => {
      // Once the head is out there is no status left to send: the only honest
      // signal is an aborted response. Calling writeHead here throws, and the
      // throw lands in a catch, which ends the process.
      if (!res.headersSent) {
        res.writeHead(500)
        res.end()
      } else {
        res.destroy()
      }
    })
  })

  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    wss.handleUpgrade(req, socket, head, (ws) => {
      void handleUpgrade(ws, url, req.headers['proxy-authorization'] ?? null, env)
    })
  })

  await new Promise<void>((r) => server.listen(opts.port ?? 8899, opts.host ?? '0.0.0.0', () => r()))
  const port = (server.address() as { port: number }).port

  return {
    port,
    // Lets a caller (the CLI) tell "no key supplied" apart from "a key was
    // supplied but buildRelayEnv could not use it" - opts.key alone can't say that.
    keyAccepted: env.key !== undefined,
    async close() {
      wss.close()
      await new Promise<void>((r) => server.close(() => r()))
      store.close()
    },
  }
}

async function handleUpgrade(ws: WebSocket, url: URL, proxyAuth: string | null, env: RelayEnv): Promise<void> {
  const legacyHost = url.searchParams.get('host')
  if (legacyHost) {
    if (!env.allowPlaintext) { ws.close(); return }
    const identity = await requireIdentity(env.store, parseBasicAuth(proxyAuth))
    if (!identity) { ws.close(); return }
    if (identity.account) {
      void env.store.touchAccount(identity.account.id, new Date().toISOString()).catch(() => {})
    }
    startLegacyTunnel(nodeWs(ws), {
      host: legacyHost,
      port: Number(url.searchParams.get('port') ?? 443),
      upstream: identity.upstream,
      connect: env.connect,
    })
    return
  }
  if (!env.key) { ws.close(); return }
  startEncryptedSession(nodeWs(ws), { key: env.key, store: env.store, connect: env.connect })
}

function toWebStream(req: http.IncomingMessage): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      req.on('data', (d: Buffer) => c.enqueue(new Uint8Array(d)))
      req.on('end', () => c.close())
      req.on('error', (e) => c.error(e))
    },
  })
}

function toHeaders(raw: http.IncomingHttpHeaders): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue
    // A repeated header arrives as an array; new Request rejects that shape.
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one)
  }
  return headers
}
