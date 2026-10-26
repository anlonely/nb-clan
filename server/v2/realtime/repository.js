import { randomBytes } from 'node:crypto';
export const isUnassignedRelayResource = resource => resource?.kind === 'system' &&
  resource.id === 'relay_unassigned' && Object.keys(resource).length === 2;
export function installRealtimeSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS v2_realtime_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS v2_realtime_scopes(id TEXT PRIMARY KEY,source TEXT NOT NULL,server TEXT NOT NULL,resource TEXT NOT NULL,label TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,epoch INTEGER NOT NULL DEFAULT 1,snapshot TEXT,sourceName TEXT,firstReceived TEXT,lastReport TEXT,observed TEXT,received TEXT,watermark TEXT,cutoff TEXT,UNIQUE(source,server));
    CREATE TABLE IF NOT EXISTS v2_realtime_records(seq INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,occurred TEXT NOT NULL,received TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(scope,kind,id));
    CREATE INDEX IF NOT EXISTS v2_realtime_records_page ON v2_realtime_records(scope,kind,seq);
    CREATE TABLE IF NOT EXISTS v2_realtime_seen(scope TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(scope,id));
    CREATE TABLE IF NOT EXISTS v2_realtime_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,type TEXT NOT NULL,created INTEGER NOT NULL,payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS v2_realtime_events_scope ON v2_realtime_events(scope,seq);
    CREATE TABLE IF NOT EXISTS v2_realtime_receipts(id TEXT PRIMARY KEY,actor TEXT NOT NULL,signature TEXT NOT NULL,result TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS v2_realtime_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,operation TEXT NOT NULL,created TEXT NOT NULL,detail TEXT NOT NULL);`);
  db.prepare('INSERT OR IGNORE INTO v2_realtime_meta VALUES(?,?)').run('cursorSecret', randomBytes(32).toString('hex'));
}
export class RealtimeRepository {
  constructor(db) {
    this.db = db;
    this.secret = db.prepare('SELECT value FROM v2_realtime_meta WHERE key=?').get('cursorSecret')?.value;
    if (!this.secret) throw new Error('REALTIME_MIGRATION_REQUIRED');
    this.listeners = new Set();
  }
  transaction(fn) {
    this.db.exec('SAVEPOINT realtime_write');
    try {
      const r = fn();
      if (r?.then) throw new Error('ASYNC_TRANSACTION');
      this.db.exec('RELEASE realtime_write');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK TO realtime_write; RELEASE realtime_write');
      throw e;
    }
  }
  bind({
    id,
    sourceId,
    serverKey,
    resource,
    label
  }) {
    if (!id || !sourceId || !serverKey || !resource?.id ||
      !(['squad', 'wipe'].includes(resource.kind) || isUnassignedRelayResource(resource))) throw new Error('INVALID_SOURCE_BINDING');
    this.db.prepare('INSERT INTO v2_realtime_scopes(id,source,server,resource,label) VALUES(?,?,?,?,?)').run(id, sourceId, serverKey, JSON.stringify(resource), label || serverKey);
  }
  scopes() {
    return this.db.prepare('SELECT * FROM v2_realtime_scopes ORDER BY id LIMIT 501').all().map(parseScope);
  }
  scope(id) {
    const row = this.db.prepare('SELECT * FROM v2_realtime_scopes WHERE id=?').get(id);
    return row && parseScope(row);
  }
  emit(scope, type, payload, now = Date.now()) {
    const seq = Number(this.db.prepare('INSERT INTO v2_realtime_events(scope,type,created,payload) VALUES(?,?,?,?)').run(scope, type, now, JSON.stringify(payload)).lastInsertRowid);
    this.db.prepare('INSERT OR REPLACE INTO v2_realtime_meta VALUES(?,?)').run(`high:${scope}`, String(seq));
    return seq;
  }
  notify(scope) {
    for (const fn of this.listeners) fn(scope);
  }
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  high(scope) {
    return Number(this.db.prepare('SELECT value FROM v2_realtime_meta WHERE key=?').get(`high:${scope}`)?.value || 0);
  }
  pruneEvents(now = Date.now()) {
    for (const row of this.db.prepare('SELECT scope,MAX(seq) AS n FROM v2_realtime_events WHERE created<? GROUP BY scope').all(now - 86400000)) this.db.prepare('INSERT OR REPLACE INTO v2_realtime_meta VALUES(?,?)').run(`floor:${row.scope}`, String(row.n));
    this.db.prepare('DELETE FROM v2_realtime_events WHERE created<?').run(now - 86400000);
  }
}
function parseScope(row) {
  return {
    ...row,
    resource: JSON.parse(row.resource),
    snapshot: row.snapshot ? JSON.parse(row.snapshot) : null
  };
}
