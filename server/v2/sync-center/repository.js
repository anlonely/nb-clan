import { IdentityError } from '../identity/errors.js';
export function installSyncCenterSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS sync_center_records(kind TEXT NOT NULL,id TEXT NOT NULL,status TEXT NOT NULL DEFAULT '',source TEXT NOT NULL DEFAULT '',updated INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id));
    CREATE INDEX IF NOT EXISTS sync_center_listing ON sync_center_records(kind,updated DESC,id DESC);
    CREATE INDEX IF NOT EXISTS sync_center_created ON sync_center_records(kind,json_extract(payload,'$.createdAt') DESC,id DESC);
    CREATE INDEX IF NOT EXISTS sync_center_status ON sync_center_records(kind,status,source);
    CREATE TABLE IF NOT EXISTS sync_center_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT,at INTEGER NOT NULL,kind TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sync_center_schema(version INTEGER PRIMARY KEY); INSERT OR IGNORE INTO sync_center_schema VALUES(1);`);
}
export class SyncCenterRepository {
  constructor(db) { this.db=db; if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='sync_center_schema'").get()) throw new IdentityError('SYNC_MIGRATION_REQUIRED',503); }
  get(kind,id) { const r=this.db.prepare('SELECT payload FROM sync_center_records WHERE kind=? AND id=?').get(kind,id);return r?JSON.parse(r.payload):null; }
  put(kind,r) {this.db.prepare('INSERT INTO sync_center_records VALUES(?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET status=excluded.status,source=excluded.source,updated=excluded.updated,payload=excluded.payload').run(kind,r.id,r.status||'',r.source||'',r.updatedAt||0,JSON.stringify(r));return r;}
  rows(kind,{limit=100,after='',status='',source=''}={}) {return this.db.prepare(`SELECT payload FROM sync_center_records WHERE kind=? AND id>? ${status?'AND status=?':''} ${source?'AND source=?':''} ORDER BY id LIMIT ?`).all(kind,after,...(status?[status]:[]),...(source?[source]:[]),Math.min(501,limit)).map(r=>JSON.parse(r.payload));}
  activeRules(limit=100) {return this.db.prepare("SELECT payload FROM sync_center_records WHERE kind='rule' AND COALESCE(json_extract(payload,'$.deleted'),0)=0 AND json_extract(payload,'$.type')!='hexaytron_profile' ORDER BY id LIMIT ?").all(Math.min(101,limit)).map(r=>JSON.parse(r.payload));}
  pageJobs(after=null){return this.db.prepare("SELECT payload FROM sync_center_records WHERE kind='job' AND (? OR json_extract(payload,'$.createdAt')<? OR (json_extract(payload,'$.createdAt')=? AND id<?)) ORDER BY json_extract(payload,'$.createdAt') DESC,id DESC LIMIT 501").all(after?0:1,after?.createdAt||0,after?.createdAt||0,after?.id||'').map(r=>JSON.parse(r.payload));}
  activeJobs() { return this.db.prepare("SELECT payload FROM sync_center_records WHERE kind='job' AND status IN ('queued','running','retry_wait','paused') ORDER BY updated,id LIMIT 501").all().map(r=>JSON.parse(r.payload)); }
  event(jobId,kind,at) {this.db.prepare('INSERT INTO sync_center_events(job_id,at,kind) VALUES(?,?,?)').run(jobId,at,kind);}
  transaction(fn) {this.db.exec('SAVEPOINT sync_center_write');try{const r=fn();if(r?.then)throw new TypeError('Synchronous transaction required');this.db.exec('RELEASE sync_center_write');return r;}catch(e){this.db.exec('ROLLBACK TO sync_center_write; RELEASE sync_center_write');throw e;}}
}
