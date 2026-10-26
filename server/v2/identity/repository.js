import { ensureSqliteSchema, readSqliteCollectionRecord, upsertSqliteCollectionRecord, deleteSqliteCollectionRecord,
  readSqliteScalar, upsertSqliteScalar, runSqliteTransaction } from '../../storage/sqlite-migrate.js';
import { IdentityError } from './errors.js';

export const collections = {
  accounts: 'v2Accounts', identities: 'v2Identities', bindings: 'v2SteamBindings',
  policies: 'v2EligibilityPolicies', eligibility: 'v2Eligibility', restrictions: 'v2AccessRestrictions',
  sessions: 'v2Sessions', conflicts: 'v2IdentityConflicts', events: 'v2IdentityEvents', audits: 'v2IdentityAudits',
  schedulingWipes: 'v2Wipes', members: 'members', squadMembers: 'squadMembers', squads: 'squads', wipes: 'wipes', users: 'users',
  wechatUsers: 'wechatUsers', permissionRoles: 'permissionRoles', applications: 'discordMemberApplications'
};

export function installIdentitySchema(db) {
  ensureSqliteSchema(db);
  // Versioned, explicit migration; these indexes never upgrade unverified legacy data.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS v2_identity_provider_external ON json_records
      (json_extract(payload_json,'$.provider'), json_extract(payload_json,'$.externalId')) WHERE collection='v2Identities';
    CREATE UNIQUE INDEX IF NOT EXISTS v2_account_member ON json_records
      (json_extract(payload_json,'$.memberId')) WHERE collection='v2Accounts' AND json_extract(payload_json,'$.memberId') IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS v2_verified_steam ON json_records
      (json_extract(payload_json,'$.steamId')) WHERE collection='v2SteamBindings' AND json_extract(payload_json,'$.status')='verified';
    CREATE UNIQUE INDEX IF NOT EXISTS v2_verified_account ON json_records
      (json_extract(payload_json,'$.accountId')) WHERE collection='v2SteamBindings' AND json_extract(payload_json,'$.status')='verified';
    CREATE UNIQUE INDEX IF NOT EXISTS v2_verified_member ON json_records
      (json_extract(payload_json,'$.memberId')) WHERE collection='v2SteamBindings' AND json_extract(payload_json,'$.status')='verified';
    CREATE UNIQUE INDEX IF NOT EXISTS v2_policy_provider ON json_records
      (json_extract(payload_json,'$.provider')) WHERE collection='v2EligibilityPolicies';
    CREATE INDEX IF NOT EXISTS v2_session_account ON json_records
      (json_extract(payload_json,'$.accountId')) WHERE collection='v2Sessions';
  `);
  upsertSqliteScalar(db, 'v2IdentitySchemaVersion', 1);
}

export class IdentityRepository {
  constructor(db) {
    this.db = db;
    this.readStatements = new Map();
    if (readSqliteScalar(db, 'v2IdentitySchemaVersion') !== 1) throw new IdentityError('IDENTITY_MIGRATION_REQUIRED', 503);
  }
  all(name) {
    return this.readStatement('SELECT payload_json FROM json_records WHERE collection=? ORDER BY id').all(collections[name])
      .map(row => JSON.parse(row.payload_json));
  }
  // Reuse compiled SQL only; every execution reads current SQLite rows.
  readStatement(sql) {
    if (!this.readStatements.has(sql)) this.readStatements.set(sql, this.db.prepare(sql));
    return this.readStatements.get(sql);
  }
  get(name, id) { return readSqliteCollectionRecord(this.db, collections[name], id); }
  put(name, record) { upsertSqliteCollectionRecord(this.db, collections[name], record.id, record); return record; }
  remove(name, id) { deleteSqliteCollectionRecord(this.db, collections[name], id); }
  scalar(key) { return readSqliteScalar(this.db, key); }
  setScalar(key, value) { upsertSqliteScalar(this.db, key, value); }
  transaction(fn) {
    return runSqliteTransaction(this.db, 'v2_identity', () => {
      const result = fn(this);
      if (result?.then) throw new TypeError('Identity transaction must be synchronous; fetch platform data before it.');
      return result;
    });
  }
  snapshot() { return Object.fromEntries(Object.keys(collections).map(key => [key, this.all(key)])); }
}
