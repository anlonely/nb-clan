import { createHash } from 'node:crypto';
import { need, digest } from '../candidate-host/config.js';
import { upsertSqliteCollectionRecord } from '../../storage/sqlite-migrate.js';
const KEEP_COLLECTIONS = ['users', 'members', 'wechatUsers', 'permissionRoles', 'uploads'];
const KEEP_SCALARS = ['settings', 'createdAt', 'updatedAt', 'version', 'storageMigration', 'v2InstallationOwner'];
const KEEP_TABLES = ['schema_meta', 'schema_migrations', 'storage_metadata', 'settings_entries', 'uploads'];
const MIRRORS = { users: 'users', members: 'members', wechat_users: 'wechatUsers', permission_roles: 'permissionRoles' };
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const hashText = value => createHash('sha256').update(String(value ?? '')).digest('hex');
const bindingKeys = new Set(['id', 'username', 'passwordHash', 'role', 'status', 'disabled', 'memberId', 'memberStatus', 'membershipStatus',
  'steamId', 'boundSteamId', 'verifiedSteamId', 'steamVerifiedAt', 'steamBoundAt', 'discordId', 'discordUserId', 'discordAccountId',
  'kookId', 'kookUserId', 'kookAccountId', 'kookBoundAt', 'wechatId', 'wechatUserId', 'openid', 'unionid', 'loginProviders',
  'blacklisted', 'isBlacklisted', 'blacklist', 'banned', 'blocked', 'restrictions']);
const bindings = (rows, fields = [...bindingKeys]) => rows.map(row => Object.fromEntries(Object.keys(row).filter(k => fields.includes(k)).sort().map(k => [k, row[k]])));
function cleaned(collection, record) {
  return Object.fromEntries(Object.entries(record).filter(([key]) => {
    if (bindingKeys.has(key)) return true;
    if (collection === 'members') return !(/^(?:battlemetrics|notAttending|lastNotAttending|discordMembership|kda|playtime|inventory|riskScan|riskScore)/i.test(key) || /Vip/i.test(key));
    if (collection === 'wechatUsers') return !['lastLoginAt', 'subscriptionPreferences'].includes(key);
    if (collection === 'users') return !['lastLoginAt', 'lastLoginIp', 'lastSeenAt'].includes(key);
    return true;
  }));
}
function collectionRows(db, collection) { return db.prepare('SELECT id,payload_json,position,updated_at FROM json_records WHERE collection=? ORDER BY id').all(collection); }
export function planIdentityRetention(db) {
  need(!db.prepare("SELECT 1 FROM json_scalars WHERE key='v2IdentityMigration'").get(), 'PRODUCTION_RETENTION_ALREADY_MIGRATED', 409);
  const collections = db.prepare('SELECT collection,count(*) count FROM json_records GROUP BY collection ORDER BY collection').all();
  const retained = KEEP_COLLECTIONS.map(collection => {
    const old = collectionRows(db, collection).map(r => JSON.parse(r.payload_json)), next = old.map(row => cleaned(collection, row));
    const removedFields = {};
    for (let i = 0; i < old.length; i++) for (const key of Object.keys(old[i])) if (!Object.hasOwn(next[i], key)) removedFields[key] = (removedFields[key] || 0) + 1;
    const bindingFields = [...new Set(old.flatMap(row => Object.keys(row).filter(k => bindingKeys.has(k))))].sort();
    const bindingBefore = digest(bindings(old, bindingFields)), bindingAfter = digest(bindings(next, bindingFields));
    need(bindingBefore === bindingAfter, 'PRODUCTION_RETENTION_BINDING_CHANGED', 409);
    return { collection, count: old.length, beforeHash: digest(old), afterHash: digest(next), bindingFields, bindingBefore, bindingAfter, removedFields };
  });
  const scalars = db.prepare('SELECT key,payload_json FROM json_scalars ORDER BY key').all().map(r => ({ key: r.key, action: KEEP_SCALARS.includes(r.key) ? 'keep' : 'delete', hash: hashText(r.payload_json) }));
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .filter(r => !['json_records', 'json_collections', 'json_scalars'].includes(r.name)).map(({ name }) => ({ name, beforeCount: db.prepare('SELECT count(*) n FROM ' + quote(name)).get().n,
      action: MIRRORS[name] ? 'rewrite_from_canonical_json' : KEEP_TABLES.includes(name) ? 'keep' : 'clear', ...(MIRRORS[name] ? { collection: MIRRORS[name], afterCount: retained.find(r => r.collection === MIRRORS[name]).count } : {}) }));
  const body = { version: 'production-identity-only/1', keepCollections: retained, deleteCollections: collections.filter(r => !KEEP_COLLECTIONS.includes(r.collection)), scalars, tables,
    preservedUploads: true, originalBindingsUnchanged: true, createsPlatformBindings: false };
  return { ...body, digest: digest(body) };
}
function rebuildMirror(db, table, collection) {
  const columns = db.prepare('PRAGMA table_info(' + quote(table) + ')').all().map(r => r.name);
  const allowed = ['id','username','role','bound_steam_id','created_at','updated_at','payload_json','payload_hash','steam_id','display_name','discord_id','wechat_user_id','squad_id','openid_hash','unionid_hash','member_id','status','name'];
  need(columns.every(c => allowed.includes(c)), 'PRODUCTION_RETENTION_MIRROR_SCHEMA_CHANGED', 409);
  db.exec('DELETE FROM ' + quote(table));
  const insert = db.prepare('INSERT INTO ' + quote(table) + '(' + columns.map(quote).join(',') + ') VALUES(' + columns.map(() => '?').join(',') + ')');
  for (const stored of collectionRows(db, collection)) {
    const r = JSON.parse(stored.payload_json), values = { id: r.id, username: r.username, role: r.role, bound_steam_id: r.boundSteamId,
      created_at: r.createdAt, updated_at: r.updatedAt, steam_id: r.steamId, display_name: r.customName || r.steamNickname || r.displayName || '',
      discord_id: r.discordId, wechat_user_id: r.wechatUserId, squad_id: null, openid_hash: r.openid ? hashText(r.openid) : null,
      unionid_hash: r.unionid ? hashText(r.unionid) : null, member_id: r.memberId, status: r.status, name: r.name,
      payload_json: stored.payload_json, payload_hash: hashText(stored.payload_json) };
    insert.run(...columns.map(c => values[c] ?? null));
  }
}
/** Explicit destructive step on a separately backed-up maintenance database.
 * JSON is authoritative; stale typed mirrors are rebuilt, never allowed to
 * resurrect deleted history/identities. Files, uploads and credentials stay. */
export function applyIdentityRetention(db, plan) {
  need(plan?.version === 'production-identity-only/1' && planIdentityRetention(db).digest === plan.digest, 'PRODUCTION_RETENTION_PLAN_STALE', 409);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of plan.deleteCollections) db.prepare('DELETE FROM json_records WHERE collection=?').run(row.collection);
    const placeholders = KEEP_COLLECTIONS.map(() => '?').join(',');
    db.prepare('DELETE FROM json_collections WHERE collection NOT IN (' + placeholders + ')').run(...KEEP_COLLECTIONS);
    for (const collection of KEEP_COLLECTIONS) for (const stored of collectionRows(db, collection)) {
      const old = JSON.parse(stored.payload_json), next = cleaned(collection, old);
      if (JSON.stringify(old) !== JSON.stringify(next)) upsertSqliteCollectionRecord(db, collection, stored.id, next, { position: stored.position, updatedAt: stored.updated_at });
    }
    for (const scalar of plan.scalars.filter(r => r.action === 'delete')) db.prepare('DELETE FROM json_scalars WHERE key=?').run(scalar.key);
    for (const table of plan.tables) {
      if (table.action === 'clear') db.exec('DELETE FROM ' + quote(table.name));
      else if (table.action === 'rewrite_from_canonical_json') rebuildMirror(db, table.name, table.collection);
    }
    for (const kept of plan.keepCollections) {
      const rows = collectionRows(db, kept.collection).map(r => JSON.parse(r.payload_json));
      need(rows.length === kept.count && digest(rows) === kept.afterHash && digest(bindings(rows, kept.bindingFields)) === kept.bindingBefore, 'PRODUCTION_RETENTION_PRESERVATION_FAILED', 409);
    }
    for (const scalar of plan.scalars.filter(r => r.action === 'keep')) need(hashText(db.prepare('SELECT payload_json FROM json_scalars WHERE key=?').get(scalar.key)?.payload_json) === scalar.hash, 'PRODUCTION_RETENTION_SETTINGS_CHANGED', 409);
    db.exec('COMMIT');
    return { mode: 'identity_only', planDigest: plan.digest, purgedJsonRecords: plan.deleteCollections.reduce((n, r) => n + r.count, 0),
      clearedTypedRows: plan.tables.filter(t => t.action === 'clear').reduce((n, r) => n + r.beforeCount, 0), keepCollections: plan.keepCollections,
      preservedUploads: true, originalBindingsUnchanged: true };
  } catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); throw e; }
}
/** Recheck original identity fields after canonical G03 rows have been added.
 * Newly derived membershipStatus/revision do not masquerade as old binding data. */
export function verifyRetainedBindings(db, plan) {
  for (const kept of plan.keepCollections) {
    const rows = collectionRows(db, kept.collection).map(r => JSON.parse(r.payload_json));
    need(rows.length === kept.count && digest(bindings(rows, kept.bindingFields)) === kept.bindingBefore, 'PRODUCTION_RETENTION_BINDING_CHANGED', 409);
  }
  return true;
}
