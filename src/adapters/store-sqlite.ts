import { createRequire } from 'node:module'
import type { Account, RelayStore, Upstream } from '../core/store'

const require = createRequire(import.meta.url)
// Vite's static resolver cannot resolve 'node:sqlite', so we load it via createRequire to bypass Vite's transform phase.
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')

const opt = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v))
const optNum = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : Number(v))

export function createSqliteStore(path: string): RelayStore & { close(): void } {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS upstreams (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, protocol TEXT NOT NULL,
      host TEXT, port INTEGER, username TEXT, password TEXT, note TEXT
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL,
      upstream_id TEXT NOT NULL, enabled INTEGER NOT NULL,
      note TEXT, created_at TEXT NOT NULL, last_seen_at TEXT
    );
  `)

  const rowToUpstream = (r: Record<string, unknown>): Upstream => ({
    id: String(r.id), name: String(r.name), protocol: String(r.protocol) as Upstream['protocol'],
    host: opt(r.host), port: optNum(r.port), username: opt(r.username),
    password: opt(r.password), note: opt(r.note),
  })

  const rowToAccount = (r: Record<string, unknown>): Account => ({
    id: String(r.id), username: String(r.username), password: String(r.password),
    upstreamId: String(r.upstream_id), enabled: Number(r.enabled) === 1,
    note: opt(r.note), createdAt: String(r.created_at), lastSeenAt: opt(r.last_seen_at),
  })

  return {
    async listAccounts() {
      return db.prepare('SELECT * FROM accounts ORDER BY created_at').all().map(rowToAccount)
    },
    async getAccountByUsername(username) {
      const r = db.prepare('SELECT * FROM accounts WHERE username = ?').get(username)
      return r ? rowToAccount(r) : null
    },
    async putAccount(a) {
      db.prepare(`
        INSERT INTO accounts (id, username, password, upstream_id, enabled, note, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          username = excluded.username, password = excluded.password,
          upstream_id = excluded.upstream_id, enabled = excluded.enabled, note = excluded.note,
          created_at = excluded.created_at, last_seen_at = excluded.last_seen_at
      `).run(a.id, a.username, a.password, a.upstreamId, a.enabled ? 1 : 0,
        a.note ?? null, a.createdAt, a.lastSeenAt ?? null)
    },
    async deleteAccount(id) {
      db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
    },
    async touchAccount(id, at) {
      db.prepare('UPDATE accounts SET last_seen_at = ? WHERE id = ?').run(at, id)
    },
    async listUpstreams() {
      return db.prepare('SELECT * FROM upstreams ORDER BY name').all().map(rowToUpstream)
    },
    async getUpstream(id) {
      const r = db.prepare('SELECT * FROM upstreams WHERE id = ?').get(id)
      return r ? rowToUpstream(r) : null
    },
    async putUpstream(u) {
      db.prepare(`
        INSERT INTO upstreams (id, name, protocol, host, port, username, password, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name, protocol = excluded.protocol, host = excluded.host,
          port = excluded.port, username = excluded.username,
          password = excluded.password, note = excluded.note
      `).run(u.id, u.name, u.protocol, u.host ?? null, u.port ?? null,
        u.username ?? null, u.password ?? null, u.note ?? null)
    },
    async deleteUpstream(id) {
      db.prepare('DELETE FROM upstreams WHERE id = ?').run(id)
    },
    close() {
      db.close()
    },
  }
}
