import { DatabaseSync, backup } from 'node:sqlite';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { need, digest, noSymlinks } from '../candidate-host/config.js';
import { loadMigrationModules, migrationObservation, installMigrationDomains } from '../candidate-host/migrations.js';
import { VITAL_RUST_2X_SERVERS } from '../../vital-server-catalog.js';
import { planIdentityRetention, applyIdentityRetention, verifyRetainedBindings } from './retention.js';

export const PRODUCTION_MIGRATION_VERSION = 'nb-clan-v2-production/1';
const MARKER = 'v2ProductionMigration';
const ownedLeases = new WeakMap();
const UNREVIEWED_NOTIFICATION_WRITES = ['notifications.send', 'notifications.reconcile', 'notifications.mention_role', 'notifications.mention_everyone'];
const DEFERRED_PERMISSION_REASONS = new Set(['PERMISSION_EDITOR_REMAINS_ROOT_ONLY', 'NOTIFICATION_TARGET_AND_MENTION_MAPPING_REQUIRES_REVIEW', 'history.edit:UNMAPPED']);
function classifyIdentityReviews(plan) {
  const deferred = [], blocking = [];
  for (const conflict of plan?.conflicts || []) {
    const account = plan.accounts?.find(a => a.id === conflict.refs?.[0]);
    const reasons = conflict.kind === 'LEGACY_PERMISSION_REVIEW' ? conflict.refs.slice(1) : [];
    let safe = conflict.kind === 'WECHAT_LINK_REVIEW';
    if (conflict.kind === 'LEGACY_PERMISSION_REVIEW') {
      safe = Boolean(account && reasons.length && reasons.every(r => DEFERRED_PERMISSION_REASONS.has(r)));
      if (reasons.includes('PERMISSION_EDITOR_REMAINS_ROOT_ONLY')) safe &&= !account?.grants.some(g => g.effect === 'allow' && g.capability === 'system.permissions');
      if (reasons.includes('NOTIFICATION_TARGET_AND_MENTION_MAPPING_REQUIRES_REVIEW')) safe &&= !account?.grants.some(g => g.effect === 'allow' && UNREVIEWED_NOTIFICATION_WRITES.includes(g.capability));
    }
    (safe ? deferred : blocking).push({ conflictId: conflict.id, kind: conflict.kind, reasons,
      disposition: safe ? 'preserved_open_no_new_authority' : 'operator_resolution_required' });
  }
  return { deferred, blocking };
}
const observation = (db, options = {}) => migrationObservation(db, { maxRows: 1000000, maxBytes: 1024 * 1024 * 1024, ...options });
const LEGACY_COLLECTIONS = ['users', 'permissionRoles', 'members', 'squads', 'squadMembers', 'wechatUsers', 'wipes', 'wipeParticipants', 'wipeSettlements', 'syncJobs', 'syncAutoRules', 'operationRuns', 'integrationMessageRefs'];
// Project only inputs used by the imported migration engines. Logs/history remain
// untouched and are still covered by the full streaming observation digest.
function readLegacy(db, m) {
  const legacy = {};
  for (const collection of LEGACY_COLLECTIONS) {
    legacy[collection] = []; let bytes = 0;
    for (const row of db.prepare('SELECT payload_json FROM json_records WHERE collection=? ORDER BY position,id').iterate(collection)) {
      bytes += Buffer.byteLength(row.payload_json);
      need(legacy[collection].length < 100000 && bytes <= 128 * 1024 * 1024, 'PRODUCTION_MIGRATION_INPUT_TOO_LARGE', 422);
      legacy[collection].push(JSON.parse(row.payload_json));
    }
  }
  for (const key of ['settings', 'syncState', 'rustplusRelay']) legacy[key] = m.base.readSqliteScalar(db, key) || {};
  return legacy;
}
function syncMigrationPlan(m, legacy) {
  const { syncJobs = [], syncAutoRules = [], operationRuns = [] } = legacy;
  const plan = m.sync.planSyncCenterMigration({ syncJobs, syncAutoRules, operationRuns: operationRuns.slice(0, 1000) });
  for (let offset = 1000; offset < operationRuns.length; offset += 1000) {
    plan.runs.push(...m.sync.planSyncCenterMigration({ operationRuns: operationRuns.slice(offset, offset + 1000) }).runs);
  }
  plan.sourceHash = digest({ syncJobs, syncAutoRules, operationRuns });
  return plan;
}
export function productionConfig(input) {
  need(input && typeof input === 'object', 'PRODUCTION_CONFIG_REQUIRED', 422);
  const dataDirectory = input.dataDirectory, databaseFile = input.databaseFile || path.join(dataDirectory || '', 'nb-clan.sqlite');
  need(typeof dataDirectory === 'string' && path.isAbsolute(dataDirectory) && path.normalize(dataDirectory) === dataDirectory &&
    typeof databaseFile === 'string' && path.isAbsolute(databaseFile) && path.dirname(databaseFile) === dataDirectory,
    'PRODUCTION_PRIVATE_DATABASE_REQUIRED', 422);
  return { dataDirectory, databaseFile };
}
const controls = c => ({ directory: path.join(c.dataDirectory, '.v2-production'), owner: path.join(c.dataDirectory, '.v2-production/owner.json'), lock: path.join(c.dataDirectory, '.v2-production/operation.lock') });
async function privatePath(file, directory = false) {
  await noSymlinks(file); const s = await fs.stat(file);
  need((directory ? s.isDirectory() : s.isFile() && s.nlink === 1) && s.uid === process.getuid() && (s.mode & 0o077) === 0,
    'PRODUCTION_PRIVATE_PATH_REQUIRED', 409);
  return s;
}
async function checkDatabase(c) {
  await privatePath(c.dataDirectory, true); const stat = await privatePath(c.databaseFile);
  need(stat.size > 0 && stat.size <= 512 * 1024 * 1024, 'PRODUCTION_DATABASE_SIZE_LIMIT', 409);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { await privatePath(c.databaseFile + suffix); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return stat;
}
async function ownerFor(c, { create = false } = {}) {
  await checkDatabase(c); const p = controls(c);
  if (create) { try { await fs.mkdir(p.directory, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
  await privatePath(p.directory, true);
  if (create) {
    const owner = { kind: 'nb-clan-v2-production', version: 1, id: randomUUID(), createdAt: new Date().toISOString() };
    try { await fs.writeFile(p.owner, JSON.stringify(owner), { mode: 0o600, flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  const stat = await privatePath(p.owner); need(stat.size <= 4096, 'PRODUCTION_OWNER_INVALID', 409);
  const owner = JSON.parse(await fs.readFile(p.owner, 'utf8'));
  need(owner.kind === 'nb-clan-v2-production' && owner.version === 1 && /^[a-f0-9-]{36}$/.test(owner.id), 'PRODUCTION_OWNER_INVALID', 409);
  return owner;
}
async function fileHash(file) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
async function checkStopReceipt(c, receipt) {
  need(receipt && Number.isFinite(Date.parse(receipt.observedAt)) && Math.abs(Date.now() - Date.parse(receipt.observedAt)) <= 15 * 60 * 1000,
    'PRODUCTION_STOP_RECEIPT_REQUIRED', 409);
  if (receipt.kind === 'docker-stop') {
    // Host deployer must obtain this from docker inspect after docker stop. Container
    // PIDs cannot establish that a process in the host/another namespace has stopped.
    need(/^[a-f0-9]{12,64}$/.test(receipt.containerId || '') && typeof receipt.image === 'string' && receipt.image.length > 0 &&
      receipt.running === false && Number.isFinite(Date.parse(receipt.finishedAt)) && Date.parse(receipt.finishedAt) <= Date.parse(receipt.observedAt),
      'PRODUCTION_STOP_RECEIPT_INVALID', 409);
  } else if (receipt.kind === 'isolated-copy') {
    need(typeof receipt.sourcePath === 'string' && path.isAbsolute(receipt.sourcePath) && receipt.sourcePath !== c.databaseFile &&
      /^[a-f0-9]{64}$/.test(receipt.databaseSha256 || '') && await fileHash(c.databaseFile) === receipt.databaseSha256,
      'PRODUCTION_COPY_RECEIPT_INVALID', 409);
  } else if (receipt.kind === 'process-stop') {
    need(Array.isArray(receipt.pids) && receipt.pids.length > 0 && receipt.pids.every(p => Number.isSafeInteger(p) && p > 1), 'PRODUCTION_STOP_RECEIPT_INVALID', 409);
    for (const pid of receipt.pids) {
      let stopped = false; try { process.kill(pid, 0); } catch (e) { stopped = e.code === 'ESRCH'; }
      need(stopped, 'PRODUCTION_OLD_PROCESS_STILL_RUNNING', 409);
    }
  } else need(false, 'PRODUCTION_STOP_RECEIPT_INVALID', 409);
  return digest(receipt);
}
/** Shared across releases/modes. Never automatically steal a stale lease. A failed
 * runtime must close/drain SQLite before release; failed drain retains this fence. */
export async function acquireProductionLease(input, { mode = 'runtime', stopReceipt } = {}) {
  const c = productionConfig(input); need(['runtime', 'maintenance', 'plan'].includes(mode), 'PRODUCTION_LEASE_MODE_INVALID', 422);
  const owner = await ownerFor(c, { create: mode !== 'runtime' });
  const receiptDigest = mode === 'maintenance' ? await checkStopReceipt(c, stopReceipt) : null;
  const p = controls(c), token = randomUUID();
  try { await fs.writeFile(p.lock, JSON.stringify({ token, pid: process.pid, mode, ownerId: owner.id, databaseFile: c.databaseFile, receiptDigest, createdAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' }); }
  catch (e) { if (e.code === 'EEXIST') need(false, 'PRODUCTION_IN_USE', 409); throw e; }
  let released = false;
  const lease = { mode, ownerId: owner.id, receiptDigest, async release() {
    if (released) return; const stat = await privatePath(p.lock); need(stat.size <= 8192, 'PRODUCTION_LOCK_CHANGED', 409);
    need(JSON.parse(await fs.readFile(p.lock, 'utf8')).token === token, 'PRODUCTION_LOCK_CHANGED', 409);
    await fs.unlink(p.lock); released = true; ownedLeases.delete(lease);
  } };
  ownedLeases.set(lease, { c, token, receipt: stopReceipt }); return lease;
}
async function requireLease(c, lease, mode) {
  const state = ownedLeases.get(lease); need(state && lease.mode === mode && state.c.databaseFile === c.databaseFile, 'PRODUCTION_MAINTENANCE_LEASE_REQUIRED', 409);
  const file = controls(c).lock; const stat = await privatePath(file); need(stat.size <= 8192 && JSON.parse(await fs.readFile(file, 'utf8')).token === state.token, 'PRODUCTION_LOCK_CHANGED', 409);
}
async function identityEvidence(c, marker) {
  if (!marker?.planHash) return undefined;
  need(/^[a-f0-9]{64}$/.test(marker.planHash), 'PRODUCTION_IDENTITY_EVIDENCE_INVALID', 409);
  const file = path.join(controls(c).directory, `identity-plan-${marker.planHash}.json`);
  try { const stat = await privatePath(file); need(stat.size <= 20 * 1024 * 1024, 'PRODUCTION_IDENTITY_EVIDENCE_INVALID', 409);
    const p = JSON.parse(await fs.readFile(file, 'utf8')); need(digest(p) === marker.planHash, 'PRODUCTION_IDENTITY_EVIDENCE_INVALID', 409); return p;
  } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
}
async function makePlan(c, owner, db, m, plannedAt, adminExtrasCatalog, relayHistoryPolicy = 'require_mapping') {
  need(['require_mapping', 'preserve_unmapped'].includes(relayHistoryPolicy), 'PRODUCTION_RELAY_POLICY_INVALID', 422);
  const observed = observation(db), legacy = readLegacy(db, m);
  const marker = m.base.readSqliteScalar(db, 'v2IdentityMigration');
  const identityPlan = marker ? await identityEvidence(c, marker) : m.idPlan.planIdentityMigration(legacy, plannedAt);
  const schedulingPlan = m.base.readSqliteScalar(db, 'v2SchedulingMigration') ? null : m.schedulePlan.planSchedulingMigration(legacy, { now: plannedAt });
  const platformTable = db.prepare("SELECT 1 FROM sqlite_master WHERE name='platform_admin_records'").get();
  const platformCount = platformTable ? db.prepare("SELECT count(*) n FROM platform_admin_records WHERE kind='config'").get().n : 0;
  need(!platformCount || platformCount === 4, 'PRODUCTION_PLATFORM_MIGRATION_INCOMPLETE', 409);
  const platformPlan = platformCount ? null : m.platform.planPlatformMigration(legacy);
  const statsPlans = []; let after = '';
  do { const p = m.stats.migrateStats(db, { dryRun: true, after, limit: 100, now: Date.parse(plannedAt) }); statsPlans.push(p); after = p.nextCursor; } while (after);
  const memberPlan = m.member.migrateMemberAdmin(db, { apply: false, now: plannedAt });
  const syncPlan = syncMigrationPlan(m, legacy);
  const realtimePresent = db.prepare("SELECT 1 FROM sqlite_master WHERE name='v2_realtime_scopes'").get();
  const relayRepo = realtimePresent ? new (await import('../realtime/repository.js')).RealtimeRepository(db) : { db, scopes: () => [] };
  const relayPlan = m.relay.migrateLegacyRelay(relayRepo, legacy);
  const identityReview = classifyIdentityReviews(identityPlan);
  const relayHistory = { policy: relayHistoryPolicy, imported: relayPlan.unmapped.length === 0,
    originalScalarHash: digest(legacy.rustplusRelay), records: { servers: legacy.rustplusRelay.servers?.length || 0,
      chatMessages: legacy.rustplusRelay.chatMessages?.length || 0, inviteRecords: legacy.rustplusRelay.inviteRecords?.length || 0 },
    unmapped: relayPlan.unmapped.length, deferred: relayHistoryPolicy === 'preserve_unmapped' && relayPlan.unmapped.length > 0 };
  const grantPlan = marker ? m.grant.planGrantMigration(new m.identity.IdentityRepository(db), identityPlan ? { identityPlan } : {}) : null;
  const indexes = await import('../member-admin/repository.js');
  const body = { version: PRODUCTION_MIGRATION_VERSION, ownerId: owner.id, plannedAt, observation: observed,
    adminExtrasCatalog: adminExtrasCatalog ? (await import('../platform-admin-extras/model.js')).catalogEntries(adminExtrasCatalog) : null,
    identityPlan, identityAlreadyApplied: Boolean(marker), schedulingPlan, platformPlan, memberPlan, statsPlans, syncPlan, relayPlan, grantPlan,
    deferredReview: identityReview.deferred, relayHistory,
    performanceIndexes: { before: indexes.memberReadIndexCatalog(db), required: indexes.MEMBER_READ_INDEXES },
    review: { identityConflicts: identityPlan?.conflicts?.length || 0, identityBlockingConflicts: identityReview.blocking.length,
      identityDeferredReviews: identityReview.deferred.length, grantNeedsReview: grantPlan?.counts.needs_review || 0,
      memberConflicts: memberPlan.conflicts?.length || 0, relayUnmapped: relayPlan.unmapped.length, platformConflicts: platformPlan?.conflicts?.length || 0,
      statsConflicts: statsPlans.reduce((n, p) => n + p.conflicts.length, 0), syncConflicts: syncPlan.conflicts.length } };
  return { ...body, digest: digest(body) };
}
async function migrationPlan(c, owner, db, m, plannedAt, adminExtrasCatalog, { retentionMode, relayHistoryPolicy = 'require_mapping' } = {}) {
  need(retentionMode === undefined || retentionMode === 'identity_only', 'PRODUCTION_RETENTION_MODE_INVALID', 422);
  if (retentionMode !== 'identity_only') return makePlan(c, owner, db, m, plannedAt, adminExtrasCatalog, relayHistoryPolicy);
  const retention = planIdentityRetention(db), sourceObservation = observation(db);
  // Plan the exact destructive boundary on a disposable complete SQLite clone.
  // The authorized source remains read-only until a matching explicit apply.
  const directory = await fs.mkdtemp(path.join(controls(c).directory, 'retention-plan-'));
  let clone;
  try {
    const file = path.join(directory, 'database.sqlite'); await backup(db, file); await fs.chmod(file, 0o600);
    clone = new DatabaseSync(file); applyIdentityRetention(clone, retention);
    const { digest: ignored, ...body } = await makePlan(c, owner, clone, m, plannedAt, adminExtrasCatalog, 'require_mapping');
    const combined = { ...body, retentionMode, retention, sourceObservation };
    return { ...combined, digest: digest(combined) };
  } finally { clone?.close(); await fs.rm(directory, { recursive: true, force: true }); }
}
export async function planProductionMigration(input, { plannedAt = new Date().toISOString(), adminExtrasCatalog = VITAL_RUST_2X_SERVERS.map(s => ({ ...s, serverProfileId: s.id })), relayHistoryPolicy = 'require_mapping', retentionMode } = {}) {
  const c = productionConfig(input); need(Number.isFinite(Date.parse(plannedAt)) && new Date(plannedAt).toISOString() === plannedAt, 'PRODUCTION_TIME_INVALID', 422);
  const lease = await acquireProductionLease(c, { mode: 'plan' }); let db;
  try { const owner = await ownerFor(c), m = await loadMigrationModules(); db = new DatabaseSync(c.databaseFile, { readOnly: true }); db.exec('BEGIN');
    return await migrationPlan(c, owner, db, m, plannedAt, adminExtrasCatalog, { retentionMode, relayHistoryPolicy });
  } finally { if (db?.isTransaction) db.exec('ROLLBACK'); db?.close(); await lease.release(); }
}
async function validateDomains(c, db, m, marker, { migration = false } = {}) {
  need(marker?.version === PRODUCTION_MIGRATION_VERSION && marker.schemaInstalled === true && marker.performanceIndexesInstalled === true,
    'PRODUCTION_MIGRATION_REQUIRED', 503);
  need(/^[a-f0-9]{64}$/.test(marker.planDigest || '') && /^[a-f0-9]{64}$/.test(marker.identityPlanHash || ''), 'PRODUCTION_MARKER_INVALID', 503);
  need(!marker.grantNeedsReview && marker.identityBlockingConflicts === 0, 'PRODUCTION_PERMISSION_REVIEW_REQUIRED', 503);
  const identity = new m.identity.IdentityRepository(db);
  need(identity.scalar('v2IdentityMigration')?.planHash === marker.identityPlanHash && identity.scalar('v2IdentitySchemaVersion') === 1 && identity.scalar('v2SchedulingMigration'), 'PRODUCTION_IDENTITY_EVIDENCE_INVALID', 503);
  const evidence = await identityEvidence(c, identity.scalar('v2IdentityMigration'));
  need(evidence, 'PRODUCTION_IDENTITY_EVIDENCE_REQUIRED', 503);
  const reviews = classifyIdentityReviews(evidence);
  need(!reviews.blocking.length && digest(reviews.deferred) === digest(marker.deferredReview) && marker.identityConflicts === (evidence.conflicts?.length || 0), 'PRODUCTION_PERMISSION_REVIEW_REQUIRED', 503);
  if (migration) {
    const grants = m.grant.planGrantMigration(identity, { identityPlan: evidence });
    need(!grants.counts.needs_review && !grants.counts.update, 'PRODUCTION_GRANT_REVIEW_REQUIRED', 503);
  } else {
    // Explicit root permission changes are ordinary production state, not a
    // reason to replay the migration or make the next restart unavailable.
    const { validGrant } = await import('../identity/permissions.js');
    need(identity.all('accounts').every(a => Array.isArray(a.grants) && a.grants.every(validGrant)), 'PRODUCTION_GRANTS_INVALID', 503);
  }
  for (const name of ['v2_scheduling_clock', 'v2_notification_clock', 'v2_member_admin_meta', 'v2_stats_meta', 'sync_center_schema', 'v2_realtime_meta', 'platform_admin_records', 'v2_source_adapter_receipts', 'v2_source_windows', 'v2_system_meta', 'v2_source_admin_meta', 'v2_member_followup_schema', 'v2_member_followup_events', 'v2_member_followup_jobs']) {
    need(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name), 'PRODUCTION_SCHEMA_REQUIRED', 503);
  }
  const indexes = await import('../member-admin/repository.js'); need(indexes.memberReadIndexesReady(db), 'PRODUCTION_PERFORMANCE_INDEXES_REQUIRED', 503);
  const notificationRepo = new (await import('../notifications/repository.js')).NotificationRepository(db);
  notificationRepo.requireBusinessSchema(); notificationRepo.requireBusinessSchema('platformCard');
  new (await import('../hex-query/repository.js')).HexQueryRepository(notificationRepo);
  new (await import('../relay-admin/repository.js')).RelayAdminRepository(db);
  new (await import('../vip-notifications/repository.js')).VipNotificationRepository(notificationRepo);
  if (marker.adminExtrasInstalled) new (await import('../platform-admin-extras/repository.js')).ExtrasRepository(db);
  return { marker, performanceIndexes: indexes.memberReadIndexCatalog(db) };
}
export async function applyProductionMigration(input, plan, { expectedDigest, operatorId, maintenanceLease } = {}) {
  const c = productionConfig(input); await requireLease(c, maintenanceLease, 'maintenance'); await checkDatabase(c);
  const { digest: provided, ...body } = plan || {};
  need(plan?.version === PRODUCTION_MIGRATION_VERSION && provided && provided === expectedDigest && digest(body) === provided, 'PRODUCTION_PLAN_INVALID', 409);
  need(operatorId === 'user_root', 'PRODUCTION_TRUSTED_OPERATOR_REQUIRED', 403);
  const owner = await ownerFor(c); need(plan.ownerId === owner.id, 'PRODUCTION_PLAN_STALE', 409);
  const m = await loadMigrationModules(), db = new DatabaseSync(c.databaseFile);
  try {
    // EXCLUSIVE locking mode retains the database lock across the existing
    // installers' bounded transactions until this sole connection is closed.
    db.exec('PRAGMA busy_timeout=1000; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;');
    let legacy = readLegacy(db, m); const operator = legacy.users?.find(u => u.id === operatorId);
    need(operator && !operator.disabled && operator.status !== 'disabled', 'PRODUCTION_TRUSTED_OPERATOR_REQUIRED', 403);
    const completed = m.base.readSqliteScalar(db, MARKER);
    if (completed?.planDigest === provided) {
      need(completed.ownerId === owner.id && completed.appliedObservation === observation(db, { omitScalars: [MARKER] }), 'PRODUCTION_PLAN_STALE', 409);
      await validateDomains(c, db, m, completed, { migration: true }); return { ...completed, replayed: true };
    }
    const fresh = await migrationPlan(c, owner, db, m, plan.plannedAt, plan.adminExtrasCatalog, { retentionMode: plan.retentionMode, relayHistoryPolicy: plan.relayHistory?.policy });
    need(fresh.digest === provided, 'PRODUCTION_PLAN_STALE', 409);
    const blocking = ['identityBlockingConflicts', 'grantNeedsReview', 'memberConflicts', 'platformConflicts', 'statsConflicts'];
    need(blocking.every(key => !plan.review[key]), 'PRODUCTION_MIGRATION_REVIEW_REQUIRED', 409);
    need(!plan.review.relayUnmapped || plan.relayHistory?.policy === 'preserve_unmapped', 'PRODUCTION_RELAY_MAPPING_REQUIRED', 409);
    let retentionResult;
    if (plan.retentionMode === 'identity_only') { retentionResult = applyIdentityRetention(db, plan.retention); legacy = readLegacy(db, m); }
    // Historical sync aggregate conflicts remain paused/review-required; never
    // turn those incomplete outcomes into completed jobs or run old executors.
    m.identity.installIdentitySchema(db); const repo = new m.identity.IdentityRepository(db);
    if (!plan.identityAlreadyApplied) {
      const file = path.join(controls(c).directory, `identity-plan-${digest(plan.identityPlan)}.json`);
      try { await fs.writeFile(file, JSON.stringify(plan.identityPlan), { mode: 0o600, flag: 'wx' }); }
      catch (e) { if (e.code !== 'EEXIST') throw e; await privatePath(file); need(digest(JSON.parse(await fs.readFile(file, 'utf8'))) === digest(plan.identityPlan), 'PRODUCTION_IDENTITY_EVIDENCE_INVALID', 409); }
      m.idPlan.applyIdentityMigration(repo, plan.identityPlan);
    }
    m.scheduling.installSchedulingSchema(db);
    if (plan.schedulingPlan) m.schedulePlan.applySchedulingMigration(new m.scheduling.SchedulingRepository(db), plan.schedulingPlan);
    await installMigrationDomains(db, plan.adminExtrasCatalog);
    if (plan.platformPlan) m.platform.applyPlatformMigration({ db, plan: plan.platformPlan, actorId: operatorId });
    const member = m.member.migrateMemberAdmin(db, { apply: true, now: plan.plannedAt });
    for (let i = 0; i < plan.statsPlans.length; i++) m.stats.migrateStats(db, { dryRun: false, after: i ? plan.statsPlans[i - 1].nextCursor : '', limit: 100, now: Date.parse(plan.plannedAt) });
    const { IdentityService } = await import('../identity/service.js'), identity = new IdentityService(repo), actor = identity.actorForAccount(operatorId);
    const { SyncCenterService } = await import('../sync-center/service.js'), { createSqliteSyncAuthority } = await import('../sync-center/authority.js');
    const sync = await m.sync.applySyncCenterMigration(new SyncCenterService({ db, identity, authority: createSqliteSyncAuthority({ identity, serializeWrite: fn => fn() }) }), plan.syncPlan, { actor, legacyExecutorStopped: true });
    if (!plan.relayHistory.deferred) {
      const { RealtimeRepository } = await import('../realtime/repository.js'); let after = 0, sourceHash;
      do { const r = m.relay.migrateLegacyRelay(new RealtimeRepository(db), legacy, { dryRun: false, after, limit: 500, sourceHash }); after = r.next; sourceHash = r.sourceHash; } while (after !== null);
    }
    need(digest(m.base.readSqliteScalar(db, 'rustplusRelay') || {}) === plan.relayHistory.originalScalarHash, 'PRODUCTION_RELAY_HISTORY_CHANGED', 409);
    const grantPlan = plan.grantPlan || m.grant.planGrantMigration(repo, plan.identityPlan ? { identityPlan: plan.identityPlan } : {});
    need(!grantPlan.counts.needs_review, 'PRODUCTION_GRANT_REVIEW_REQUIRED', 409);
    const grants = m.grant.applyGrantMigration(repo, grantPlan, { identityPlan: plan.identityPlan, expectedDigest: grantPlan.digest, operatorId });
    const indexes = await import('../member-admin/repository.js'); indexes.installMemberReadIndexes(db);
    const result = { version: PRODUCTION_MIGRATION_VERSION, ownerId: owner.id, planDigest: provided, schemaInstalled: true, performanceIndexesInstalled: true,
      identityPlanHash: repo.scalar('v2IdentityMigration').planHash, grantPlanDigest: grantPlan.digest, grantNeedsReview: grantPlan.counts.needs_review,
      identityConflicts: plan.review.identityConflicts, identityBlockingConflicts: plan.review.identityBlockingConflicts,
      deferredReview: plan.deferredReview, relayHistory: plan.relayHistory, adminExtrasInstalled: Boolean(plan.adminExtrasCatalog), maintenanceReceiptDigest: maintenanceLease.receiptDigest,
      ...(retentionResult ? { retention: retentionResult } : {}),
      appliedAt: new Date().toISOString(), counts: { members: member.counts, syncJobs: sync.jobs, syncRules: sync.rules, grantChanged: grants.changedAccounts?.length || 0 },
      pendingHistoricalSyncReview: plan.review.syncConflicts };
    await validateDomains(c, db, m, result, { migration: true });
    if (plan.retentionMode === 'identity_only') verifyRetainedBindings(db, plan.retention);
    result.appliedObservation = observation(db, { omitScalars: [MARKER] });
    repo.setScalar(MARKER, result); return { ...result, replayed: false };
  } finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); }
}
/** Read-only startup gate. No schema installation, no root password generation,
 * no resetting existing users/settings, and no candidate marker masquerade. */
export async function validateProductionReady(input) {
  const c = productionConfig(input), owner = await ownerFor(c), m = await loadMigrationModules(), db = new DatabaseSync(c.databaseFile, { readOnly: true });
  try { db.exec('BEGIN'); const marker = m.base.readSqliteScalar(db, MARKER);
    need(marker?.ownerId === owner.id, 'PRODUCTION_MIGRATION_REQUIRED', 503);
    await validateDomains(c, db, m, marker); return marker;
  } finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); }
}
