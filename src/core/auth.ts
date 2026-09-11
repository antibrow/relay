import { DIRECT_UPSTREAM, type Account, type RelayStore, type Upstream } from './store'

export interface Credential {
  username: string
  password: string
}

export interface Identity {
  account?: Account
  upstream: Upstream
}

/** `user:pass`, splitting on the first colon so passwords may contain colons. */
export function parseCred(cred: string): Credential | null {
  const at = cred.indexOf(':')
  if (at <= 0) return null
  return { username: cred.slice(0, at), password: cred.slice(at + 1) }
}

export function parseBasicAuth(header: string | null): Credential | null {
  if (!header?.startsWith('Basic ')) return null
  try {
    return parseCred(atob(header.slice(6).trim()))
  } catch {
    return null
  }
}

export function constantTimeEqual(a: string, b: string): boolean {
  // Length is not secret here (it leaks through the wire format anyway); the
  // point is not to leak how many leading characters of a guess were right.
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function resolveIdentity(store: RelayStore, cred: Credential | null): Promise<Identity | null> {
  if (!cred) return { upstream: DIRECT_UPSTREAM }
  const account = await store.getAccountByUsername(cred.username)
  if (!account || !account.enabled) return null
  if (!constantTimeEqual(account.password, cred.password)) return null
  return { account, upstream: (await store.getUpstream(account.upstreamId)) ?? DIRECT_UPSTREAM }
}

/** For paths where a credential is mandatory: absent or unparseable is a
 *  rejection, never a fall-through to the single-tenant direct exit. */
export async function requireIdentity(store: RelayStore, cred: Credential | null): Promise<Identity | null> {
  return cred ? resolveIdentity(store, cred) : null
}
