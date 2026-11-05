import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const windowMs = 60_000

const db = new DatabaseSync(process.env.DB_PATH ?? fileURLToPath(new URL('gateway.db', import.meta.url)))
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  -- full sync costs an fsync per commit (30 ms here), losing the last few usage rows on power loss is fine
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS tenants (key_hash TEXT PRIMARY KEY, name TEXT NOT NULL, tokens_per_min INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY, key_hash TEXT NOT NULL, ts INTEGER NOT NULL, tokens INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS usage_key_ts ON usage (key_hash, ts);
  CREATE INDEX IF NOT EXISTS usage_ts ON usage (ts);
`)

const q = {
  tenant: db.prepare('SELECT name, tokens_per_min AS max FROM tenants WHERE key_hash = ?'),
  addTenant: db.prepare('INSERT INTO tenants (key_hash, name, tokens_per_min) VALUES (?, ?, ?)'),
  evict: db.prepare('DELETE FROM usage WHERE ts <= ?'),
  used: db.prepare('SELECT COALESCE(SUM(tokens), 0) AS used FROM usage WHERE key_hash = ? AND ts > ?'),
  // first row whose expiry frees enough room, the running sum is what has left the window by then
  freedAt: db.prepare(`
    SELECT ts FROM (SELECT ts, SUM(tokens) OVER (ORDER BY ts, id) AS freed FROM usage WHERE key_hash = ? AND ts > ?)
    WHERE freed >= ? LIMIT 1`),
  reserve: db.prepare('INSERT INTO usage (key_hash, ts, tokens) VALUES (?, ?, ?)'),
  settle: db.prepare('UPDATE usage SET tokens = ? WHERE id = ?'),
  release: db.prepare('DELETE FROM usage WHERE id = ?'),
}

const hashKey = (key: string) => createHash('sha256').update(key).digest('hex')

export function tenantOf(key: string) {
  const hash = hashKey(key)
  const row = q.tenant.get(hash) as { name: string; max: number } | undefined
  return row && { hash, ...row }
}

export const addTenant = (key: string, name: string, max: number) => q.addTenant.run(hashKey(key), name, max)

// reserves the estimate up front so concurrent requests can't all pass the check before any of them is counted.
// IMMEDIATE takes the write lock at BEGIN, so gateways sharing the file can't overshoot either
export function admit(hash: string, max: number, tokens: number, now = Date.now()) {
  const since = now - windowMs
  db.exec('BEGIN IMMEDIATE')
  try {
    q.evict.run(since)
    const { used } = q.used.get(hash, since) as { used: number }
    if (used + tokens > max) {
      const row = q.freedAt.get(hash, since, used + tokens - max) as { ts: number } | undefined
      db.exec('COMMIT')
      return { ok: false as const, retryAfter: row ? Math.max(1, Math.ceil((row.ts + windowMs - now) / 1000)) : windowMs / 1000 }
    }
    const id = q.reserve.run(hash, now, tokens).lastInsertRowid
    db.exec('COMMIT')
    return { ok: true as const, id }
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export const settle = (id: number | bigint, tokens: number) => q.settle.run(tokens, id)
export const release = (id: number | bigint) => q.release.run(id)
