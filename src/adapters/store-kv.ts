import type { Account, RelayStore, Upstream } from '../core/store'

export const ACCOUNT_CACHE_TTL = 60
export const TOUCH_DEBOUNCE_MS = 60_000

/** Only the four KV operations this store needs, so it can be faked in tests. */
export interface KvLike {
  get(key: string, opts?: { cacheTtl?: number }): Promise<string | null>
  put(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  list(opts: { prefix: string; cursor?: string }): Promise<{
    keys: { name: string }[]
    list_complete: boolean
    cursor?: string
  }>
}

// Accounts are keyed by username because that is what the hot path has. The
// id -> username pointer exists so a delete or a rename can find the key to drop.
const acctKey = (username: string) => `acct:${username}`
const acctIdKey = (id: string) => `acctid:${id}`
const upKey = (id: string) => `up:${id}`

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

// A real KVNamespace.list page caps at 1000 keys. Reading only the first page
// silently truncated listAccounts/listUpstreams and, worse, the orphan scan in
// deleteAccount - the one whose own comment explains that skipping it is what
// let a live account survive a "successful" delete.
async function listAllKeys(kv: KvLike, prefix: string): Promise<{ name: string }[]> {
  const keys: { name: string }[] = []
  let cursor: string | undefined
  for (;;) {
    const page = await kv.list({ prefix, cursor })
    keys.push(...page.keys)
    if (page.list_complete || !page.cursor) return keys
    cursor = page.cursor
  }
}

export function createKvStore(kv: KvLike): RelayStore {
  const readJson = async <T>(key: string, cacheTtl?: number): Promise<T | null> => {
    const raw = await kv.get(key, cacheTtl ? { cacheTtl } : undefined)
    return raw ? (JSON.parse(raw) as T) : null
  }

  return {
    async listAccounts() {
      const keys = await listAllKeys(kv, 'acct:')
      const rows = await Promise.all(keys.map((k) => readJson<Account>(k.name)))
      const accounts = rows.filter((r): r is Account => r !== null)
      accounts.sort((a, b) => byCodeUnit(a.createdAt, b.createdAt))
      return accounts
    },
    async getAccountByUsername(username) {
      return readJson<Account>(acctKey(username), ACCOUNT_CACHE_TTL)
    },
    async putAccount(a) {
      const prev = await kv.get(acctIdKey(a.id))
      const holder = await readJson<Account>(acctKey(a.username))
      if (holder && holder.id !== a.id) {
        throw new Error(`username ${a.username} already belongs to another account`)
      }
      await kv.put(acctKey(a.username), JSON.stringify(a))
      await kv.put(acctIdKey(a.id), a.username)
      // Deleting the old key last: there are no transactions here, so a crash mid
      // rename must not be able to leave the pointer aimed at a key that is already
      // gone - that state cannot be revoked by id at all. A stale old username that
      // still resolves until the next write is the better failure.
      if (prev && prev !== a.username) await kv.delete(acctKey(prev))
    },
    async deleteAccount(id) {
      const username = await kv.get(acctIdKey(id))
      if (username) {
        const row = await readJson<Account>(acctKey(username))
        // Only ours: a colliding write could have left this key owned by another id.
        if (!row || row.id === id) await kv.delete(acctKey(username))
      }
      await kv.delete(acctIdKey(id))
      // Unconditional: a rename that failed between its two writes leaves two rows
      // owned by this id, and the pointer names only one of them. Skipping the scan
      // when the pointer resolved is what let the other copy survive a "successful"
      // delete, still authenticating.
      const keys = await listAllKeys(kv, 'acct:')
      for (const k of keys) {
        const row = await readJson<Account>(k.name)
        if (row?.id === id) await kv.delete(k.name)
      }
    },
    async touchAccount(id, at) {
      const username = await kv.get(acctIdKey(id))
      if (!username) return
      const a = await readJson<Account>(acctKey(username))
      if (!a) return
      // KV writes are rate limited per key, and lastSeenAt is only ever read by a
      // human in the admin UI, so a minute of staleness is the right trade.
      const last = a.lastSeenAt ? Date.parse(a.lastSeenAt) : 0
      if (Date.parse(at) - last < TOUCH_DEBOUNCE_MS) return
      await kv.put(acctKey(username), JSON.stringify({ ...a, lastSeenAt: at }))
    },
    async listUpstreams() {
      const keys = await listAllKeys(kv, 'up:')
      const rows = await Promise.all(keys.map((k) => readJson<Upstream>(k.name)))
      const upstreams = rows.filter((r): r is Upstream => r !== null)
      upstreams.sort((a, b) => byCodeUnit(a.name, b.name))
      return upstreams
    },
    async getUpstream(id) {
      return readJson<Upstream>(upKey(id), ACCOUNT_CACHE_TTL)
    },
    async putUpstream(u) {
      await kv.put(upKey(u.id), JSON.stringify(u))
    },
    async deleteUpstream(id) {
      await kv.delete(upKey(id))
    },
  }
}
