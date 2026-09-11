import { createKvStore, type KvLike } from './adapters/store-kv'
import { workersConnect } from './adapters/socket-workers'
import { workersWs } from './adapters/ws-workers'
import { parseBasicAuth, requireIdentity } from './core/auth'
import { startLegacyTunnel } from './core/legacy-tunnel'
import { buildRelayEnv, routeHttp, type RawEnv } from './core/router'
import { startEncryptedSession } from './core/session'

export interface Env extends RawEnv {
  RELAY_STORE: KvLike
}

export default {
  async fetch(req: Request, raw: Env): Promise<Response> {
    const env = buildRelayEnv(raw, createKvStore(raw.RELAY_STORE), workersConnect)
    if (req.headers.get('Upgrade') !== 'websocket') return routeHttp(req, env)

    const url = new URL(req.url)
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
    server.accept()

    const legacyHost = url.searchParams.get('host')
    if (legacyHost) {
      if (!env.allowPlaintext) {
        server.close()
      } else {
        const identity = await requireIdentity(env.store, parseBasicAuth(req.headers.get('proxy-authorization')))
        if (!identity) {
          server.close()
        } else {
          if (identity.account) {
            void env.store.touchAccount(identity.account.id, new Date().toISOString()).catch(() => {})
          }
          startLegacyTunnel(workersWs(server), {
            host: legacyHost,
            port: Number(url.searchParams.get('port') ?? 443),
            upstream: identity.upstream,
            connect: env.connect,
          })
        }
      }
    } else if (env.key) {
      startEncryptedSession(workersWs(server), { key: env.key, store: env.store, connect: env.connect })
    } else {
      server.close()
    }

    return new Response(null, { status: 101, webSocket: client })
  },
}
