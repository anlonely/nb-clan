import { openSqliteDatabase } from '../server/storage/sqlite.js';
import {
  ensureSqliteSchema,
  listSqliteCollectionRecords,
  SQLITE_BUSINESS_UNIQUE_CONSTRAINTS,
  sqliteCollectionNames,
  sqliteCollectionRecordCounts
} from '../server/storage/sqlite-migrate.js';
import {
  DISCORD_MAP_MESSAGE_REF_KIND,
  DISCORD_KOOK_BRIDGE_MESSAGE_REF_KIND,
  DISCORD_KOOK_BRIDGE_MESSAGE_REF_TARGET_TYPE,
  DISCORD_MEMBER_RANKING_MESSAGE_REF_KIND,
  DISCORD_MEMBER_REGISTRATION_MESSAGE_REF_KIND,
  DISCORD_MEMBER_REVIEW_MESSAGE_REF_KIND,
  DISCORD_MEMBER_REVIEW_MESSAGE_REF_TARGET_TYPE,
  DISCORD_TARGET_MESSAGE_REF_TARGET_TYPE,
  DISCORD_WIPE_ATTENDANCE_MESSAGE_REF_KIND,
  KOOK_MEMBER_RANKING_MESSAGE_REF_KIND,
  KOOK_TARGET_MESSAGE_REF_TARGET_TYPE,
  RUSTPLUS_RELAY_CHAT_FORWARD_MESSAGE_REF_KIND,
  RUSTPLUS_RELAY_CHAT_FORWARD_MESSAGE_REF_TARGET_TYPE,
  WECHAT_SUBSCRIBE_MESSAGE_REF_KIND,
  WECHAT_SUBSCRIBE_MESSAGE_REF_TARGET_TYPE
} from '../server/integration-message-refs.js';

const DEFAULT_SAMPLE_LIMIT = 10;
const ACTIVE_SYNC_JOB_STATUSES = new Set(['queued', 'running']);
const DISCORD_APPLICATION_ACTIVE_STATUSES = new Set(['pending', 'reviewing']);
const INTEGRATION_MESSAGE_REF_STATUSES = new Set(['active', 'missing', 'deleted', 'uneditable', 'delivered', 'failed', 'skipped', 'refused']);
const INTEGRATION_MESSAGE_REF_PLATFORM_KIND_TARGET_TYPES = new Set([
  ['discord', DISCORD_MEMBER_REVIEW_MESSAGE_REF_KIND, DISCORD_MEMBER_REVIEW_MESSAGE_REF_TARGET_TYPE].join('|'),
  ['discord', DISCORD_WIPE_ATTENDANCE_MESSAGE_REF_KIND, 'wipe'].join('|'),
  ['discord', DISCORD_MEMBER_REGISTRATION_MESSAGE_REF_KIND, DISCORD_TARGET_MESSAGE_REF_TARGET_TYPE].join('|'),
  ['discord', DISCORD_MEMBER_RANKING_MESSAGE_REF_KIND, DISCORD_TARGET_MESSAGE_REF_TARGET_TYPE].join('|'),
  ['discord', DISCORD_MAP_MESSAGE_REF_KIND, DISCORD_TARGET_MESSAGE_REF_TARGET_TYPE].join('|'),
  ['discord', DISCORD_KOOK_BRIDGE_MESSAGE_REF_KIND, DISCORD_KOOK_BRIDGE_MESSAGE_REF_TARGET_TYPE].join('|'),
  ['kook', DISCORD_KOOK_BRIDGE_MESSAGE_REF_KIND, DISCORD_KOOK_BRIDGE_MESSAGE_REF_TARGET_TYPE].join('|'),
  ['discord', RUSTPLUS_RELAY_CHAT_FORWARD_MESSAGE_REF_KIND, RUSTPLUS_RELAY_CHAT_FORWARD_MESSAGE_REF_TARGET_TYPE].join('|'),
  ['kook', RUSTPLUS_RELAY_CHAT_FORWARD_MESSAGE_REF_KIND, RUSTPLUS_RELAY_CHAT_FORWARD_MESSAGE_REF_TARGET_TYPE].join('|'),
  ['kook', KOOK_MEMBER_RANKING_MESSAGE_REF_KIND, KOOK_TARGET_MESSAGE_REF_TARGET_TYPE].join('|'),
  ['wechat', WECHAT_SUBSCRIBE_MESSAGE_REF_KIND, WECHAT_SUBSCRIBE_MESSAGE_REF_TARGET_TYPE].join('|')
]);
const SINGLETON_INTEGRATION_MESSAGE_REF_TYPES = new Set([
  ['discord', DISCORD_MEMBER_REVIEW_MESSAGE_REF_KIND, DISCORD_MEMBER_REVIEW_MESSAGE_REF_TARGET_TYPE].join('|'),
  ['discord', DISCORD_WIPE_ATTENDANCE_MESSAGE_REF_KIND, 'wipe'].join('|'),
  ['discord', DISCORD_MEMBER_REGISTRATION_MESSAGE_REF_KIND, DISCORD_TARGET_MESSAGE_REF_TARGET_TYPE].join('|'),
  ['discord', DISCORD_MEMBER_RANKING_MESSAGE_REF_KIND, DISCORD_TARGET_MESSAGE_REF_TARGET_TYPE].join('|'),
  ['discord', DISCORD_MAP_MESSAGE_REF_KIND, DISCORD_TARGET_MESSAGE_REF_TARGET_TYPE].join('|'),
  ['kook', KOOK_MEMBER_RANKING_MESSAGE_REF_KIND, KOOK_TARGET_MESSAGE_REF_TARGET_TYPE].join('|')
]);
const OPERATION_RUN_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'skipped', 'cancelled']);
const OPERATION_RUN_ACTIVE_STATUSES = new Set(['queued', 'running']);
const OPERATION_RUN_PLATFORMS = new Set(['discord', 'kook', 'wechat', 'rustplus', 'battlemetrics', 'steam', 'system']);
const OPERATION_RUN_SOURCES = new Set(['manual', 'auto', 'interaction', 'system']);
const INTEGRATION_EVENT_STATUSES = new Set(['received', 'queued', 'processing', 'processed', 'failed', 'duplicate', 'skipped']);
const INTEGRATION_EVENT_PLATFORMS = new Set(['discord', 'kook', 'rustplus', 'wechat', 'system']);
const INTEGRATION_MESSAGE_REF_REQUIRED_FIELDS = [
  'platform',
  'kind',
  'targetType',
  'targetId',
  'channelId',
  'messageId',
  'status'
];
const INTEGRITY_COLLECTIONS = [
  'members',
  'squads',
  'squadMembers',
  'wipes',
  'wipeParticipants',
  'kdaRows',
  'memberProfiles',
  'wipeSettlements',
  'wechatUsers',
  'wechatSessions',
  'discordMemberApplications',
  'syncJobs',
  'operationRuns',
  'integrationEvents',
  'integrationMessageRefs'
];

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function normalizeText(value, maxLength = 240) {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, maxLength);
}

function recordId(record = {}, index = 0) {
  return normalizeText(record.id || record.key || `#${index}`, 160);
}

function getField(record = {}, field = '') {
  return String(field || '')
    .split('.')
    .filter(Boolean)
    .reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), record);
}

function duplicateGroups(records = [], keyForRecord, sampleLimit = DEFAULT_SAMPLE_LIMIT) {
  const groups = new Map();
  records.forEach((record, index) => {
    const key = normalizeText(keyForRecord(record, index), 500);
    if (!key) return;
    if (!groups.has(key)) groups.set(key, { value: key, count: 0, ids: [] });
    const group = groups.get(key);
    group.count += 1;
    if (group.ids.length < sampleLimit) group.ids.push(recordId(record, index));
  });
  return [...groups.values()].filter((group) => group.count > 1);
}

function addIssue(target, { rule, collection, message, groups = [], items = [] }, sampleLimit) {
  const issue = {
    rule,
    collection,
    message
  };
  if (groups.length) {
    issue.groups = groups.slice(0, sampleLimit).map((group) => ({
      value: group.value,
      count: group.count,
      ids: group.ids.slice(0, sampleLimit)
    }));
    issue.totalGroups = groups.length;
    issue.totalRecords = groups.reduce((total, group) => total + group.count, 0);
  }
  if (items.length) {
    issue.items = items.slice(0, sampleLimit);
    issue.totalItems = items.length;
  }
  target.push(issue);
}

function requireUniqueField(result, collections, collection, field, options = {}) {
  const records = (collections[collection] || []).filter((record) => (
    !options.where || options.where(record)
  ));
  const groups = duplicateGroups(records, (record) => normalizeText(getField(record, field), 500), result.sampleLimit);
  if (!groups.length) return;
  addIssue(result.errors, {
    rule: `${collection}.${field}.unique`,
    collection,
    message: `${collection}.${field} must be unique when present.`,
    groups
  }, result.sampleLimit);
}

function requireUniqueComposite(result, collections, collection, fields, options = {}) {
  const records = (collections[collection] || []).filter((record) => (
    !options.where || options.where(record)
  ));
  const groups = duplicateGroups(records, (record) => {
    const values = fields.map((field) => normalizeText(getField(record, field), 500));
    if (values.some((value) => !value)) return '';
    return values.join('|');
  }, result.sampleLimit);
  if (!groups.length) return;
  addIssue(result.errors, {
    rule: `${collection}.${fields.join('_')}.unique`,
    collection,
    message: `${collection}.${fields.join('+')} must be unique when all fields are present.`,
    groups
  }, result.sampleLimit);
}

function requireCatalogUniqueConstraints(result, collections) {
  for (const constraint of SQLITE_BUSINESS_UNIQUE_CONSTRAINTS) {
    if (constraint.integrity === 'custom') continue;
    const fields = constraint.fields || [];
    if (fields.length === 1) {
      requireUniqueField(result, collections, constraint.collection, fields[0]);
    } else if (fields.length > 1) {
      requireUniqueComposite(result, collections, constraint.collection, fields);
    }
  }
}

function requireUniqueKdaRows(result, collections) {
  const groups = duplicateGroups(collections.kdaRows || [], (row) => {
    const wipeId = normalizeText(row.wipeId, 120);
    if (!wipeId) return '';
    const memberId = normalizeText(row.memberId, 120);
    if (memberId) return `${wipeId}|member:${memberId}`;
    const steamId = normalizeText(row.steamId, 40);
    return steamId ? `${wipeId}|steam:${steamId}` : '';
  }, result.sampleLimit);
  if (!groups.length) return;
  addIssue(result.errors, {
    rule: 'kdaRows.wipe_member.unique',
    collection: 'kdaRows',
    message: 'kdaRows must have at most one row per wipe and member identity.',
    groups
  }, result.sampleLimit);
}

function syncJobGroupKey(job = {}) {
  return [
    normalizeText(job.type, 80) || 'custom',
    normalizeText(job.scope, 80) || 'custom',
    normalizeText(job.targetWipeId, 120) || '-',
    normalizeText(job.targetServerId, 120) || '-'
  ].join('|');
}

function requireNoActiveSyncJobDuplicates(result, collections) {
  const activeJobs = (collections.syncJobs || []).filter((job) => (
    ACTIVE_SYNC_JOB_STATUSES.has(normalizeText(job.status, 40))
  ));
  const groups = duplicateGroups(activeJobs, syncJobGroupKey, result.sampleLimit);
  if (!groups.length) return;
  addIssue(result.errors, {
    rule: 'syncJobs.active.duplicate',
    collection: 'syncJobs',
    message: 'Active sync jobs must not duplicate the same type, scope, wipe, and server.',
    groups
  }, result.sampleLimit);
}

function operationRunGroupKey(run = {}) {
  return [
    normalizeText(run.platform, 40) || 'system',
    normalizeText(run.type, 120) || 'operation',
    normalizeText(run.dedupeKey, 240)
  ].join('|');
}

function requireOperationRunIntegrity(result, collections) {
  const missingItems = [];
  const invalidStatusItems = [];
  const invalidPlatformItems = [];
  const invalidSourceItems = [];
  (collections.operationRuns || []).forEach((run, index) => {
    const missingFields = ['type', 'platform', 'source', 'status', 'createdAt', 'updatedAt']
      .filter((field) => !normalizeText(run[field], 240));
    if (missingFields.length) {
      missingItems.push({
        id: recordId(run, index),
        missingFields
      });
    }
    const status = normalizeText(run.status, 40);
    if (status && !OPERATION_RUN_STATUSES.has(status)) {
      invalidStatusItems.push({
        id: recordId(run, index),
        status
      });
    }
    const platform = normalizeText(run.platform, 40);
    if (platform && !OPERATION_RUN_PLATFORMS.has(platform)) {
      invalidPlatformItems.push({
        id: recordId(run, index),
        platform
      });
    }
    const source = normalizeText(run.source, 40);
    if (source && !OPERATION_RUN_SOURCES.has(source)) {
      invalidSourceItems.push({
        id: recordId(run, index),
        source
      });
    }
  });
  addMissingReferenceIssue(
    result,
    'errors',
    'operationRuns',
    'operationRuns.required_fields',
    'Operation runs must include type, platform, source, status, createdAt, and updatedAt fields.',
    missingItems
  );
  addMissingReferenceIssue(
    result,
    'errors',
    'operationRuns',
    'operationRuns.status.valid',
    'Operation runs must use a known lifecycle status.',
    invalidStatusItems
  );
  addMissingReferenceIssue(
    result,
    'errors',
    'operationRuns',
    'operationRuns.platform.valid',
    'Operation runs must use a known platform.',
    invalidPlatformItems
  );
  addMissingReferenceIssue(
    result,
    'errors',
    'operationRuns',
    'operationRuns.source.valid',
    'Operation runs must use a known source.',
    invalidSourceItems
  );
}

function requireNoActiveOperationRunDuplicates(result, collections) {
  const activeRunsWithDedupe = (collections.operationRuns || []).filter((run) => (
    OPERATION_RUN_ACTIVE_STATUSES.has(normalizeText(run.status, 40)) &&
    normalizeText(run.dedupeKey, 240)
  ));
  const groups = duplicateGroups(activeRunsWithDedupe, operationRunGroupKey, result.sampleLimit);
  if (!groups.length) return;
  addIssue(result.errors, {
    rule: 'operationRuns.active.dedupeKey.duplicate',
    collection: 'operationRuns',
    message: 'Active operation runs must not duplicate the same platform, type, and dedupeKey.',
    groups
  }, result.sampleLimit);
}

function integrationEventGroupKey(event = {}) {
  return [
    normalizeText(event.platform, 40) || 'system',
    normalizeText(event.eventType, 120) || 'event',
    normalizeText(event.dedupeKey, 240)
  ].join('|');
}

function requireIntegrationEventIntegrity(result, collections) {
  const missingItems = [];
  const invalidStatusItems = [];
  const invalidPlatformItems = [];
  (collections.integrationEvents || []).forEach((event, index) => {
    const missingFields = ['platform', 'eventType', 'status', 'receivedAt', 'createdAt', 'updatedAt']
      .filter((field) => !normalizeText(event[field], 240));
    if (missingFields.length) {
      missingItems.push({
        id: recordId(event, index),
        missingFields
      });
    }
    const status = normalizeText(event.status, 40);
    if (status && !INTEGRATION_EVENT_STATUSES.has(status)) {
      invalidStatusItems.push({
        id: recordId(event, index),
        status
      });
    }
    const platform = normalizeText(event.platform, 40);
    if (platform && !INTEGRATION_EVENT_PLATFORMS.has(platform)) {
      invalidPlatformItems.push({
        id: recordId(event, index),
        platform
      });
    }
  });
  addMissingReferenceIssue(
    result,
    'errors',
    'integrationEvents',
    'integrationEvents.required_fields',
    'Integration events must include platform, eventType, status, receivedAt, createdAt, and updatedAt fields.',
    missingItems
  );
  addMissingReferenceIssue(
    result,
    'errors',
    'integrationEvents',
    'integrationEvents.status.valid',
    'Integration events must use a known lifecycle status.',
    invalidStatusItems
  );
  addMissingReferenceIssue(
    result,
    'errors',
    'integrationEvents',
    'integrationEvents.platform.valid',
    'Integration events must use a known platform.',
    invalidPlatformItems
  );
}

function requireNoIntegrationEventDedupeConflicts(result, collections) {
  const originalEventsWithDedupe = (collections.integrationEvents || []).filter((event) => (
    normalizeText(event.dedupeKey, 240) &&
    normalizeText(event.status, 40) !== 'duplicate'
  ));
  const groups = duplicateGroups(originalEventsWithDedupe, integrationEventGroupKey, result.sampleLimit);
  if (!groups.length) return;
  addIssue(result.errors, {
    rule: 'integrationEvents.dedupeKey.original.unique',
    collection: 'integrationEvents',
    message: 'Integration events with the same platform, eventType, and dedupeKey must have only one non-duplicate record.',
    groups
  }, result.sampleLimit);
}

function addMissingReferenceIssue(result, severity, collection, rule, message, items) {
  if (!items.length) return;
  addIssue(result[severity], {
    rule,
    collection,
    message,
    items
  }, result.sampleLimit);
}

function requireLiveMemberReferences(result, collections) {
  const liveWipeIds = new Set((collections.wipes || [])
    .filter((wipe) => normalizeText(wipe.status, 40) !== 'closed')
    .map((wipe) => normalizeText(wipe.id, 120))
    .filter(Boolean));
  if (!liveWipeIds.size) return;

  const memberIds = new Set((collections.members || []).map((member) => normalizeText(member.id, 120)).filter(Boolean));
  const memberSteamIds = new Set((collections.members || []).map((member) => normalizeText(member.steamId, 40)).filter(Boolean));
  const missingParticipants = [];
  const missingKdaRows = [];

  (collections.wipeParticipants || []).forEach((participant, index) => {
    const wipeId = normalizeText(participant.wipeId, 120);
    if (!liveWipeIds.has(wipeId)) return;
    const memberId = normalizeText(participant.memberId, 120);
    const steamId = normalizeText(participant.steamId || participant.member?.steamId, 40);
    const found = memberId ? memberIds.has(memberId) : (steamId && memberSteamIds.has(steamId));
    if (found) return;
    missingParticipants.push({
      id: recordId(participant, index),
      wipeId,
      memberId,
      steamId
    });
  });

  (collections.kdaRows || []).forEach((row, index) => {
    const wipeId = normalizeText(row.wipeId, 120);
    if (!liveWipeIds.has(wipeId)) return;
    const memberId = normalizeText(row.memberId, 120);
    const steamId = normalizeText(row.steamId || row.member?.steamId, 40);
    const found = memberId ? memberIds.has(memberId) : (steamId && memberSteamIds.has(steamId));
    if (found) return;
    missingKdaRows.push({
      id: recordId(row, index),
      wipeId,
      memberId,
      steamId
    });
  });

  addMissingReferenceIssue(
    result,
    'errors',
    'wipeParticipants',
    'wipeParticipants.live.member.exists',
    'Live wipe participants must reference a current member by memberId or steamId.',
    missingParticipants
  );
  addMissingReferenceIssue(
    result,
    'errors',
    'kdaRows',
    'kdaRows.live.member.exists',
    'Live wipe KDA rows must reference a current member by memberId or steamId.',
    missingKdaRows
  );
}

function warnBrokenSquadReferences(result, collections) {
  const memberIds = new Set((collections.members || []).map((member) => normalizeText(member.id, 120)).filter(Boolean));
  const activeSquadIds = new Set((collections.squads || [])
    .filter((squad) => !normalizeText(squad.archivedAt, 80))
    .map((squad) => normalizeText(squad.id, 120))
    .filter(Boolean));
  const items = [];
  (collections.squadMembers || []).forEach((item, index) => {
    const memberId = normalizeText(item.memberId, 120);
    const squadId = normalizeText(item.squadId, 120);
    if (memberIds.has(memberId) && activeSquadIds.has(squadId)) return;
    items.push({
      id: recordId(item, index),
      memberId,
      squadId,
      missingMember: Boolean(memberId && !memberIds.has(memberId)),
      missingOrArchivedSquad: Boolean(squadId && !activeSquadIds.has(squadId))
    });
  });
  addMissingReferenceIssue(
    result,
    'warnings',
    'squadMembers',
    'squadMembers.references.current',
    'Squad memberships should reference current members and active squads.',
    items
  );
}

function warnDiscordApplicationDuplicates(result, collections) {
  const activeApplications = (collections.discordMemberApplications || []).filter((application) => (
    DISCORD_APPLICATION_ACTIVE_STATUSES.has(normalizeText(application.status, 40))
  ));
  for (const field of ['discordUserId', 'steamId', 'memberId']) {
    const groups = duplicateGroups(activeApplications, (record) => normalizeText(record[field], 120), result.sampleLimit);
    if (!groups.length) continue;
    addIssue(result.warnings, {
      rule: `discordMemberApplications.active.${field}.duplicate`,
      collection: 'discordMemberApplications',
      message: `Active Discord member applications have duplicate ${field} values.`,
      groups
    }, result.sampleLimit);
  }
}

function requireIntegrationMessageRefIntegrity(result, collections) {
  const missingItems = [];
  const invalidStatusItems = [];
  const invalidPlatformKindTargetItems = [];
  (collections.integrationMessageRefs || []).forEach((ref, index) => {
    const missingFields = INTEGRATION_MESSAGE_REF_REQUIRED_FIELDS
      .filter((field) => !normalizeText(ref[field], 200));
    if (missingFields.length) {
      missingItems.push({
        id: recordId(ref, index),
        missingFields
      });
    }
    const status = normalizeText(ref.status, 40);
    if (status && !INTEGRATION_MESSAGE_REF_STATUSES.has(status)) {
      invalidStatusItems.push({
        id: recordId(ref, index),
        status
      });
    }
    const platform = normalizeText(ref.platform, 40);
    const kind = normalizeText(ref.kind, 120);
    const targetType = normalizeText(ref.targetType, 120);
    if (platform && kind && targetType && !INTEGRATION_MESSAGE_REF_PLATFORM_KIND_TARGET_TYPES.has([platform, kind, targetType].join('|'))) {
      invalidPlatformKindTargetItems.push({
        id: recordId(ref, index),
        platform,
        kind,
        targetType
      });
    }
  });
  addMissingReferenceIssue(
    result,
    'errors',
    'integrationMessageRefs',
    'integrationMessageRefs.required_fields',
    'Integration message references must include platform, kind, target, channel, message, and status fields.',
    missingItems
  );
  addMissingReferenceIssue(
    result,
    'errors',
    'integrationMessageRefs',
    'integrationMessageRefs.status.valid',
    'Integration message references must use a known lifecycle status.',
    invalidStatusItems
  );
  addMissingReferenceIssue(
    result,
    'errors',
    'integrationMessageRefs',
    'integrationMessageRefs.platform_kind_targetType.valid',
    'Integration message references must use a known platform, kind, and targetType combination.',
    invalidPlatformKindTargetItems
  );
}

function warnIntegrationMessageRefDuplicates(result, collections) {
  const activeRefs = (collections.integrationMessageRefs || []).filter((ref) => normalizeText(ref.status, 40) === 'active');
  const exactGroups = duplicateGroups(activeRefs, (ref) => [
    normalizeText(ref.platform, 40),
    normalizeText(ref.kind, 120),
    normalizeText(ref.targetType, 120),
    normalizeText(ref.targetId, 160),
    normalizeText(ref.channelId, 120),
    normalizeText(ref.messageId, 120)
  ].join('|'), result.sampleLimit);
  if (exactGroups.length) {
    addIssue(result.errors, {
      rule: 'integrationMessageRefs.active.message.unique',
      collection: 'integrationMessageRefs',
      message: 'Active integration message references must be unique for platform, kind, target, channel, and message.',
      groups: exactGroups
    }, result.sampleLimit);
  }

  const singletonRefs = activeRefs.filter((ref) => SINGLETON_INTEGRATION_MESSAGE_REF_TYPES.has([
    normalizeText(ref.platform, 40),
    normalizeText(ref.kind, 120),
    normalizeText(ref.targetType, 120)
  ].join('|')));
  const targetChannelGroups = duplicateGroups(singletonRefs, (ref) => [
    normalizeText(ref.platform, 40),
    normalizeText(ref.kind, 120),
    normalizeText(ref.targetType, 120),
    normalizeText(ref.targetId, 160),
    normalizeText(ref.channelId, 120)
  ].join('|'), result.sampleLimit);
  const duplicates = targetChannelGroups.filter((group) => group.count > 1);
  if (duplicates.length) {
    addIssue(result.warnings, {
      rule: 'integrationMessageRefs.active.target_channel.duplicate',
      collection: 'integrationMessageRefs',
      message: 'A target has multiple active message references in the same channel; this can indicate duplicate cards.',
      groups: duplicates
    }, result.sampleLimit);
  }
}

function loadIntegrityCollections(db) {
  const collections = {};
  for (const collection of INTEGRITY_COLLECTIONS) {
    collections[collection] = listSqliteCollectionRecords(db, collection, { limit: 0 });
  }
  return collections;
}

function checkBusinessInvariants(db, options = {}) {
  const result = {
    ok: true,
    sampleLimit: Math.max(1, Math.min(50, Number(options.sampleLimit || DEFAULT_SAMPLE_LIMIT))),
    collectionsChecked: INTEGRITY_COLLECTIONS,
    errors: [],
    warnings: []
  };
  const collections = loadIntegrityCollections(db);

  requireCatalogUniqueConstraints(result, collections);
  requireUniqueKdaRows(result, collections);
  requireNoActiveSyncJobDuplicates(result, collections);
  requireOperationRunIntegrity(result, collections);
  requireNoActiveOperationRunDuplicates(result, collections);
  requireIntegrationEventIntegrity(result, collections);
  requireNoIntegrationEventDedupeConflicts(result, collections);
  requireLiveMemberReferences(result, collections);
  warnBrokenSquadReferences(result, collections);
  warnDiscordApplicationDuplicates(result, collections);
  requireIntegrationMessageRefIntegrity(result, collections);
  warnIntegrationMessageRefDuplicates(result, collections);

  result.ok = result.errors.length === 0;
  delete result.sampleLimit;
  return result;
}

const args = parseArgs(process.argv.slice(2));
const sqlite = args.sqlite || args.target || 'data/nb-clan.sqlite';
process.env.NB_SQLITE_FILE = sqlite;
process.env.NB_STORAGE_MODE = process.env.NB_STORAGE_MODE || 'dual';

const db = await openSqliteDatabase(sqlite);
let schemaEnsureError = '';
try {
  ensureSqliteSchema(db);
} catch (error) {
  schemaEnsureError = String(error?.message || error);
}
const integrity = db.prepare('PRAGMA integrity_check').all().map((row) => Object.values(row)[0]);
const quick = db.prepare('PRAGMA quick_check').all().map((row) => Object.values(row)[0]);
const wal = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').all();
const counts = sqliteCollectionRecordCounts(db);
const collections = sqliteCollectionNames(db);
const invariants = checkBusinessInvariants(db, { sampleLimit: args['max-samples'] || DEFAULT_SAMPLE_LIMIT });
const physicalOk = integrity.length === 1 && integrity[0] === 'ok' && quick.length === 1 && quick[0] === 'ok';
const ok = physicalOk && invariants.ok && !schemaEnsureError;

console.log(JSON.stringify({
  ok,
  sqlite,
  physicalOk,
  schemaEnsureError,
  integrity,
  quick,
  wal,
  counts,
  collections,
  invariants
}, null, 2));

if (!ok) process.exit(1);
