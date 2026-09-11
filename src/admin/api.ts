import { constantTimeEqual } from '../core/auth'
import { newId, type Account, type RelayStore, type Upstream, type UpstreamProtocol } from '../core/store'

const PROTOCOLS: UpstreamProtocol[] = ['direct', 'http', 'socks5']
const MASK = '***'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const text = (body: string, status: number) => new Response(`${body}\n`, { status })

/** Secrets go in and are never read back out: the UI shows a mask and only
 *  sends a password when the operator actually typed a new one. */
export function maskSecrets<T extends { password?: string }>(row: T): T {
  return row.password === undefined ? row : { ...row, password: MASK }
}

export async function handleAdminApi(
  req: Request,
  url: URL,
  store: RelayStore,
  adminKey: string | undefined,
): Promise<Response | null> {
  const path = url.pathname
  if (path !== '/admin/accounts' && path !== '/admin/upstreams'
    && !path.startsWith('/admin/accounts/') && !path.startsWith('/admin/upstreams/')) {
    return null
  }
  if (!adminKey) return text('not found', 404)
  const given = req.headers.get('x-admin-key')
  if (!given || !constantTimeEqual(given, adminKey)) return text('unauthorized', 401)

  const isAccounts = path.startsWith('/admin/accounts')
  const id = path.split('/')[3]

  if (req.method === 'GET' && !id) {
    const rows = isAccounts ? await store.listAccounts() : await store.listUpstreams()
    return json(rows.map(maskSecrets))
  }

  if (req.method === 'DELETE' && id) {
    if (isAccounts) {
      await store.deleteAccount(id)
      return json({ ok: true })
    }
    const referencing = (await store.listAccounts()).filter((a) => a.upstreamId === id)
    if (referencing.length) {
      return text(`upstream still used by: ${referencing.map((a) => a.username).join(', ')}`, 409)
    }
    await store.deleteUpstream(id)
    return json({ ok: true })
  }

  if (req.method === 'POST' && !id) {
    let body: Record<string, unknown>
    try {
      body = (await req.json()) as Record<string, unknown>
    } catch {
      return text('body must be json', 400)
    }
    return isAccounts ? putAccount(store, body) : putUpstream(store, body)
  }

  return text('method not allowed', 405)
}

async function putUpstream(store: RelayStore, body: Record<string, unknown>): Promise<Response> {
  const protocol = String(body.protocol ?? '')
  if (!PROTOCOLS.includes(protocol as UpstreamProtocol)) return text('protocol must be direct, http or socks5', 400)
  if (!body.name) return text('name is required', 400)
  if (protocol !== 'direct' && (!body.host || !body.port)) return text('host and port are required', 400)

  const id = body.id ? String(body.id) : newId()
  const existing = body.id ? await store.getUpstream(id) : null
  const isDirect = protocol === 'direct'
  // Omitting an optional field on an update preserves it; there is currently
  // no way to clear one through this API.
  const row: Upstream = {
    id,
    name: String(body.name),
    protocol: protocol as UpstreamProtocol,
    // Only a proxied protocol has an endpoint. Keeping a stale one on a direct row
    // would show an operator an address that nothing dials.
    host: isDirect ? undefined : (body.host ? String(body.host) : existing?.host),
    port: isDirect ? undefined : (body.port ? Number(body.port) : existing?.port),
    username: body.username ? String(body.username) : existing?.username,
    password: keepSecret(body.password, existing?.password),
    note: body.note ? String(body.note) : existing?.note,
  }
  await store.putUpstream(row)
  return json(maskSecrets(row))
}

async function putAccount(store: RelayStore, body: Record<string, unknown>): Promise<Response> {
  if (!body.username) return text('username is required', 400)
  const upstreamId = String(body.upstreamId ?? '')
  // 'direct' is the built-in exit and never has a row of its own.
  if (upstreamId !== 'direct' && !(await store.getUpstream(upstreamId))) {
    return text('upstreamId does not exist', 400)
  }

  const id = body.id ? String(body.id) : newId()
  const existing = body.id ? (await store.listAccounts()).find((a) => a.id === id) : undefined
  const password = keepSecret(body.password, existing?.password)
  if (!password) return text('password is required', 400)

  // Omitting an optional field on an update preserves it; there is currently
  // no way to clear one through this API.
  const row: Account = {
    id,
    username: String(body.username),
    password,
    upstreamId,
    enabled: body.enabled === undefined ? (existing?.enabled ?? true) : Boolean(body.enabled),
    note: body.note ? String(body.note) : existing?.note,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    lastSeenAt: existing?.lastSeenAt,
  }
  await store.putAccount(row)
  return json(maskSecrets(row))
}

/** The UI round-trips the mask, so a masked or absent value means "unchanged". */
function keepSecret(given: unknown, existing: string | undefined): string | undefined {
  const value = given === undefined || given === null ? '' : String(given)
  if (!value || value === MASK) return existing
  return value
}
