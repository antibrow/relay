import { handleAdminApi } from '../admin/api'
import { adminHtml } from '../admin/ui'
import { keyFromBase64Url } from '../protocol/crypto'
import { parseBasicAuth, requireIdentity } from './auth'
import { forwardHttp } from './legacy-forward'
import type { RelayStore } from './store'
import type { Connect } from './types'

export interface RelayEnv {
  /** Absent means the encrypted path is disabled. */
  key?: Uint8Array
  /** Absent means the whole admin surface answers 404. */
  adminKey?: string
  /** Plaintext puts the target hostname on the wire in clear text, so it is
   *  opt-in and off by default. */
  allowPlaintext: boolean
  store: RelayStore
  connect: Connect
}

const notFound = () => new Response('not found\n', { status: 404 })

export function legacyTargetFromRequest(req: Request, url: URL): URL | null {
  const header = req.headers.get('x-proxy-target')
  const embedded = url.pathname.slice(1) + (url.search || '')
  const candidate = header ?? (/^https?:\/\//i.test(embedded) ? embedded : '')
  if (!candidate) return null
  try {
    return new URL(candidate)
  } catch {
    return null
  }
}

export async function routeHttp(req: Request, env: RelayEnv): Promise<Response> {
  const url = new URL(req.url)

  if (url.pathname === '/admin' || url.pathname === '/admin/') {
    if (!env.adminKey) return notFound()
    return new Response(adminHtml(), { headers: { 'content-type': 'text/html; charset=utf-8' } })
  }

  const admin = await handleAdminApi(req, url, env.store, env.adminKey)
  if (admin) return admin

  const target = legacyTargetFromRequest(req, url)
  if (target) {
    if (!env.allowPlaintext) return notFound()
    const identity = await requireIdentity(env.store, parseBasicAuth(req.headers.get('proxy-authorization')))
    // Unlike the encrypted path this answers instead of going quiet: plaintext
    // mode has no anti-probe property to protect, and an operator debugging it
    // needs to see the rejection.
    if (!identity) {
      return new Response('proxy authentication required\n', {
        status: 401,
        headers: { 'proxy-authenticate': 'Basic realm="relay"' },
      })
    }
    if (identity.account) {
      void env.store.touchAccount(identity.account.id, new Date().toISOString()).catch(() => {})
    }
    return forwardHttp(req, target, identity.upstream, env.connect)
  }

  return notFound()
}

export interface RawEnv {
  FP_RELAY_KEY?: string
  ADMIN_KEY?: string
  ALLOW_PLAINTEXT?: string
}

export function buildRelayEnv(raw: RawEnv, store: RelayStore, connect: Connect): RelayEnv {
  let key: Uint8Array | undefined
  try {
    key = raw.FP_RELAY_KEY ? keyFromBase64Url(raw.FP_RELAY_KEY) : undefined
  } catch {
    // A malformed key disables the encrypted path but must still let the admin
    // surface come up, otherwise the deployment cannot be fixed from the outside.
    key = undefined
  }
  return {
    key,
    adminKey: raw.ADMIN_KEY,
    allowPlaintext: raw.ALLOW_PLAINTEXT === '1',
    store,
    connect,
  }
}
