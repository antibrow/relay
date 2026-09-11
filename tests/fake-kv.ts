import type { KvLike } from '../src/adapters/store-kv'

/** `pageSize` caps keys per `list` call, the same shape a real KVNamespace.list
 *  imposes at 1000 - so tests can force a truncated first page without needing
 *  1001 real keys. */
export function fakeKv(opts: { pageSize?: number } = {}): KvLike & { reads: string[]; lists: number } {
  const data = new Map<string, string>()
  const reads: string[] = []
  const state = { lists: 0 }
  const pageSize = opts.pageSize ?? Infinity
  return {
    reads,
    get lists() { return state.lists },
    async get(key) { reads.push(key); return data.get(key) ?? null },
    async put(key, value) { data.set(key, value) },
    async delete(key) { data.delete(key) },
    async list({ prefix, cursor }) {
      state.lists++
      const all = [...data.keys()].filter((k) => k.startsWith(prefix)).sort()
      const start = cursor ? Number(cursor) : 0
      const page = all.slice(start, start + pageSize)
      const nextStart = start + page.length
      const list_complete = nextStart >= all.length
      return {
        keys: page.map((name) => ({ name })),
        list_complete,
        cursor: list_complete ? undefined : String(nextStart),
      }
    },
  }
}
