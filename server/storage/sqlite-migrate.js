import crypto from 'node:crypto';
import { recordSqlitePrepare, timeSqliteWrite } from './sqlite.js';

const schemaReady = new WeakSet();
const statementBundles = new WeakMap();

export const SQLITE_SCHEMA_VERSION = 5;
const SQLITE_COLLECTION_CATALOG_SCHEMA_VERSION = 4;

const JSON_FIELD_INDEXES = {
  members: ['steamId', 'discordId', 'wechatUserId', 'battlemetricsId', 'memberStatus', 'discordMembershipStatus', 'vitalVipType'],
  users: ['boundSteamId', 'steamId', 'role'],
  sessions: ['userId', 'expiresAt'],
  squadMembers: ['memberId', 'squadId'],
  memberProfiles: ['memberId', 'steamId', 'battlemetricsPlayerId'],
  kdaRows: ['wipeId', 'memberId', 'steamId', 'syncedAt'],
  kdaSnapshots: ['wipeId', 'memberId', 'capturedAt'],
  wipeParticipants: ['wipeId', 'memberId', 'steamId'],
  wipes: ['status'],
  wipeSettlements: ['wipeId'],
  uploads: ['ownerId'],
  wechatUsers: ['openid', 'unionid', 'memberId', 'status', 'role'],
  wechatSessions: ['tokenHash', 'wechatUserId', 'expiresAt'],
  wechatNotifications: ['wechatUserId', 'readAt', 'createdAt'],
  accountAlertDismissals: ['memberId'],
  joinApplications: ['wechatUserId', 'status', 'createdAt', 'steamId'],
  memberBindRequests: ['wechatUserId', 'status', 'createdAt', 'targetMemberId'],
  rustplusRelayChatMessages: ['serverKey', 'clientId', 'sentAt', 'steamId'],
  rustplusRelayInviteRecords: ['serverKey', 'clientId', 'sentAt', 'steamId', 'inviterSteamId'],
  discordMemberApplications: ['discordUserId', 'memberId', 'steamId', 'status'],
  logs: ['createdAt', 'type', 'actorUserId', 'targetId'],
  operationRuns: ['status', 'type', 'platform', 'targetId', 'dedupeKey', 'createdAt'],
  integrationEvents: ['platform', 'eventType', 'dedupeKey', 'sourceId', 'status', 'receivedAt', 'operationRunId'],
  integrationMessageRefs: ['platform', 'kind', 'targetType', 'targetId', 'channelId', 'messageId', 'status', 'updatedAt'],
  syncJobs: ['status', 'type', 'scope', 'targetWipeId', 'targetVitalWipeId', 'targetServerId', 'createdAt', 'updatedAt'],
  messageDeletionTasks: ['platform', 'status', 'deleteAt', 'messageType']
};

const JSON_NOCASE_FIELD_INDEXES = {
  users: ['username']
};

export const SQLITE_BUSINESS_UNIQUE_CONSTRAINTS = [
  { collection: 'members', fields: ['steamId'], rule: 'members.steamId.unique' },
  { collection: 'members', fields: ['discordId'], rule: 'members.discordId.unique' },
  { collection: 'members', fields: ['wechatUserId'], rule: 'members.wechatUserId.unique' },
  { collection: 'members', fields: ['battlemetricsId'], rule: 'members.battlemetricsId.unique' },
  { collection: 'wechatUsers', fields: ['openid'], rule: 'wechatUsers.openid.unique' },
  { collection: 'wechatUsers', fields: ['unionid'], rule: 'wechatUsers.unionid.unique' },
  { collection: 'wechatUsers', fields: ['memberId'], rule: 'wechatUsers.memberId.unique' },
  { collection: 'wechatSessions', fields: ['tokenHash'], rule: 'wechatSessions.tokenHash.unique' },
  { collection: 'memberProfiles', fields: ['memberId'], rule: 'memberProfiles.memberId.unique' },
  { collection: 'squadMembers', fields: ['memberId'], rule: 'squadMembers.memberId.unique' },
  { collection: 'wipeParticipants', fields: ['wipeId', 'memberId'], rule: 'wipeParticipants.wipeId_memberId.unique' },
  { collection: 'wipeSettlements', fields: ['wipeId'], rule: 'wipeSettlements.wipeId.unique' },
  { collection: 'kdaRows', fields: ['wipeId', 'memberId'], rule: 'kdaRows.wipe_member.unique', integrity: 'custom' },
  { collection: 'kdaRows', fields: ['wipeId', 'steamId'], rule: 'kdaRows.wipe_member.unique', integrity: 'custom' },
  { collection: 'syncJobs', scopeFields: ['status'], fields: ['type', 'scope', 'targetWipeId', 'targetVitalWipeId', 'targetServerId'], rule: 'syncJobs.active.duplicate', integrity: 'custom' },
  { collection: 'operationRuns', scopeFields: ['status'], fields: ['platform', 'type', 'dedupeKey'], rule: 'operationRuns.active.dedupeKey.duplicate', integrity: 'custom' },
  { collection: 'integrationEvents', scopeFields: ['status'], fields: ['platform', 'eventType', 'dedupeKey'], rule: 'integrationEvents.dedupeKey.original.unique', integrity: 'custom' },
  {
    collection: 'integrationMessageRefs',
    scopeFields: ['status'],
    fields: ['platform', 'kind', 'targetType', 'targetId', 'channelId', 'messageId'],
    rule: 'integrationMessageRefs.active.message.unique',
    integrity: 'custom'
  }
];

const JSON_COMPOSITE_INDEXES = {
  wipeParticipants: [
    ['wipeId', 'memberId'],
    ['wipeId', 'steamId']
  ],
  kdaRows: [
    ['wipeId', 'memberId'],
    ['wipeId', 'steamId']
  ],
  kdaSnapshots: [
    ['wipeId', 'memberId']
  ],
  syncJobs: [
    ['status', 'type', 'scope', 'targetWipeId', 'targetVitalWipeId', 'targetServerId'],
    ['type', 'scope', 'targetWipeId', 'targetVitalWipeId', 'targetServerId']
  ],
  operationRuns: [
    ['status', 'platform', 'type', 'dedupeKey'],
    ['platform', 'type', 'dedupeKey'],
    ['targetId', 'status']
  ],
  integrationEvents: [
    ['status', 'receivedAt'],
    ['platform', 'eventType', 'dedupeKey'],
    ['operationRunId', 'status']
  ],
  integrationMessageRefs: [
    ['targetId', 'status'],
    ['platform', 'kind', 'targetType', 'targetId', 'channelId', 'status'],
    ['platform', 'kind', 'targetType', 'targetId', 'channelId', 'messageId']
  ],
  discordMemberApplications: [
    ['status', 'discordUserId'],
    ['status', 'steamId'],
    ['status', 'memberId']
  ],
  joinApplications: [
    ['wechatUserId', 'status'],
    ['steamId', 'status']
  ],
  memberBindRequests: [
    ['wechatUserId', 'status'],
    ['targetMemberId', 'status']
  ],
  wechatNotifications: [
    ['wechatUserId', 'createdAt']
  ],
  messageDeletionTasks: [
    ['platform', 'status', 'deleteAt']
  ]
};

export function stableJson(value) {
  return JSON.stringify(value ?? null);
}

export function payloadHash(payloadJson) {
  return crypto.createHash('sha256').update(String(payloadJson || '')).digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name || ''));
}

function sqliteTableExists(db, table) {
  return Boolean(db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(String(table || '')));
}

function storedSchemaVersion(db) {
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get();
  const version = Number(row?.value || 0);
  return Number.isFinite(version) ? Math.max(0, version) : 0;
}

function safeSqlIdentifier(value, label = 'SQLite identifier') {
  const normalized = String(value || '');
  if (!/^[A-Za-z0-9_]+$/.test(normalized)) {
    throw new Error(`Unsafe ${label}: ${normalized}`);
  }
  return normalized;
}

function sqlStringLiteral(value) {
  return `'${String(value ?? '').replaceAll("'", "''")}'`;
}

function normalizedJsonTextExpression(field) {
  const fieldKey = safeSqlIdentifier(field, 'SQLite JSON field');
  return `NULLIF(TRIM(CAST(json_extract(payload_json, '$.${fieldKey}') AS TEXT)), '')`;
}

const BUSINESS_UNIQUE_OPTIONS = {
  'syncJobs.active.duplicate': {
    requiredFields: [],
    defaults: {
      type: 'custom',
      scope: 'custom',
      targetWipeId: '-',
      targetVitalWipeId: '-',
      targetServerId: '-'
    },
    where: { field: 'status', values: ['queued', 'running'] }
  },
  'operationRuns.active.dedupeKey.duplicate': {
    requiredFields: ['dedupeKey'],
    defaults: {
      platform: 'system',
      type: 'operation'
    },
    where: { field: 'status', values: ['queued', 'running'] }
  },
  'integrationEvents.dedupeKey.original.unique': {
    requiredFields: ['dedupeKey'],
    defaults: {
      platform: 'system',
      eventType: 'event'
    },
    where: { field: 'status', excludedValues: ['duplicate'] }
  },
  'integrationMessageRefs.active.message.unique': {
    where: { field: 'status', values: ['active'] }
  }
};

function businessUniqueIndexName(constraint) {
  const collection = safeSqlIdentifier(constraint.collection, 'SQLite collection');
  const fields = constraint.fields.map((field) => safeSqlIdentifier(field, 'SQLite JSON field')).join('_');
  return `uidx_json_records_${collection}_${fields}`;
}

function businessUniqueIndexDescriptor(constraint) {
  const options = BUSINESS_UNIQUE_OPTIONS[constraint.rule] || {};
  const fields = constraint.fields.map((field) => safeSqlIdentifier(field, 'SQLite JSON field'));
  const defaults = options.defaults || {};
  const expressions = fields.map((field) => {
    const expression = normalizedJsonTextExpression(field);
    return Object.hasOwn(defaults, field)
      ? `COALESCE(${expression}, ${sqlStringLiteral(defaults[field])})`
      : expression;
  });
  const requiredFields = options.requiredFields || fields;
  const where = [`collection = ${sqlStringLiteral(constraint.collection)}`];
  for (const field of requiredFields) {
    where.push(`${normalizedJsonTextExpression(field)} IS NOT NULL`);
  }
  if (options.where?.field) {
    const expression = normalizedJsonTextExpression(options.where.field);
    if (options.where.values?.length) {
      where.push(`${expression} IN (${options.where.values.map(sqlStringLiteral).join(', ')})`);
    }
    if (options.where.excludedValues?.length) {
      where.push(`COALESCE(${expression}, '') NOT IN (${options.where.excludedValues.map(sqlStringLiteral).join(', ')})`);
    }
  }
  const indexName = businessUniqueIndexName(constraint);
  const sql = `
    CREATE UNIQUE INDEX ${indexName}
    ON json_records(${expressions.join(', ')})
    WHERE ${where.join(' AND ')}
  `;
  return {
    ...constraint,
    indexName,
    expressions,
    where: where.join(' AND '),
    sql
  };
}

function expectedBusinessUniqueIndexes() {
  return SQLITE_BUSINESS_UNIQUE_CONSTRAINTS.map(businessUniqueIndexDescriptor);
}

function normalizeSqlDefinition(value) {
  return String(value || '')
    .replace(/;\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sqliteIndexState(db) {
  const rows = db.prepare("PRAGMA index_list('json_records')").all();
  const definitions = db.prepare(`
    SELECT name, sql
    FROM sqlite_master
    WHERE type = 'index' AND tbl_name = 'json_records'
  `).all();
  const sqlByName = new Map(definitions.map((row) => [String(row.name || ''), String(row.sql || '')]));
  return new Map(rows.map((row) => {
    const name = String(row.name || '');
    return [name, {
      name,
      unique: Number(row.unique || 0) === 1,
      sql: sqlByName.get(name) || ''
    }];
  }));
}

function businessUniqueIndexMatches(descriptor, state) {
  return Boolean(
    state?.unique &&
    normalizeSqlDefinition(state.sql) === normalizeSqlDefinition(descriptor.sql)
  );
}

function findBusinessUniqueViolation(db, descriptor) {
  const valueColumns = descriptor.expressions
    .map((expression, index) => `${expression} AS value_${index}`);
  const row = db.prepare(`
    SELECT
      ${valueColumns.join(', ')},
      COUNT(*) AS duplicate_count,
      SUBSTR(GROUP_CONCAT(id), 1, 500) AS sample_ids
    FROM json_records
    WHERE ${descriptor.where}
    GROUP BY ${descriptor.expressions.join(', ')}
    HAVING COUNT(*) > 1
    LIMIT 1
  `).get();
  if (!row) return null;
  return {
    count: Number(row.duplicate_count || 0),
    ids: String(row.sample_ids || ''),
    values: Object.fromEntries(descriptor.fields.map((field, index) => [field, row[`value_${index}`]]))
  };
}

function createBusinessUniqueIndexes(db) {
  const descriptors = expectedBusinessUniqueIndexes();
  const state = sqliteIndexState(db);
  const pending = descriptors.filter((descriptor) => !businessUniqueIndexMatches(descriptor, state.get(descriptor.indexName)));
  if (!pending.length) return;

  for (const descriptor of pending) {
    const violation = findBusinessUniqueViolation(db, descriptor);
    if (!violation) continue;
    const error = new Error(
      `SQLite business UNIQUE migration blocked: ${descriptor.rule} has duplicate key ` +
      `${JSON.stringify(violation.values)} (count=${violation.count}; ids=${violation.ids || 'unknown'}). ` +
      'Remove duplicate rows before retrying.'
    );
    error.code = 'SQLITE_BUSINESS_UNIQUE_MIGRATION_BLOCKED';
    error.rule = descriptor.rule;
    error.collection = descriptor.collection;
    error.values = violation.values;
    error.count = violation.count;
    error.ids = violation.ids;
    throw error;
  }

  db.exec('BEGIN IMMEDIATE');
  let activeDescriptor = null;
  try {
    for (const descriptor of pending) {
      activeDescriptor = descriptor;
      db.exec(`DROP INDEX IF EXISTS ${descriptor.indexName}`);
      db.exec(descriptor.sql);
    }
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Keep the migration error.
    }
    const wrapped = new Error(
      `SQLite business UNIQUE migration failed for ${activeDescriptor?.rule || 'unknown rule'}: ${error.message}`,
      { cause: error }
    );
    wrapped.code = 'SQLITE_BUSINESS_UNIQUE_MIGRATION_FAILED';
    wrapped.rule = activeDescriptor?.rule || '';
    throw wrapped;
  }
}

function jsonFieldIndexName(collection, field) {
  return `idx_json_records_${safeSqlIdentifier(collection, 'SQLite collection')}_${safeSqlIdentifier(field, 'SQLite JSON field')}`;
}

function jsonNoCaseFieldIndexName(collection, field) {
  return `idx_json_records_${safeSqlIdentifier(collection, 'SQLite collection')}_${safeSqlIdentifier(field, 'SQLite JSON field')}_nocase`;
}

function jsonCompositeIndexName(collection, fields) {
  const collectionKey = safeSqlIdentifier(collection, 'SQLite collection');
  const fieldKey = fields.map((field) => safeSqlIdentifier(field, 'SQLite JSON field')).join('_');
  return `idx_json_records_${collectionKey}_${fieldKey}`;
}

function expectedJsonFieldIndexes() {
  return Object.entries(JSON_FIELD_INDEXES).flatMap(([collection, fields]) => (
    fields.map((field) => ({
      type: 'field',
      collection,
      field,
      fields: [field],
      name: jsonFieldIndexName(collection, field)
    }))
  ));
}

function expectedJsonCompositeIndexes() {
  const byName = new Map();
  for (const [collection, fieldGroups] of Object.entries(JSON_COMPOSITE_INDEXES)) {
    for (const fields of fieldGroups) {
      const normalizedFields = fields.map((field) => safeSqlIdentifier(field, 'SQLite JSON field'));
      const name = jsonCompositeIndexName(collection, normalizedFields);
      byName.set(name, {
        type: 'composite',
        collection,
        fields: normalizedFields,
        name
      });
    }
  }
  return [...byName.values()];
}

function expectedJsonNoCaseFieldIndexes() {
  return Object.entries(JSON_NOCASE_FIELD_INDEXES).flatMap(([collection, fields]) => (
    fields.map((field) => ({
      type: 'nocase',
      collection,
      field,
      fields: [field],
      name: jsonNoCaseFieldIndexName(collection, field)
    }))
  ));
}

function createJsonFieldIndexes(db) {
  for (const [collection, fields] of Object.entries(JSON_FIELD_INDEXES)) {
    const collectionKey = safeSqlIdentifier(collection, 'SQLite collection');
    for (const field of fields) {
      const fieldKey = safeSqlIdentifier(field, 'SQLite JSON field');
      const indexName = jsonFieldIndexName(collectionKey, fieldKey);
      db.exec(`
        CREATE INDEX IF NOT EXISTS ${indexName}
          ON json_records(collection, json_extract(payload_json, '$.${fieldKey}'))
          WHERE collection = '${collectionKey}';
      `);
    }
  }
}

function createJsonNoCaseFieldIndexes(db) {
  for (const [collection, fields] of Object.entries(JSON_NOCASE_FIELD_INDEXES)) {
    const collectionKey = safeSqlIdentifier(collection, 'SQLite collection');
    for (const field of fields) {
      const fieldKey = safeSqlIdentifier(field, 'SQLite JSON field');
      const indexName = jsonNoCaseFieldIndexName(collectionKey, fieldKey);
      db.exec(`
        CREATE INDEX IF NOT EXISTS ${indexName}
          ON json_records(collection, LOWER(CAST(json_extract(payload_json, '$.${fieldKey}') AS TEXT)))
          WHERE collection = '${collectionKey}';
      `);
    }
  }
}

function createJsonCompositeIndexes(db) {
  for (const { collection, fields, name } of expectedJsonCompositeIndexes()) {
    const collectionKey = safeSqlIdentifier(collection, 'SQLite collection');
    const expressions = fields
      .map((field) => `json_extract(payload_json, '$.${safeSqlIdentifier(field, 'SQLite JSON field')}')`)
      .join(', ');
    db.exec(`
      CREATE INDEX IF NOT EXISTS ${name}
        ON json_records(collection, ${expressions})
        WHERE collection = '${collectionKey}';
    `);
  }
}

function dropSupersededSyncJobIndexes(db) {
  db.exec(`
    DROP INDEX IF EXISTS uidx_json_records_syncJobs_type_scope_targetWipeId_targetServerId;
    DROP INDEX IF EXISTS idx_json_records_syncJobs_status_type_scope_targetWipeId_targetServerId;
    DROP INDEX IF EXISTS idx_json_records_syncJobs_type_scope_targetWipeId_targetServerId;
  `);
}

function firstExistingColumn(columns, names = [], fallback = "''") {
  for (const name of names) {
    if (columns.includes(name)) return name;
  }
  return fallback;
}

function migrateJsonScalarsTable(db) {
  const columns = tableColumns(db, 'json_scalars');
  const canonical = ['key', 'payload_json', 'hash', 'updated_at'];
  const legacyColumns = ['payload_hash', 'migrated_at'];
  if (canonical.every((name) => columns.includes(name)) && !legacyColumns.some((name) => columns.includes(name))) return;
  const hashExpr = firstExistingColumn(columns, ['payload_hash', 'hash']);
  const updatedAtExpr = firstExistingColumn(columns, ['updated_at', 'migrated_at'], `'${nowIso()}'`);
  db.exec(`
    CREATE TABLE json_scalars_next (
      key TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      hash TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT OR REPLACE INTO json_scalars_next(key, payload_json, hash, updated_at)
      SELECT key, payload_json, ${hashExpr}, ${updatedAtExpr}
      FROM json_scalars;
    DROP TABLE json_scalars;
    ALTER TABLE json_scalars_next RENAME TO json_scalars;
  `);
}

function migrateJsonRecordsTable(db) {
  const columns = tableColumns(db, 'json_records');
  const canonical = ['collection', 'id', 'payload_json', 'hash', 'position', 'updated_at'];
  const legacyColumns = ['record_id', 'payload_hash', 'migrated_at', 'created_at'];
  if (canonical.every((name) => columns.includes(name)) && !legacyColumns.some((name) => columns.includes(name))) return;
  const idExpr = firstExistingColumn(columns, ['id', 'record_id']);
  const hashExpr = firstExistingColumn(columns, ['payload_hash', 'hash']);
  const positionExpr = firstExistingColumn(columns, ['position'], '0');
  const updatedAtExpr = firstExistingColumn(columns, ['updated_at', 'migrated_at', 'created_at'], `'${nowIso()}'`);
  db.exec(`
    DROP INDEX IF EXISTS idx_json_records_collection_updated;
    CREATE TABLE json_records_next (
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      hash TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (collection, id)
    );
    INSERT OR REPLACE INTO json_records_next(collection, id, payload_json, hash, position, updated_at)
      SELECT collection, ${idExpr}, payload_json, ${hashExpr}, ${positionExpr}, ${updatedAtExpr}
      FROM json_records;
    DROP TABLE json_records;
    ALTER TABLE json_records_next RENAME TO json_records;
  `);
}

function migrateJsonCollectionsTable(db, options = {}) {
  if (!options.backfill) return;
  const updatedAt = nowIso();
  recordSqlitePrepare('migrateJsonCollectionsFromRecords');
  db.prepare(`
    INSERT OR IGNORE INTO json_collections(collection, updated_at)
    SELECT DISTINCT collection, ?
    FROM json_records
    WHERE collection <> ''
  `).run(updatedAt);

  recordSqlitePrepare('migrateJsonCollectionsFromStoreFull');
  db.prepare(`
    INSERT OR IGNORE INTO json_collections(collection, updated_at)
    SELECT CAST(entry.key AS TEXT), ?
    FROM json_scalars AS scalar, json_each(scalar.payload_json) AS entry
    WHERE scalar.key = 'store_full'
      AND entry.type = 'array'
      AND entry.key <> ''
  `).run(updatedAt);
}

export function ensureSqliteSchema(db) {
  if (schemaReady.has(db)) return;
  timeSqliteWrite('ensure_schema', () => {
    const hadJsonCollectionsTable = sqliteTableExists(db, 'json_collections');
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS json_scalars (
        key TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        hash TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS json_records (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        hash TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (collection, id)
      );

      CREATE TABLE IF NOT EXISTS json_collections (
        collection TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_json_records_collection_updated
        ON json_records(collection, updated_at DESC);
    `);
    recordSqlitePrepare('tableInfoJsonScalars');
    migrateJsonScalarsTable(db);
    recordSqlitePrepare('tableInfoJsonRecords');
    migrateJsonRecordsTable(db);
    const recordColumns = tableColumns(db, 'json_records');
    if (!recordColumns.includes('position')) {
      db.exec('ALTER TABLE json_records ADD COLUMN position INTEGER NOT NULL DEFAULT 0');
    }
    migrateJsonCollectionsTable(db, {
      backfill: !hadJsonCollectionsTable || storedSchemaVersion(db) < SQLITE_COLLECTION_CATALOG_SCHEMA_VERSION
    });
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_json_records_collection_updated
        ON json_records(collection, updated_at DESC);
    `);
    createJsonFieldIndexes(db);
    createJsonNoCaseFieldIndexes(db);
    dropSupersededSyncJobIndexes(db);
    createJsonCompositeIndexes(db);
    createBusinessUniqueIndexes(db);
  });
  const statements = prepareStatements(db);
  statements.upsertSchemaMeta.run('schemaVersion', String(SQLITE_SCHEMA_VERSION), nowIso());
  schemaReady.add(db);
}

function lazyStatement(db, cache, name, sql) {
  if (!cache[name]) {
    recordSqlitePrepare(name);
    cache[name] = db.prepare(sql);
  }
  return cache[name];
}

export function prepareStatements(db) {
  if (statementBundles.has(db)) return statementBundles.get(db);
  const cache = {};
  const bundle = {
    get upsertSchemaMeta() {
      return lazyStatement(db, cache, 'upsertSchemaMeta', `
        INSERT INTO schema_meta(key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `);
    },
    get getSchemaMeta() {
      return lazyStatement(db, cache, 'getSchemaMeta', 'SELECT value, updated_at FROM schema_meta WHERE key = ?');
    },
    get upsertScalar() {
      return lazyStatement(db, cache, 'upsertScalar', `
        INSERT INTO json_scalars(key, payload_json, hash, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          payload_json = excluded.payload_json,
          hash = excluded.hash,
          updated_at = excluded.updated_at
      `);
    },
    get getScalar() {
      return lazyStatement(db, cache, 'getScalar', 'SELECT payload_json, hash, updated_at FROM json_scalars WHERE key = ?');
    },
    get upsertCollectionRecord() {
      return lazyStatement(db, cache, 'upsertCollectionRecord', `
        INSERT INTO json_records(collection, id, payload_json, hash, position, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(collection, id) DO UPDATE SET
          payload_json = excluded.payload_json,
          hash = excluded.hash,
          position = excluded.position,
          updated_at = excluded.updated_at
      `);
    },
    get getCollectionRecord() {
      return lazyStatement(db, cache, 'getCollectionRecord', `
        SELECT payload_json, hash, position, updated_at
        FROM json_records
        WHERE collection = ? AND id = ?
      `);
    },
    get upsertCollectionName() {
      return lazyStatement(db, cache, 'upsertCollectionName', `
        INSERT INTO json_collections(collection, updated_at)
        VALUES (?, ?)
        ON CONFLICT(collection) DO UPDATE SET
          updated_at = excluded.updated_at
      `);
    },
    get listCollectionRecords() {
      return lazyStatement(db, cache, 'listCollectionRecords', `
        SELECT id, payload_json, hash, updated_at
        FROM json_records
        WHERE collection = ?
        ORDER BY position ASC, updated_at DESC, id ASC
        LIMIT ? OFFSET ?
      `);
    },
    get listCollectionRecordsAll() {
      return lazyStatement(db, cache, 'listCollectionRecordsAll', `
        SELECT id, payload_json, hash, updated_at
        FROM json_records
        WHERE collection = ?
        ORDER BY position ASC, updated_at DESC, id ASC
      `);
    },
    get listCollectionNames() {
      return lazyStatement(db, cache, 'listCollectionNames', `
        SELECT collection FROM json_collections
        UNION
        SELECT DISTINCT collection FROM json_records
        ORDER BY collection ASC
      `);
    },
    get listScalarKeys() {
      return lazyStatement(db, cache, 'listScalarKeys', 'SELECT key FROM json_scalars ORDER BY key ASC');
    },
    get listCollectionIds() {
      return lazyStatement(db, cache, 'listCollectionIds', 'SELECT id, hash, position FROM json_records WHERE collection = ?');
    },
    get deleteCollectionRecord() {
      return lazyStatement(db, cache, 'deleteCollectionRecord', 'DELETE FROM json_records WHERE collection = ? AND id = ?');
    },
    get countCollectionRecords() {
      return lazyStatement(db, cache, 'countCollectionRecords', 'SELECT COUNT(*) AS count FROM json_records WHERE collection = ?');
    },
    get countAllRecords() {
      return lazyStatement(db, cache, 'countAllRecords', `
        SELECT collection, COUNT(*) AS count
        FROM json_records
        GROUP BY collection
        ORDER BY collection ASC
      `);
    },
    _cache: cache
  };
  statementBundles.set(db, bundle);
  return bundle;
}

export function runSqliteTransaction(db, name, fn) {
  return timeSqliteWrite(name, () => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn(prepareStatements(db));
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Keep the original error.
      }
      throw error;
    }
  });
}

export function upsertSqliteScalar(db, key, value, options = {}) {
  const statements = options.statements || prepareStatements(db);
  const payloadJson = stableJson(value);
  statements.upsertScalar.run(String(key), payloadJson, payloadHash(payloadJson), options.updatedAt || nowIso());
}

export function readSqliteScalar(db, key, options = {}) {
  const statements = options.statements || prepareStatements(db);
  const row = statements.getScalar.get(String(key));
  if (!row) return null;
  return JSON.parse(row.payload_json);
}

export function upsertSqliteCollectionRecord(db, collection, id, value, options = {}) {
  const statements = options.statements || prepareStatements(db);
  const updatedAt = options.updatedAt || nowIso();
  const payloadJson = stableJson(value);
  statements.upsertCollectionName.run(String(collection), updatedAt);
  statements.upsertCollectionRecord.run(
    String(collection),
    String(id),
    payloadJson,
    payloadHash(payloadJson),
    Math.max(0, Number(options.position || 0)),
    updatedAt
  );
}

export function deleteSqliteCollectionRecord(db, collection, id, options = {}) {
  const statements = options.statements || prepareStatements(db);
  statements.upsertCollectionName.run(String(collection), options.updatedAt || nowIso());
  statements.deleteCollectionRecord.run(String(collection), String(id));
}

export function readSqliteCollectionRecord(db, collection, id, options = {}) {
  const statements = options.statements || prepareStatements(db);
  const row = statements.getCollectionRecord.get(String(collection), String(id));
  if (!row) return null;
  return JSON.parse(row.payload_json);
}

export function listSqliteCollectionRecordsByIds(db, collection, ids = [], options = {}) {
  const collectionKey = String(collection);
  const items = (Array.isArray(ids) ? ids : [ids])
    .map((value) => String(value ?? ''))
    .filter(Boolean);
  if (!items.length) return [];
  const uniqueItems = [...new Set(items)].slice(0, 1000);
  const placeholders = uniqueItems.map(() => '?').join(', ');
  const hasLimit = options.limit !== 0 && options.limit !== 'all' && Object.hasOwn(options, 'limit');
  const limitClause = hasLimit ? 'LIMIT ? OFFSET ?' : '';
  const sql = `
    SELECT id, payload_json, hash, updated_at
    FROM json_records
    WHERE collection = ? AND id IN (${placeholders})
    ORDER BY position ASC, updated_at DESC, id ASC
    ${limitClause}
  `;
  const statements = options.statements || prepareStatements(db);
  const statementName = `listCollectionRecordsByIds_${uniqueItems.length}${hasLimit ? '_limited' : ''}`;
  const statement = lazyStatement(db, statements._cache, statementName, sql);
  const args = [collectionKey, ...uniqueItems];
  if (hasLimit) {
    const limit = Math.min(Math.max(Number(options.limit || 100), 1), 1000);
    const offset = Math.max(Number(options.offset || 0), 0);
    args.push(limit, offset);
  }
  return statement.all(...args).map((row) => JSON.parse(row.payload_json));
}

export function findSqliteCollectionRecordByJsonField(db, collection, field, value, options = {}) {
  const fieldKey = safeSqlIdentifier(field, 'SQLite JSON field');
  if (fieldKey === 'id') {
    return listSqliteCollectionRecordsByIds(db, collection, [value], { ...options, limit: 1 })[0] || null;
  }
  const statements = options.statements || prepareStatements(db);
  const statementName = `findCollectionRecordByJsonField_${fieldKey}`;
  const statement = lazyStatement(db, statements._cache, statementName, `
    SELECT payload_json, hash, updated_at
    FROM json_records
    WHERE collection = ? AND json_extract(payload_json, '$.${fieldKey}') = ?
    ORDER BY position ASC, updated_at DESC, id ASC
    LIMIT 1
  `);
  const row = statement.get(String(collection), String(value ?? ''));
  if (!row) return null;
  return JSON.parse(row.payload_json);
}

export function listSqliteCollectionRecordsByJsonField(db, collection, field, values = [], options = {}) {
  const fieldKey = safeSqlIdentifier(field, 'SQLite JSON field');
  if (fieldKey === 'id') {
    return listSqliteCollectionRecordsByIds(db, collection, values, options);
  }
  const collectionKey = String(collection);
  const items = (Array.isArray(values) ? values : [values])
    .map((value) => String(value ?? ''))
    .filter(Boolean);
  if (!items.length) return [];
  const uniqueItems = [...new Set(items)].slice(0, 1000);
  const placeholders = uniqueItems.map(() => '?').join(', ');
  const hasLimit = options.limit !== 0 && options.limit !== 'all' && Object.hasOwn(options, 'limit');
  const limitClause = hasLimit ? 'LIMIT ? OFFSET ?' : '';
  const sql = `
    SELECT id, payload_json, hash, updated_at
    FROM json_records
    WHERE collection = ? AND json_extract(payload_json, '$.${fieldKey}') IN (${placeholders})
    ORDER BY position ASC, updated_at DESC, id ASC
    ${limitClause}
  `;
  const statements = options.statements || prepareStatements(db);
  const statementName = `listCollectionRecordsByJsonField_${fieldKey}_${uniqueItems.length}${hasLimit ? '_limited' : ''}`;
  const statement = lazyStatement(db, statements._cache, statementName, sql);
  const args = [collectionKey, ...uniqueItems];
  if (hasLimit) {
    const limit = Math.min(Math.max(Number(options.limit || 100), 1), 1000);
    const offset = Math.max(Number(options.offset || 0), 0);
    args.push(limit, offset);
  }
  return statement.all(...args).map((row) => JSON.parse(row.payload_json));
}

export function listSqliteCollectionRecordsByJsonArrayField(db, collection, field, values = [], options = {}) {
  const fieldKey = safeSqlIdentifier(field, 'SQLite JSON field');
  const collectionKey = String(collection);
  const items = (Array.isArray(values) ? values : [values])
    .map((value) => String(value ?? ''))
    .filter(Boolean);
  if (!items.length) return [];
  const uniqueItems = [...new Set(items)].slice(0, 1000);
  const placeholders = uniqueItems.map(() => '?').join(', ');
  const hasLimit = options.limit !== 0 && options.limit !== 'all' && Object.hasOwn(options, 'limit');
  const limitClause = hasLimit ? 'LIMIT ? OFFSET ?' : '';
  const sql = `
    SELECT DISTINCT r.id, r.payload_json, r.hash, r.updated_at, r.position
    FROM json_records r, json_each(r.payload_json, '$.${fieldKey}') item
    WHERE r.collection = ? AND CAST(item.value AS TEXT) IN (${placeholders})
    ORDER BY r.position ASC, r.updated_at DESC, r.id ASC
    ${limitClause}
  `;
  const statements = options.statements || prepareStatements(db);
  const statementName = `listCollectionRecordsByJsonArrayField_${fieldKey}_${uniqueItems.length}${hasLimit ? '_limited' : ''}`;
  const statement = lazyStatement(db, statements._cache, statementName, sql);
  const args = [collectionKey, ...uniqueItems];
  if (hasLimit) {
    const limit = Math.min(Math.max(Number(options.limit || 100), 1), 1000);
    const offset = Math.max(Number(options.offset || 0), 0);
    args.push(limit, offset);
  }
  return statement.all(...args).map((row) => JSON.parse(row.payload_json));
}

export function listSqliteCollectionRecordsByJsonFieldNoCase(db, collection, field, values = [], options = {}) {
  const fieldKey = safeSqlIdentifier(field, 'SQLite JSON field');
  const collectionKey = String(collection);
  const items = (Array.isArray(values) ? values : [values])
    .map((value) => String(value ?? '').trim().toLowerCase())
    .filter(Boolean);
  if (!items.length) return [];
  const uniqueItems = [...new Set(items)].slice(0, 1000);
  const placeholders = uniqueItems.map(() => '?').join(', ');
  const hasLimit = options.limit !== 0 && options.limit !== 'all' && Object.hasOwn(options, 'limit');
  const limitClause = hasLimit ? 'LIMIT ? OFFSET ?' : '';
  const sql = `
    SELECT id, payload_json, hash, updated_at
    FROM json_records
    WHERE collection = ? AND LOWER(CAST(json_extract(payload_json, '$.${fieldKey}') AS TEXT)) IN (${placeholders})
    ORDER BY position ASC, updated_at DESC, id ASC
    ${limitClause}
  `;
  const statements = options.statements || prepareStatements(db);
  const statementName = `listCollectionRecordsByJsonFieldNoCase_${fieldKey}_${uniqueItems.length}${hasLimit ? '_limited' : ''}`;
  const statement = lazyStatement(db, statements._cache, statementName, sql);
  const args = [collectionKey, ...uniqueItems];
  if (hasLimit) {
    const limit = Math.min(Math.max(Number(options.limit || 100), 1), 1000);
    const offset = Math.max(Number(options.offset || 0), 0);
    args.push(limit, offset);
  }
  return statement.all(...args).map((row) => JSON.parse(row.payload_json));
}

function normalizeJsonFieldFilters(filters = {}) {
  const entries = Array.isArray(filters)
    ? filters
    : Object.entries(filters || {});
  return entries
    .map((entry) => {
      if (Array.isArray(entry)) return { field: entry[0], values: entry[1] };
      return { field: entry?.field, values: entry?.values ?? entry?.value };
    })
    .map((entry) => ({
      field: safeSqlIdentifier(entry.field, 'SQLite JSON field'),
      values: (Array.isArray(entry.values) ? entry.values : [entry.values])
        .map((value) => String(value ?? ''))
        .filter(Boolean)
    }))
    .filter((entry) => entry.field && entry.values.length);
}

function escapeSqlLikePattern(value) {
  return String(value ?? '').replace(/[\\%_]/g, (match) => `\\${match}`);
}

export function listSqliteCollectionRecordsByJsonFieldTextContainsNoCase(db, collection, field, values = [], options = {}) {
  const fieldKey = safeSqlIdentifier(field, 'SQLite JSON field');
  const collectionKey = String(collection);
  const items = (Array.isArray(values) ? values : [values])
    .map((value) => String(value ?? '').trim().toLowerCase())
    .filter(Boolean);
  if (!items.length) return [];
  const uniqueItems = [...new Set(items)].slice(0, 1000);
  const conditions = uniqueItems.map(() => `LOWER(CAST(json_extract(payload_json, '$.${fieldKey}') AS TEXT)) LIKE ? ESCAPE '\\'`);
  const hasLimit = options.limit !== 0 && options.limit !== 'all' && Object.hasOwn(options, 'limit');
  const limitClause = hasLimit ? 'LIMIT ? OFFSET ?' : '';
  const sql = `
    SELECT id, payload_json, hash, updated_at
    FROM json_records
    WHERE collection = ?
      AND json_type(payload_json, '$.${fieldKey}') IS NOT NULL
      AND (${conditions.join(' OR ')})
    ORDER BY position ASC, updated_at DESC, id ASC
    ${limitClause}
  `;
  const statements = options.statements || prepareStatements(db);
  const statementName = `listCollectionRecordsByJsonFieldTextContainsNoCase_${fieldKey}_${uniqueItems.length}${hasLimit ? '_limited' : ''}`;
  const statement = lazyStatement(db, statements._cache, statementName, sql);
  const args = [collectionKey, ...uniqueItems.map((item) => `%${escapeSqlLikePattern(item)}%`)];
  if (hasLimit) {
    const limit = Math.min(Math.max(Number(options.limit || 100), 1), 1000);
    const offset = Math.max(Number(options.offset || 0), 0);
    args.push(limit, offset);
  }
  return statement.all(...args).map((row) => JSON.parse(row.payload_json));
}

export function listSqliteCollectionRecordsByJsonFieldMissingOrNotIn(db, collection, field, values = [], options = {}) {
  const fieldKey = safeSqlIdentifier(field, 'SQLite JSON field');
  const collectionKey = String(collection);
  const items = (Array.isArray(values) ? values : [values])
    .map((value) => String(value ?? ''))
    .filter(Boolean);
  const uniqueItems = [...new Set(items)].slice(0, 1000);
  const expression = `json_extract(payload_json, '$.${fieldKey}')`;
  const placeholders = uniqueItems.map(() => '?').join(', ');
  const valueCondition = uniqueItems.length ? `CAST(${expression} AS TEXT) NOT IN (${placeholders})` : '1 = 1';
  const hasLimit = options.limit !== 0 && options.limit !== 'all' && Object.hasOwn(options, 'limit');
  const limitClause = hasLimit ? 'LIMIT ? OFFSET ?' : '';
  const sql = `
    SELECT id, payload_json, hash, updated_at
    FROM json_records
    WHERE collection = ?
      AND (
        json_type(payload_json, '$.${fieldKey}') IS NULL
        OR NULLIF(TRIM(CAST(${expression} AS TEXT)), '') IS NULL
        OR ${valueCondition}
      )
    ORDER BY position ASC, updated_at DESC, id ASC
    ${limitClause}
  `;
  const statements = options.statements || prepareStatements(db);
  const statementName = `listCollectionRecordsByJsonFieldMissingOrNotIn_${fieldKey}_${uniqueItems.length}${hasLimit ? '_limited' : ''}`;
  const statement = lazyStatement(db, statements._cache, statementName, sql);
  const args = [collectionKey, ...uniqueItems];
  if (hasLimit) {
    const limit = Math.min(Math.max(Number(options.limit || 100), 1), 1000);
    const offset = Math.max(Number(options.offset || 0), 0);
    args.push(limit, offset);
  }
  return statement.all(...args).map((row) => JSON.parse(row.payload_json));
}

function sqliteJsonRelationTargetCondition(options = {}) {
  const targetCollectionKey = String(options.relationTargetCollection || '');
  const targetFieldKey = options.relationTargetField
    ? safeSqlIdentifier(options.relationTargetField, 'SQLite JSON relation target field')
    : '';
  if (!targetCollectionKey || !targetFieldKey) {
    return {
      sql: '',
      args: [],
      statementPart: 'any'
    };
  }
  return {
    sql: `
          AND EXISTS (
            SELECT 1
            FROM json_records t
            WHERE t.collection = ?
              AND t.id = CAST(json_extract(r.payload_json, '$.${targetFieldKey}') AS TEXT)
          )`,
    args: [targetCollectionKey],
    statementPart: `existing_${targetFieldKey}`
  };
}

export function listSqliteCollectionRecordsWithoutJsonRelation(db, collection, relationCollection, relationField, options = {}) {
  const collectionKey = String(collection);
  const relationCollectionKey = String(relationCollection);
  const relationFieldKey = safeSqlIdentifier(relationField, 'SQLite JSON relation field');
  const targetCondition = sqliteJsonRelationTargetCondition(options);
  const hasLimit = options.limit !== 0 && options.limit !== 'all' && Object.hasOwn(options, 'limit');
  const limitClause = hasLimit ? 'LIMIT ? OFFSET ?' : '';
  const sql = `
    SELECT m.id, m.payload_json, m.hash, m.updated_at
    FROM json_records m
    WHERE m.collection = ?
      AND NOT EXISTS (
        SELECT 1
        FROM json_records r
        WHERE r.collection = ?
          AND CAST(json_extract(r.payload_json, '$.${relationFieldKey}') AS TEXT) = m.id
          ${targetCondition.sql}
      )
    ORDER BY m.position ASC, m.updated_at DESC, m.id ASC
    ${limitClause}
  `;
  const statements = options.statements || prepareStatements(db);
  const statementName = `listCollectionRecordsWithoutJsonRelation_${relationFieldKey}_${targetCondition.statementPart}${hasLimit ? '_limited' : ''}`;
  const statement = lazyStatement(db, statements._cache, statementName, sql);
  const args = [collectionKey, relationCollectionKey, ...targetCondition.args];
  if (hasLimit) {
    const limit = Math.min(Math.max(Number(options.limit || 100), 1), 1000);
    const offset = Math.max(Number(options.offset || 0), 0);
    args.push(limit, offset);
  }
  return statement.all(...args).map((row) => JSON.parse(row.payload_json));
}

function sqliteTrimmedLowerJsonText(alias, field, maxLength = 240) {
  const fieldKey = safeSqlIdentifier(field, 'SQLite JSON field');
  const length = Math.max(1, Math.min(1000, Number(maxLength || 240)));
  return `LOWER(SUBSTR(TRIM(CAST(json_extract(${alias}.payload_json, '$.${fieldKey}') AS TEXT)), 1, ${length}))`;
}

function sqliteMemberDisplayNameExpression(alias = 'm') {
  const customName = `CAST(json_extract(${alias}.payload_json, '$.customName') AS TEXT)`;
  const steamNickname = `CAST(json_extract(${alias}.payload_json, '$.steamNickname') AS TEXT)`;
  const steamId = `CAST(json_extract(${alias}.payload_json, '$.steamId') AS TEXT)`;
  return `LOWER(SUBSTR(TRIM(CASE
      WHEN NULLIF(TRIM(${customName}), '') IS NOT NULL THEN ${customName}
      WHEN NULLIF(TRIM(${steamNickname}), '') IS NOT NULL THEN ${steamNickname}
      ELSE 'Steam ' || SUBSTR(${steamId}, -6)
    END), 1, 240))`;
}

function sqliteMemberSearchConditions() {
  const fields = ['customName', 'steamNickname', 'steamId', 'discordId', 'discordName', 'wechatId', 'notes'];
  const memberConditions = [
    `${sqliteMemberDisplayNameExpression('m')} LIKE ? ESCAPE '\\'`,
    ...fields.map((field) => `${sqliteTrimmedLowerJsonText('m', field)} LIKE ? ESCAPE '\\'`)
  ];
  const squadNameCondition = `EXISTS (
        SELECT 1
        FROM json_records r
        JOIN json_records s
          ON s.collection = ?
         AND s.id = CAST(json_extract(r.payload_json, '$.squadId') AS TEXT)
        WHERE r.collection = ?
          AND CAST(json_extract(r.payload_json, '$.memberId') AS TEXT) = m.id
          AND ${sqliteTrimmedLowerJsonText('s', 'name')} LIKE ? ESCAPE '\\'
      )`;
  return {
    sql: `(${[...memberConditions, squadNameCondition].join(' OR ')})`,
    memberPatternCount: memberConditions.length
  };
}

export function listSqliteMemberSearchRecords(db, query, options = {}) {
  const normalizedQuery = String(query || '').trim().toLowerCase();
  if (!normalizedQuery) return [];
  const pattern = `%${escapeSqlLikePattern(normalizedQuery)}%`;
  const { sql: searchSql, memberPatternCount } = sqliteMemberSearchConditions();
  const hasLimit = options.limit !== 0 && options.limit !== 'all' && Object.hasOwn(options, 'limit');
  const limitClause = hasLimit ? 'LIMIT ? OFFSET ?' : '';
  const statementName = `listMemberSearchRecords_${hasLimit ? 'limited' : 'all'}`;
  const statements = options.statements || prepareStatements(db);
  const statement = lazyStatement(db, statements._cache, statementName, `
    SELECT m.id, m.payload_json, m.hash, m.updated_at
    FROM json_records m
    WHERE m.collection = ?
      AND ${searchSql}
    ORDER BY m.position ASC, m.updated_at DESC, m.id ASC
    ${limitClause}
  `);
  const args = ['members', ...Array.from({ length: memberPatternCount }, () => pattern), 'squads', 'squadMembers', pattern];
  if (hasLimit) {
    const limit = Math.min(Math.max(Number(options.limit || 100), 1), 1000);
    const offset = Math.max(Number(options.offset || 0), 0);
    args.push(limit, offset);
  }
  return statement.all(...args).map((row) => JSON.parse(row.payload_json));
}

function sqliteVitalVipTypeExpression(alias = 'm') {
  const raw = `LOWER(TRIM(CAST(json_extract(${alias}.payload_json, '$.vitalVipType') AS TEXT)))`;
  return `CASE
      WHEN ${raw} IN ('queue', 'skip', 'no_queue', 'queue-skip', 'queue_skip') THEN 'queue_skip'
      WHEN ${raw} IN ('vip', 'priority_queue', 'priority') THEN 'priority'
      WHEN ${raw} = 'none' THEN 'none'
      ELSE 'none'
    END`;
}

function normalizeSqliteVitalVipTypes(values = []) {
  const aliases = {
    queue: 'queue_skip',
    skip: 'queue_skip',
    no_queue: 'queue_skip',
    'queue-skip': 'queue_skip',
    queue_skip: 'queue_skip',
    vip: 'priority',
    priority_queue: 'priority',
    priority: 'priority',
    none: 'none'
  };
  return [...new Set((Array.isArray(values) ? values : [values])
    .map((value) => aliases[String(value ?? '').trim().toLowerCase()] || 'none')
    .filter((value) => ['none', 'priority', 'queue_skip'].includes(value)))];
}

export function listSqliteMemberVitalVipRecords(db, vitalVipTypes = [], options = {}) {
  const normalizedTypes = normalizeSqliteVitalVipTypes(vitalVipTypes);
  if (!normalizedTypes.length) return [];
  const placeholders = normalizedTypes.map(() => '?').join(', ');
  const expression = sqliteVitalVipTypeExpression('m');
  const hasLimit = options.limit !== 0 && options.limit !== 'all' && Object.hasOwn(options, 'limit');
  const limitClause = hasLimit ? 'LIMIT ? OFFSET ?' : '';
  const statementName = `listMemberVitalVipRecords_${normalizedTypes.length}${hasLimit ? '_limited' : ''}`;
  const statements = options.statements || prepareStatements(db);
  const statement = lazyStatement(db, statements._cache, statementName, `
    SELECT m.id, m.payload_json, m.hash, m.updated_at
    FROM json_records m
    WHERE m.collection = ?
      AND ${expression} IN (${placeholders})
    ORDER BY m.position ASC, m.updated_at DESC, m.id ASC
    ${limitClause}
  `);
  const args = ['members', ...normalizedTypes];
  if (hasLimit) {
    const limit = Math.min(Math.max(Number(options.limit || 100), 1), 1000);
    const offset = Math.max(Number(options.offset || 0), 0);
    args.push(limit, offset);
  }
  return statement.all(...args).map((row) => JSON.parse(row.payload_json));
}

export function listSqliteCollectionRecordsByJsonFields(db, collection, filters = {}, options = {}) {
  const collectionKey = String(collection);
  const normalizedFilters = normalizeJsonFieldFilters(filters);
  if (!normalizedFilters.length) return [];
  const conditions = ['collection = ?'];
  const args = [collectionKey];
  const statementParts = [];
  for (const filter of normalizedFilters.slice(0, 8)) {
    const uniqueItems = [...new Set(filter.values)].slice(0, 1000);
    if (!uniqueItems.length) return [];
    const placeholders = uniqueItems.map(() => '?').join(', ');
    const expression = filter.field === 'id' ? 'id' : `json_extract(payload_json, '$.${filter.field}')`;
    conditions.push(uniqueItems.length === 1
      ? `${expression} = ?`
      : `${expression} IN (${placeholders})`);
    args.push(...uniqueItems);
    statementParts.push(`${filter.field}${uniqueItems.length}`);
  }
  const hasLimit = options.limit !== 0 && options.limit !== 'all' && Object.hasOwn(options, 'limit');
  const limitClause = hasLimit ? 'LIMIT ? OFFSET ?' : '';
  const sql = `
    SELECT id, payload_json, hash, updated_at
    FROM json_records
    WHERE ${conditions.join(' AND ')}
    ORDER BY position ASC, updated_at DESC, id ASC
    ${limitClause}
  `;
  const statements = options.statements || prepareStatements(db);
  const statementName = `listCollectionRecordsByJsonFields_${statementParts.join('_')}${hasLimit ? '_limited' : ''}`;
  const statement = lazyStatement(db, statements._cache, statementName, sql);
  if (hasLimit) {
    const limit = Math.min(Math.max(Number(options.limit || 100), 1), 1000);
    const offset = Math.max(Number(options.offset || 0), 0);
    args.push(limit, offset);
  }
  return statement.all(...args).map((row) => JSON.parse(row.payload_json));
}

export function listSqliteCollectionRecordsWhereJsonFieldPresent(db, collection, field, options = {}) {
  const fieldKey = safeSqlIdentifier(field, 'SQLite JSON field');
  const collectionKey = String(collection);
  const hasLimit = options.limit !== 0 && options.limit !== 'all' && Object.hasOwn(options, 'limit');
  const limitClause = hasLimit ? 'LIMIT ? OFFSET ?' : '';
  const sql = `
    SELECT id, payload_json, hash, updated_at
    FROM json_records
    WHERE collection = ?
      AND NULLIF(TRIM(CAST(json_extract(payload_json, '$.${fieldKey}') AS TEXT)), '') IS NOT NULL
    ORDER BY position ASC, updated_at DESC, id ASC
    ${limitClause}
  `;
  const statements = options.statements || prepareStatements(db);
  const statementName = `listCollectionRecordsWhereJsonFieldPresent_${fieldKey}${hasLimit ? '_limited' : ''}`;
  const statement = lazyStatement(db, statements._cache, statementName, sql);
  const args = [collectionKey];
  if (hasLimit) {
    const limit = Math.min(Math.max(Number(options.limit || 100), 1), 1000);
    const offset = Math.max(Number(options.offset || 0), 0);
    args.push(limit, offset);
  }
  return statement.all(...args).map((row) => JSON.parse(row.payload_json));
}

export function listSqliteCollectionRecordsWhereJsonFieldMissing(db, collection, field, options = {}) {
  const fieldKey = safeSqlIdentifier(field, 'SQLite JSON field');
  const collectionKey = String(collection);
  const hasLimit = options.limit !== 0 && options.limit !== 'all' && Object.hasOwn(options, 'limit');
  const limitClause = hasLimit ? 'LIMIT ? OFFSET ?' : '';
  const sql = `
    SELECT id, payload_json, hash, updated_at
    FROM json_records
    WHERE collection = ?
      AND (
        json_type(payload_json, '$.${fieldKey}') IS NULL
        OR NULLIF(TRIM(CAST(json_extract(payload_json, '$.${fieldKey}') AS TEXT)), '') IS NULL
      )
    ORDER BY position ASC, updated_at DESC, id ASC
    ${limitClause}
  `;
  const statements = options.statements || prepareStatements(db);
  const statementName = `listCollectionRecordsWhereJsonFieldMissing_${fieldKey}${hasLimit ? '_limited' : ''}`;
  const statement = lazyStatement(db, statements._cache, statementName, sql);
  const args = [collectionKey];
  if (hasLimit) {
    const limit = Math.min(Math.max(Number(options.limit || 100), 1), 1000);
    const offset = Math.max(Number(options.offset || 0), 0);
    args.push(limit, offset);
  }
  return statement.all(...args).map((row) => JSON.parse(row.payload_json));
}

export function listSqliteCollectionRecords(db, collection, options = {}) {
  const statements = options.statements || prepareStatements(db);
  if (options.limit === 0 || options.limit === 'all') {
    return statements.listCollectionRecordsAll.all(String(collection)).map((row) => JSON.parse(row.payload_json));
  }
  const limit = Math.min(Math.max(Number(options.limit || 100), 1), 1000);
  const offset = Math.max(Number(options.offset || 0), 0);
  return statements.listCollectionRecords.all(String(collection), limit, offset).map((row) => JSON.parse(row.payload_json));
}

export function deleteSqliteCollectionRecordsBeyondJsonFieldLimit(db, collection, field, limit, options = {}) {
  const fieldKey = safeSqlIdentifier(field, 'SQLite JSON field');
  const collectionKey = String(collection);
  const keep = Math.max(0, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 0);
  const order = String(options.order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const normalizedFilters = normalizeJsonFieldFilters(options.filters || {});
  const conditions = ['collection = ?'];
  const args = [collectionKey];
  const statementParts = [fieldKey, order.toLowerCase()];
  for (const filter of normalizedFilters.slice(0, 8)) {
    const uniqueItems = [...new Set(filter.values)].slice(0, 1000);
    if (!uniqueItems.length) return [];
    const placeholders = uniqueItems.map(() => '?').join(', ');
    const expression = filter.field === 'id' ? 'id' : `json_extract(payload_json, '$.${filter.field}')`;
    conditions.push(uniqueItems.length === 1
      ? `${expression} = ?`
      : `${expression} IN (${placeholders})`);
    args.push(...uniqueItems);
    statementParts.push(`${filter.field}${uniqueItems.length}`);
  }
  const afterOffsetRange = options.afterOffsetRange && typeof options.afterOffsetRange === 'object'
    ? options.afterOffsetRange
    : null;
  const rangeConditions = [];
  const rangeArgs = [];
  if (afterOffsetRange) {
    const rangeFieldKey = safeSqlIdentifier(afterOffsetRange.field || field, 'SQLite JSON field');
    const from = String(afterOffsetRange.from || '');
    const to = String(afterOffsetRange.to || '');
    if (from) {
      rangeConditions.push(`json_extract(payload_json, '$.${rangeFieldKey}') >= ?`);
      rangeArgs.push(from);
    }
    if (to) {
      rangeConditions.push(`json_extract(payload_json, '$.${rangeFieldKey}') ${afterOffsetRange.toInclusive ? '<=' : '<'} ?`);
      rangeArgs.push(to);
    }
    statementParts.push(
      `range_${rangeFieldKey}_${Boolean(from)}_${Boolean(to)}_${Boolean(afterOffsetRange.toInclusive)}`
    );
  }
  const rangeWhere = rangeConditions.length ? `WHERE ${rangeConditions.join(' AND ')}` : '';
  const statements = options.statements || prepareStatements(db);
  const statementName = `listCollectionRecordIdsBeyondJsonFieldLimit_${statementParts.join('_')}`;
  const statement = lazyStatement(db, statements._cache, statementName, `
    SELECT id
    FROM (
      SELECT id, payload_json
      FROM json_records
      WHERE ${conditions.join(' AND ')}
      ORDER BY json_extract(payload_json, '$.${fieldKey}') ${order}, updated_at DESC, id ASC
      LIMIT -1 OFFSET ?
    )
    ${rangeWhere}
  `);
  const rows = statement.all(...args, keep, ...rangeArgs);
  const deletedIds = [];
  for (const row of rows) {
    const id = String(row?.id || '');
    if (!id) continue;
    statements.deleteCollectionRecord.run(collectionKey, id);
    deletedIds.push(id);
  }
  return deletedIds;
}

export function countSqliteCollectionRecordsByJsonTimeRange(db, collection, field, range = {}, options = {}) {
  const fieldKey = safeSqlIdentifier(field, 'SQLite JSON field');
  const statements = options.statements || prepareStatements(db);
  const conditions = ['collection = ?'];
  const args = [String(collection)];
  const from = String(range.from || '');
  const to = String(range.to || '');
  if (from) {
    conditions.push(`json_extract(payload_json, '$.${fieldKey}') >= ?`);
    args.push(from);
  }
  if (to) {
    conditions.push(`json_extract(payload_json, '$.${fieldKey}') < ?`);
    args.push(to);
  }
  const statementName = `countCollectionRecordsByJsonTimeRange_${fieldKey}_${Boolean(from)}_${Boolean(to)}`;
  const statement = lazyStatement(db, statements._cache, statementName, `
    SELECT COUNT(*) AS count
    FROM json_records
    WHERE ${conditions.join(' AND ')}
  `);
  const row = statement.get(...args);
  return Number(row?.count || 0);
}

export function countSqliteCollectionRecordsByJsonField(db, collection, field, values = [], options = {}) {
  const fieldKey = safeSqlIdentifier(field, 'SQLite JSON field');
  const items = (Array.isArray(values) ? values : [values])
    .map((value) => String(value ?? ''))
    .filter(Boolean);
  if (!items.length) return {};
  const uniqueItems = [...new Set(items)].slice(0, 1000);
  const placeholders = uniqueItems.map(() => '?').join(', ');
  const statements = options.statements || prepareStatements(db);
  const expression = `json_extract(payload_json, '$.${fieldKey}')`;
  const statementName = `countCollectionRecordsByJsonField_${fieldKey}_${uniqueItems.length}`;
  const statement = lazyStatement(db, statements._cache, statementName, `
    SELECT CAST(${expression} AS TEXT) AS value, COUNT(*) AS count
    FROM json_records
    WHERE collection = ? AND ${expression} IN (${placeholders})
    GROUP BY CAST(${expression} AS TEXT)
  `);
  const rows = statement.all(String(collection), ...uniqueItems);
  const counts = Object.fromEntries(uniqueItems.map((value) => [value, 0]));
  for (const row of rows) {
    const value = String(row?.value ?? '');
    if (!value) continue;
    counts[value] = Number(row?.count || 0);
  }
  return counts;
}

export function countSqliteCollectionRecordsWithoutJsonRelation(db, collection, relationCollection, relationField, options = {}) {
  const collectionKey = String(collection);
  const relationCollectionKey = String(relationCollection);
  const relationFieldKey = safeSqlIdentifier(relationField, 'SQLite JSON relation field');
  const targetCondition = sqliteJsonRelationTargetCondition(options);
  const statements = options.statements || prepareStatements(db);
  const statementName = `countCollectionRecordsWithoutJsonRelation_${relationFieldKey}_${targetCondition.statementPart}`;
  const statement = lazyStatement(db, statements._cache, statementName, `
    SELECT COUNT(*) AS count
    FROM json_records m
    WHERE m.collection = ?
      AND NOT EXISTS (
        SELECT 1
        FROM json_records r
        WHERE r.collection = ?
          AND CAST(json_extract(r.payload_json, '$.${relationFieldKey}') AS TEXT) = m.id
          ${targetCondition.sql}
      )
  `);
  const row = statement.get(collectionKey, relationCollectionKey, ...targetCondition.args);
  return Number(row?.count || 0);
}

export function countSqliteMemberSearchRecords(db, query, options = {}) {
  const normalizedQuery = String(query || '').trim().toLowerCase();
  if (!normalizedQuery) return 0;
  const pattern = `%${escapeSqlLikePattern(normalizedQuery)}%`;
  const { sql: searchSql, memberPatternCount } = sqliteMemberSearchConditions();
  const statementName = 'countMemberSearchRecords';
  const statements = options.statements || prepareStatements(db);
  const statement = lazyStatement(db, statements._cache, statementName, `
    SELECT COUNT(*) AS count
    FROM json_records m
    WHERE m.collection = ?
      AND ${searchSql}
  `);
  const row = statement.get('members', ...Array.from({ length: memberPatternCount }, () => pattern), 'squads', 'squadMembers', pattern);
  return Number(row?.count || 0);
}

export function countSqliteMemberVitalVipRecords(db, vitalVipTypes = [], options = {}) {
  const normalizedTypes = normalizeSqliteVitalVipTypes(vitalVipTypes);
  if (!normalizedTypes.length) return {};
  const placeholders = normalizedTypes.map(() => '?').join(', ');
  const expression = sqliteVitalVipTypeExpression('m');
  const statementName = `countMemberVitalVipRecords_${normalizedTypes.length}`;
  const statements = options.statements || prepareStatements(db);
  const statement = lazyStatement(db, statements._cache, statementName, `
    SELECT ${expression} AS value, COUNT(*) AS count
    FROM json_records m
    WHERE m.collection = ?
      AND ${expression} IN (${placeholders})
    GROUP BY ${expression}
  `);
  const rows = statement.all('members', ...normalizedTypes);
  const counts = Object.fromEntries(normalizedTypes.map((value) => [value, 0]));
  for (const row of rows) {
    const value = String(row?.value ?? '');
    if (!value) continue;
    counts[value] = Number(row?.count || 0);
  }
  return counts;
}

export function countSqliteCollectionRecordsWhereJsonFieldMissing(db, collection, field, options = {}) {
  const fieldKey = safeSqlIdentifier(field, 'SQLite JSON field');
  const additionalFieldKeys = (Array.isArray(options.additionalMissingFields) ? options.additionalMissingFields : [])
    .map((item) => safeSqlIdentifier(item, 'SQLite JSON field'))
    .filter(Boolean);
  const additionalAnyPresentFieldKeys = (Array.isArray(options.additionalAnyPresentFields) ? options.additionalAnyPresentFields : [])
    .map((item) => safeSqlIdentifier(item, 'SQLite JSON field'))
    .filter(Boolean);
  const statements = options.statements || prepareStatements(db);
  const missingCondition = (key) => `(
        json_type(payload_json, '$.${key}') IS NULL
        OR NULLIF(TRIM(CAST(json_extract(payload_json, '$.${key}') AS TEXT)), '') IS NULL
      )`;
  const presentCondition = (key) => `NULLIF(TRIM(CAST(json_extract(payload_json, '$.${key}') AS TEXT)), '') IS NOT NULL`;
  const conditions = ['collection = ?', missingCondition(fieldKey)];
  for (const key of additionalFieldKeys) conditions.push(missingCondition(key));
  if (additionalAnyPresentFieldKeys.length) {
    conditions.push(`(${additionalAnyPresentFieldKeys.map((key) => presentCondition(key)).join(' OR ')})`);
  }
  const statementName = `countCollectionRecordsWhereJsonFieldMissing_${[
    fieldKey,
    ...additionalFieldKeys,
    ...(additionalAnyPresentFieldKeys.length ? ['anypresent', ...additionalAnyPresentFieldKeys] : [])
  ].join('_')}`;
  const statement = lazyStatement(db, statements._cache, statementName, `
    SELECT COUNT(*) AS count
    FROM json_records
    WHERE ${conditions.join(' AND ')}
  `);
  const row = statement.get(String(collection));
  return Number(row?.count || 0);
}

export function deleteSqliteCollectionRecordsByJsonTimeRange(db, collection, field, range = {}, options = {}) {
  const fieldKey = safeSqlIdentifier(field, 'SQLite JSON field');
  const from = String(range.from || '');
  const to = String(range.to || '');
  if (!from && !to) return [];
  const statements = options.statements || prepareStatements(db);
  const conditions = ['collection = ?'];
  const args = [String(collection)];
  if (from) {
    conditions.push(`json_extract(payload_json, '$.${fieldKey}') >= ?`);
    args.push(from);
  }
  if (to) {
    conditions.push(`json_extract(payload_json, '$.${fieldKey}') ${range.toInclusive ? '<=' : '<'} ?`);
    args.push(to);
  }
  const statementName = `listCollectionRecordIdsByJsonTimeRange_${fieldKey}_${Boolean(from)}_${Boolean(to)}_${Boolean(range.toInclusive)}`;
  const statement = lazyStatement(db, statements._cache, statementName, `
    SELECT id
    FROM json_records
    WHERE ${conditions.join(' AND ')}
    ORDER BY json_extract(payload_json, '$.${fieldKey}') ASC, updated_at DESC, id ASC
  `);
  const rows = statement.all(...args);
  const deletedIds = [];
  for (const row of rows) {
    const id = String(row?.id || '');
    if (!id) continue;
    statements.deleteCollectionRecord.run(String(collection), id);
    deletedIds.push(id);
  }
  return deletedIds;
}

export function sqliteCollectionNames(db, options = {}) {
  const statements = options.statements || prepareStatements(db);
  return statements.listCollectionNames.all().map((row) => String(row.collection || '')).filter(Boolean);
}

export function sqliteCollectionRecordCounts(db, options = {}) {
  const statements = options.statements || prepareStatements(db);
  const rows = statements.countAllRecords.all();
  return Object.fromEntries(rows.map((row) => [row.collection, Number(row.count || 0)]));
}

export function sqliteScalarKeys(db, options = {}) {
  const statements = options.statements || prepareStatements(db);
  return statements.listScalarKeys.all().map((row) => String(row.key || '')).filter(Boolean);
}

export function sqliteJsonFieldIndexes(db, options = {}) {
  const expectedFields = expectedJsonFieldIndexes();
  const expectedNoCaseFields = expectedJsonNoCaseFieldIndexes();
  const expectedComposites = expectedJsonCompositeIndexes();
  const expected = [...expectedFields, ...expectedNoCaseFields, ...expectedComposites];
  const rows = db.prepare("PRAGMA index_list('json_records')").all();
  const existingNames = new Set(rows.map((row) => String(row.name || '')));
  const missingFields = expectedFields.filter((item) => !existingNames.has(item.name));
  const missingNoCaseFields = expectedNoCaseFields.filter((item) => !existingNames.has(item.name));
  const missingComposites = expectedComposites.filter((item) => !existingNames.has(item.name));
  const missing = [...missingFields, ...missingNoCaseFields, ...missingComposites];
  const businessUniqueConstraints = sqliteBusinessUniqueConstraintIndexCoverage(db);
  return {
    expected: expected.length,
    present: expected.length - missing.length,
    missing,
    fields: {
      expected: expectedFields.length,
      present: expectedFields.length - missingFields.length,
      missing: missingFields
    },
    composites: {
      expected: expectedComposites.length,
      present: expectedComposites.length - missingComposites.length,
      missing: missingComposites
    },
    nocase: {
      expected: expectedNoCaseFields.length,
      present: expectedNoCaseFields.length - missingNoCaseFields.length,
      missing: missingNoCaseFields
    },
    businessUniqueConstraints
  };
}

function sqliteBusinessUniqueConstraintIndexCoverage(db) {
  const states = sqliteIndexState(db);
  const constraints = expectedBusinessUniqueIndexes().map((descriptor) => {
    const state = states.get(descriptor.indexName);
    const unique = Boolean(state?.unique);
    const definitionMatches = Boolean(
      state && normalizeSqlDefinition(state.sql) === normalizeSqlDefinition(descriptor.sql)
    );
    const covered = unique && definitionMatches;
    return {
      collection: descriptor.collection,
      fields: descriptor.fields,
      scopeFields: descriptor.scopeFields || [],
      rule: descriptor.rule,
      indexName: descriptor.indexName,
      unique,
      definitionMatches,
      covered,
      candidates: [descriptor.indexName]
    };
  });
  const missing = constraints.filter((constraint) => !constraint.covered);
  return {
    expected: constraints.length,
    covered: constraints.length - missing.length,
    missing,
    constraints
  };
}

export function replaceSqliteCollectionRecords(db, collection, records, options = {}) {
  const collectionKey = String(collection);
  const items = Array.isArray(records) ? records : [];
  const updatedAt = options.updatedAt || nowIso();
  const statements = options.statements || prepareStatements(db);
  statements.upsertCollectionName.run(collectionKey, updatedAt);
  const existing = new Map(statements.listCollectionIds.all(collectionKey).map((row) => [
    String(row.id),
    {
      hash: String(row.hash || ''),
      position: Math.max(0, Number(row.position || 0))
    }
  ]));
  const preparedItems = items.map((item, index) => {
    const id = String(item?.id ?? item?.key ?? index);
    const payloadJson = stableJson(item);
    return {
      id,
      index,
      payloadJson,
      hash: payloadHash(payloadJson)
    };
  });
  const seen = new Set();
  const changed = new Set();
  let upserted = 0;
  let deleted = 0;
  let unchanged = 0;
  let repositioned = 0;

  for (const item of preparedItems) {
    seen.add(item.id);
    const previous = existing.get(item.id);
    if (previous && previous.hash !== item.hash) changed.add(item.id);
  }

  for (const id of existing.keys()) {
    if (!seen.has(id)) {
      statements.deleteCollectionRecord.run(collectionKey, id);
      deleted += 1;
    } else if (changed.has(id)) {
      statements.deleteCollectionRecord.run(collectionKey, id);
    }
  }

  preparedItems.forEach(({ id, index, payloadJson, hash }) => {
    const previous = existing.get(id);
    if (previous?.hash === hash) {
      if (previous.position !== index) {
        statements.upsertCollectionRecord.run(collectionKey, id, payloadJson, hash, index, updatedAt);
        repositioned += 1;
      } else {
        unchanged += 1;
      }
      return;
    }
    statements.upsertCollectionRecord.run(collectionKey, id, payloadJson, hash, index, updatedAt);
    upserted += 1;
  });

  return { upserted, deleted, unchanged, repositioned, total: items.length };
}

export function appendSqliteLog(db, log, options = {}) {
  const id = String(log?.id || `log_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  return upsertSqliteCollectionRecord(db, 'logs', id, { ...log, id }, options);
}
