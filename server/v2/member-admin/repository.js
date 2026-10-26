import { createHash } from 'node:crypto';
import { readSqliteCollectionRecord, upsertSqliteCollectionRecord, deleteSqliteCollectionRecord, runSqliteTransaction } from '../../storage/sqlite-migrate.js';
import { memberPermissionPredicate } from '../member-space/repository.js';
import { MEMBER_GRANTS, validGrant } from '../identity/permissions.js';
import { IdentityError } from '../identity/errors.js';
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const fail = (code, status = 422, extra = {}) => {
  throw Object.assign(new IdentityError(code, status), extra);
};
export const requireValue = (condition, code, status = 422, extra) => {
  if (!condition) fail(code, status, extra);
};
export const decode = rows => rows.map(r => JSON.parse(r.payload_json));
export const MEMBER_READ_INDEXES = Object.freeze([
  "CREATE INDEX IF NOT EXISTS v2_member_admin_binding_member ON json_records(json_extract(payload_json,'$.memberId'),id) WHERE collection='v2SteamBindings'",
  "CREATE INDEX IF NOT EXISTS v2_member_admin_squad_member ON json_records(json_extract(payload_json,'$.memberId'),id) WHERE collection='squadMembers'",
  "CREATE INDEX IF NOT EXISTS v2_member_admin_profile_member ON json_records(json_extract(payload_json,'$.memberId'),id) WHERE collection='memberProfiles'",
  "CREATE INDEX IF NOT EXISTS v2_member_admin_profile_steam ON json_records(json_extract(payload_json,'$.steamId'),id) WHERE collection='memberProfiles'",
  "CREATE INDEX IF NOT EXISTS v2_identity_binding_account ON json_records(json_extract(payload_json,'$.accountId'),id) WHERE collection='v2SteamBindings'"
]);
export const memberReadIndexCatalog = db => MEMBER_READ_INDEXES.map(sql => { const name = sql.split(" ")[5]; return {name,sql:db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(name)?.sql || null}; });
const normalizedIndex = sql => String(sql||'').replace(/IF NOT EXISTS /i,'').replace(/\s+/g,' ').trim();
export const memberReadIndexesReady = db => memberReadIndexCatalog(db).every((row,i)=>normalizedIndex(row.sql)===normalizedIndex(MEMBER_READ_INDEXES[i]));
export function installMemberReadIndexes(db) { for (const sql of MEMBER_READ_INDEXES) db.exec(sql); }
export function installMemberAdminSchema(db) {
  installMemberReadIndexes(db);
  db.exec(`CREATE TABLE IF NOT EXISTS v2_member_admin_meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, migration TEXT);
    INSERT OR IGNORE INTO v2_member_admin_meta VALUES(1,0,NULL);
    CREATE TABLE IF NOT EXISTS v2_member_admin_operations (actor_id TEXT NOT NULL, operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(actor_id,operation_id));
    CREATE TABLE IF NOT EXISTS v2_member_admin_history (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, resource_id TEXT NOT NULL, member_id TEXT, squad_id TEXT, actor_id TEXT NOT NULL, action TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS v2_member_admin_history_member ON v2_member_admin_history(member_id,seq);
    CREATE INDEX IF NOT EXISTS v2_member_admin_history_resource ON v2_member_admin_history(kind,resource_id,seq);
    CREATE TABLE IF NOT EXISTS v2_member_admin_risk_state (actor_id TEXT NOT NULL, member_id TEXT NOT NULL, alert_id TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL, evidence_hash TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(actor_id,member_id,alert_id));
    CREATE TABLE IF NOT EXISTS v2_member_admin_outbox (seq INTEGER PRIMARY KEY, operation_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);`);
}
export class MemberAdminRepository {
  constructor(db) {
    this.db = db;
    requireValue(db.prepare("SELECT name FROM sqlite_master WHERE name='v2_member_admin_meta'").get(), 'MEMBER_ADMIN_MIGRATION_REQUIRED', 503);
  }
  get(collection, id) {
    return readSqliteCollectionRecord(this.db, collection, id);
  }
  put(collection, value) {
    upsertSqliteCollectionRecord(this.db, collection, value.id, value);
    return value;
  }
  remove(collection, id) {
    deleteSqliteCollectionRecord(this.db, collection, id);
  }
  transaction(fn) {
    return runSqliteTransaction(this.db, 'v2_member_admin', () => {
      const r = fn();
      if (r?.then) throw new TypeError('Synchronous transaction required');
      return r;
    });
  }
  revision() {
    return this.db.prepare('SELECT revision FROM v2_member_admin_meta WHERE id=1').get().revision;
  }
  find(collection, field, value, limit = 101) {
    requireValue(/^[a-zA-Z][a-zA-Z0-9]*$/.test(field), 'INVALID_FIELD');
    return decode(this.db.prepare(`SELECT payload_json FROM json_records WHERE collection=? AND json_extract(payload_json,'$.${field}')=? ORDER BY id LIMIT ?`).all(collection, value, limit));
  }
  all(collection, limit = 10001) {
    const r = decode(this.db.prepare('SELECT payload_json FROM json_records WHERE collection=? ORDER BY id LIMIT ?').all(collection, limit));
    requireValue(r.length < limit, 'COLLECTION_LIMIT_EXCEEDED', 503);
    return r;
  }
  relations() {
    const rows = this.db.prepare(`SELECT json_extract(payload_json,'$.memberId') AS memberId,json_extract(payload_json,'$.squadId') AS squadId FROM json_records WHERE collection='squadMembers' AND COALESCE(json_extract(payload_json,'$.validTo'),'')='' LIMIT 10001`).all();
    requireValue(rows.length <= 10000, 'RELATION_LIMIT_EXCEEDED', 503);
    return {
      squadMembers: rows,
      wipes: []
    };
  }
  currentSquad(memberId) {
    return this.find('squadMembers', 'memberId', memberId).filter(r => !r.validTo);
  }
  scope(actor, cap, kind = 'member', expression = 'r.id') {
    if (actor.status !== 'active' || actor.restricted) return {
      text: '0',
      args: []
    };
    if (kind === 'member') return memberPermissionPredicate(actor, cap, expression);
    const grants = [...(actor.grants || []), ...(actor.memberId ? MEMBER_GRANTS : [])].filter(g => validGrant(g) && g.capability === cap);
    const parts = effect => grants.filter(g => g.effect === effect).map(g => {
      if (g.scope.type === 'all') return {
        text: '1',
        args: []
      };
      if (g.scope.type === 'squads') return {
        text: `${expression} IN (SELECT value FROM json_each(?))`,
        args: [JSON.stringify(g.scope.ids)]
      };
      if (g.scope.type === 'self' && actor.memberId) return {
        text: `EXISTS (SELECT 1 FROM json_records sm WHERE sm.collection='squadMembers' AND json_extract(sm.payload_json,'$.memberId')=? AND json_extract(sm.payload_json,'$.squadId')=${expression} AND COALESCE(json_extract(sm.payload_json,'$.validTo'),'')='')`,
        args: [actor.memberId]
      };
      return {
        text: '0',
        args: []
      };
    });
    const a = parts('allow'),
      d = parts('deny');
    return {
      text: `((${a.map(p => p.text).join(' OR ') || '0'}) AND NOT (${d.map(p => p.text).join(' OR ') || '0'}))`,
      args: [...a, ...d].flatMap(p => p.args)
    };
  }
  list(collection, predicate, {
    after = '',
    limit = 30
  } = {}) {
    const base = `collection=? AND (${predicate.text})`;
    const total = this.db.prepare(`SELECT count(*) AS n FROM json_records r WHERE ${base}`).get(collection, ...predicate.args).n;
    const rows = decode(this.db.prepare(`SELECT payload_json FROM json_records r WHERE ${base} AND r.id>? ORDER BY r.id LIMIT ?`).all(collection, ...predicate.args, after, limit + 1));
    return {
      rows: rows.slice(0, limit),
      hasMore: rows.length > limit,
      total
    };
  }
  clearDeletedMemberProjections(member) {
    // Old typed tables are migration mirrors, not the canonical store. Remove only this target.
    const steamId = typeof member.steamId === 'string' && /^\d{17}$/.test(member.steamId) ? member.steamId : null;
    const hasTable = table => Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
    if (hasTable('member_profiles')) this.db.prepare('DELETE FROM member_profiles WHERE member_id=? OR steam_id=?').run(member.id, steamId);
    if (hasTable('members')) this.db.prepare('DELETE FROM members WHERE id=? OR steam_id=?').run(member.id, steamId);
    // Keep audit actor/action/time/IDs, without historical before/after copies of the personal profile.
    this.db.prepare("UPDATE v2_member_admin_history SET payload=? WHERE member_id=? OR (kind='member' AND resource_id=?)")
      .run(JSON.stringify({ memberId: member.id, personalDataRemoved: true }), member.id, member.id);
    const matches = value => value && typeof value === 'object' &&
      (value.id === member.id || value.memberId === member.id || value.targetMemberId === member.id ||
        steamId && (value.steamId === steamId || value.boundSteamId === steamId));
    const scrub = value => {
      if (Array.isArray(value)) return value.map(scrub);
      if (!value || typeof value !== 'object') return value;
      if (matches(value)) return { ...Object.fromEntries(['collection','id','memberId','targetMemberId','accountId','revision'].filter(k => Object.hasOwn(value,k)).map(k => [k,value[k]])), personalDataRemoved: true };
      return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,scrub(item)]));
    };
    const receipts = this.db.prepare(`SELECT actor_id,operation_id,payload FROM v2_member_admin_operations op WHERE EXISTS (
      SELECT 1 FROM json_tree(op.payload) field WHERE field.key IN ('id','memberId','targetMemberId','steamId','boundSteamId') AND field.value IN (?,?))`).all(member.id, steamId);
    for (const receipt of receipts) this.db.prepare('UPDATE v2_member_admin_operations SET payload=? WHERE actor_id=? AND operation_id=?')
      .run(JSON.stringify(scrub(JSON.parse(receipt.payload))), receipt.actor_id, receipt.operation_id);
  }
  history(kind, id, after = 0, limit = 30) {
    return this.db.prepare('SELECT seq,actor_id AS actorId,action,payload,created_at AS createdAt FROM v2_member_admin_history WHERE kind=? AND resource_id=? AND seq>? ORDER BY seq LIMIT ?').all(kind, id, after, limit + 1).map(r => ({
      ...r,
      payload: JSON.parse(r.payload)
    }));
  }
  historyBefore(kind, id, before = Number.MAX_SAFE_INTEGER, limit = 30) {
    return this.db.prepare('SELECT seq,actor_id AS actorId,action,payload,created_at AS createdAt FROM v2_member_admin_history WHERE kind=? AND resource_id=? AND seq<? ORDER BY seq DESC LIMIT ?').all(kind, id, before, limit + 1).map(r => ({
      ...r, payload: JSON.parse(r.payload)
    }));
  }
}
