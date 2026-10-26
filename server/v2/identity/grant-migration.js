import { randomUUID } from 'node:crypto';
import { PERMISSION_MODULES, roleExists, rolePermissions } from '../../permissions.js';
import { digest } from './contexts.js';
import { legacyFingerprint } from './migration.js';
import { CAPABILITIES, grant, allScope, migrateLegacyGrants, validGrant } from './permissions.js';
import { requireValue } from './errors.js';

// Frozen pre-G07 formulas: provenance must also match the original plan hash.
const historicalModuleMap = {
  members: ['members.read', 'members.basic_edit'], departedMembers: ['members.read', 'members.change_status'],
  riskAlerts: ['risks.read', 'risks.manage'], squads: ['squads.read', 'squads.manage'],
  server: ['wipes.read', 'wipes.edit'], kda: ['stats.read'], history: ['stats.read'],
  rustTools: ['relay.read'], rustClanInfo: ['relay.read'], rustClanChat: ['relay.chat_read'],
  query: ['queries.read', 'queries.run'], officialKda: ['stats.read', 'queries.run'],
  inventoryDetails: ['inventory.read', 'inventory.query'], sync: ['sync.read', 'sync.run'],
  discordBot: ['platforms.read', 'platforms.configure'], kookBot: ['platforms.read', 'platforms.configure'],
  discordKookSync: ['platforms.read', 'platforms.configure'], wechatMini: ['platforms.read', 'members.review'],
  logs: [null, 'system.logs'], users: [null, 'system.accounts'], permissions: [null, 'system.permissions'],
  system: [null, 'system.brand'], api: [null, 'system.api_keys']
};

function historicalGrants(user, store) {
  const review = [];
  if (user.id === 'user_root' || user.username === 'root') return { grants: CAPABILITIES.map(cap => grant(cap, allScope, { source: 'legacy_root' })), review };
  if (!roleExists(user.role, store.permissionRoles)) return { grants: [], review: ['UNKNOWN_ROLE'] };
  if (user.role === 'admin') return { grants: CAPABILITIES.filter(cap => cap !== 'system.permissions').map(cap => grant(cap, allScope, { source: 'legacy_admin' })),
    review: ['PERMISSION_EDITOR_REMAINS_ROOT_ONLY'] };
  const permissions = rolePermissions(user.role, store.permissionRoles);
  const led = (store.squads || []).filter(s => !s.archivedAt && (s.leaderUserIds || [s.leaderUserId]).includes(user.id)).map(s => s.id);
  const grants = [];
  for (const { id } of PERMISSION_MODULES) {
    const cell = permissions[id] || {};
    const [read, edit] = historicalModuleMap[id] || [];
    const platformScope = { type: 'platformTargets', ids: [{ discordBot: 'discord', kookBot: 'kook', discordKookSync: 'discord_kook_bridge', wechatMini: 'wechat' }[id]] };
    if (read && (cell.view || cell.edit)) grants.push(grant(read, read === 'platforms.read' ? platformScope : allScope, { source: 'legacy_compatibility', pendingReview: true }));
    // Legacy /kda/export accepts KDA/history view and applies the same visible-data scope.
    if (['kda', 'history'].includes(id) && (cell.view || cell.edit)) {
      grants.push(grant('stats.export', allScope, { source: 'legacy_compatibility', pendingReview: true }));
    }
    if (!read && (cell.view || cell.edit)) review.push(`${id}.view:UNMAPPED`);
    if (!cell.edit || user.role === 'viewer' && !['query', 'officialKda', 'inventoryDetails'].includes(id)) continue;
    if (edit === 'members.basic_edit' || edit === 'members.change_status' || edit === 'members.review') {
      // Old member writes also had hard role checks; module edit alone is insufficient.
      if (user.role === 'member_manager') grants.push(grant(edit, allScope, { source: 'legacy_effective' }));
      else review.push(`${id}.edit:HARD_ROLE_GUARD`);
    } else if (['squads.manage', 'wipes.edit'].includes(edit)) {
      review.push(`${id}.edit:HARD_ROLE_GUARD`);
    } else if (edit === 'system.permissions') review.push('permissions.edit:ROOT_ONLY');
    else if (edit) {
      grants.push(grant(edit, edit === 'platforms.configure' ? platformScope : allScope, { source: 'legacy_effective' }));
      // A migrated official-query runner also needs the matching read capability.
      if (id === 'officialKda') grants.push(grant('queries.read', allScope, { source: 'legacy_effective' }));
      if (id === 'system') review.push('system.edit:ADDITIONAL_ACTIONS_REQUIRE_REVIEW');
    }
    else review.push(`${id}.edit:UNMAPPED`);
  }
  if (user.role === 'leader') {
    for (const cap of ['members.basic_edit', 'squads.manage', 'signups.delegate']) {
      if (led.length) grants.push(grant(cap, { type: 'squads', ids: led }, { source: 'legacy_leader' }));
    }
    review.push('UNASSIGNED_MEMBER_EDIT_REMOVED');
  }
  return { grants, review };
}


export const GRANT_MIGRATION_VERSION = '2026-09-08.1';
export const GRANT_MIGRATION_MARKER = 'v2GrantMigration';
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const hash = value => digest(canonical(value));
const clone = value => JSON.parse(JSON.stringify(value));
function transaction(repo, fn) {
  if (!repo.db.isTransaction) return repo.transaction(fn);
  // IdentityRepository itself always starts BEGIN IMMEDIATE. Nest only this
  // maintenance operation in a savepoint so the existing owner retains commit.
  const name = `grant_migration_${randomUUID().replaceAll('-', '')}`;
  repo.db.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    repo.db.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    repo.db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    repo.db.exec(`RELEASE SAVEPOINT ${name}`);
    throw error;
  }
}
const list = (repo, collection) => repo.db.prepare('SELECT payload_json FROM json_records WHERE collection=? ORDER BY id')
  .all(collection).map(row => JSON.parse(row.payload_json));
function inputs(repo) {
  const store = Object.fromEntries(['users', 'permissionRoles', 'squads', 'wipes'].map(key => [key, repo.all(key)]));
  store.wipeParticipants = list(repo, 'wipeParticipants');
  store.wipeSettlements = list(repo, 'wipeSettlements');
  return { store, accounts: repo.all('accounts'), marker: repo.scalar('v2IdentityMigration'),
    ledger: repo.scalar(GRANT_MIGRATION_MARKER),
    permissionEdits: repo.all('audits').filter(a => a.action === 'permissions_changed') };
}
function historicalVersion(baseline, user, store) {
  // The immediately preceding G07 formula over-granted four notification
  // capabilities to admins. Recognize only its exact original-plan-proven form;
  // never infer ownership from source labels or rewrite explicit account edits.
  if (user.role === 'admin' && user.id !== 'user_root' && user.username !== 'root') {
    const current = migrateLegacyGrants(user, store).grants;
    const oldAdmin = [...current.filter(g => g.source === 'legacy_admin'),
      ...['notifications.send', 'notifications.reconcile', 'notifications.mention_role', 'notifications.mention_everyone']
        .map(cap => grant(cap, allScope, { source: 'legacy_admin' }))]
      .sort((a, b) => CAPABILITIES.indexOf(a.capability) - CAPABILITIES.indexOf(b.capability));
    if (hash([...oldAdmin, ...current.filter(g => g.source !== 'legacy_admin')]) === hash(baseline.grants))
      return 'g07-unreviewed-notification-targets';
  }
  const latest = historicalGrants(user, store).grants;
  // Both repairs were independently delivered in G07. Require an exact known
  // formula, never infer ownership from caller-writable source labels alone.
  for (const exports of [true, false]) for (const officialRead of [true, false]) {
    const candidate = latest.filter(g => (exports || g.capability !== 'stats.export' || g.source !== 'legacy_compatibility') &&
      (officialRead || g.capability !== 'queries.read' || g.source !== 'legacy_effective'));
    if (hash(candidate) === hash(baseline.grants)) return `g03-exports-${Number(exports)}-official-read-${Number(officialRead)}`;
  }
  return null;
}
function difference(before, after) {
  const remaining = [...before];
  const added = after.filter(g => {
    const index = remaining.findIndex(old => hash(old) === hash(g));
    if (index < 0) return true;
    remaining.splice(index, 1); return false;
  });
  return { added, removed: remaining };
}
function buildPlan(repo, { identityPlan } = {}) {
  const input = inputs(repo);
  requireValue(input.marker?.version === 1 && typeof input.marker.planHash === 'string', 'IDENTITY_MIGRATION_REQUIRED', 503);
  requireValue(!input.ledger || input.ledger.version === GRANT_MIGRATION_VERSION, 'GRANT_MIGRATION_VERSION_CONFLICT', 409);
  let evidenceHash = null;
  if (identityPlan !== undefined) {
    evidenceHash = digest(JSON.stringify(identityPlan));
    requireValue(evidenceHash === input.marker.planHash && Array.isArray(identityPlan?.accounts), 'GRANT_MIGRATION_EVIDENCE_INVALID', 422);
    requireValue(new Set(identityPlan.accounts.map(a => a.id)).size === identityPlan.accounts.length, 'GRANT_MIGRATION_EVIDENCE_INVALID', 422);
  }
  const accounts = input.accounts.map(account => {
    const before = { hash: hash(account), grantsHash: hash(account.grants), permissionVersion: account.permissionVersion, revision: account.revision };
    const row = { accountId: account.id, before, status: 'needs_review', reasons: [], review: [], added: [], removed: [], afterGrants: null };
    const stop = reason => ({ ...row, reasons: [reason] });
    if (!account.legacyUserId) return { ...stop('NOT_A_LEGACY_ACCOUNT'), status: 'not_applicable' };
    const user = input.store.users.find(u => u.id === account.legacyUserId);
    if (!user || account.id !== user.id || account.roleId !== user.role) return stop('LEGACY_ACCOUNT_MISMATCH');
    if (account.legacyFingerprint !== legacyFingerprint(user, input.store.permissionRoles)) return stop('LEGACY_POLICY_OR_IDENTITY_CHANGED');
    const target = migrateLegacyGrants(user, input.store);
    row.review = target.review;
    if (!Array.isArray(account.grants) || !account.grants.every(validGrant)) return stop('INVALID_EXISTING_GRANTS');
    if (hash(account.grants) === hash(target.grants)) return { ...row, status: 'already_current' };
    if (input.ledger?.accounts && Object.hasOwn(input.ledger.accounts, account.id)) return stop('ALREADY_MIGRATED_ACCOUNT_CHANGED');
    if (!evidenceHash) return stop('ORIGINAL_IDENTITY_PLAN_REQUIRED');
    const baseline = identityPlan.accounts.find(a => a.id === account.id);
    if (!baseline || baseline.legacyUserId !== account.legacyUserId) return stop('ORIGINAL_ACCOUNT_BASELINE_MISSING');
    if (account.legacyFingerprint !== legacyFingerprint(user, input.store.permissionRoles) ||
        baseline.legacyFingerprint !== account.legacyFingerprint) return stop('LEGACY_POLICY_OR_IDENTITY_CHANGED');
    if (input.permissionEdits.some(a => a.targetAccountId === account.id)) return stop('EXPLICIT_PERMISSION_EDIT_RECORDED');
    if (account.permissionVersion !== 1 || account.revision !== 1 || baseline.permissionVersion !== 1 || baseline.revision !== 1)
      return stop('ACCOUNT_VERSION_CHANGED');
    if (hash(account) !== hash(baseline)) return stop('EXPLICIT_OR_UNPROVEN_ACCOUNT_DIFFERENCE');
    const version = historicalVersion(baseline, user, input.store);
    if (!version) return stop('UNKNOWN_HISTORICAL_GRANT_FORMULA');
    if (!target.grants.every(validGrant)) return stop('INVALID_TARGET_GRANTS');
    return { ...row, status: 'update', sourceVersion: version, afterGrants: target.grants,
      ...difference(account.grants, target.grants) };
  });
  const plan = { version: GRANT_MIGRATION_VERSION, evidenceHash,
    observations: { hash: hash(input), accounts: input.accounts.length, legacyPlanHash: input.marker.planHash },
    accounts, counts: Object.fromEntries(['update', 'already_current', 'needs_review', 'not_applicable'].map(status =>
      [status, accounts.filter(a => a.status === status).length])) };
  return { ...plan, digest: hash(plan) };
}

/** Read-only and deterministic. No schema installation, session issuance, GET hook or startup hook. */
export function planGrantMigration(repo, options = {}) {
  return transaction(repo, () => clone(buildPlan(repo, options)));
}

/** Explicit maintenance command, not an HTTP authorization boundary. The host
 * must authenticate its trusted root/operator before entering its SQLite write
 * queue. operatorId is the audit label, never proof of that authorization.
 * Publish returned durable events only AFTER the outer transaction commits.
 */
export function applyGrantMigration(repo, plan, { identityPlan, expectedDigest, operatorId, now = Date.now } = {}) {
  requireValue(typeof operatorId === 'string' && operatorId.trim().length > 0 && operatorId.length <= 160, 'GRANT_MIGRATION_OPERATOR_REQUIRED', 422);
  requireValue(plan?.version === GRANT_MIGRATION_VERSION && typeof expectedDigest === 'string' && expectedDigest === plan.digest,
    'GRANT_MIGRATION_PLAN_REQUIRED', 422);
  const { digest: suppliedDigest, ...body } = plan;
  requireValue(hash(body) === suppliedDigest, 'GRANT_MIGRATION_PLAN_TAMPERED', 409);
  return transaction(repo, () => {
    const ledger = repo.scalar(GRANT_MIGRATION_MARKER);
    requireValue(!ledger || ledger.version === GRANT_MIGRATION_VERSION, 'GRANT_MIGRATION_VERSION_CONFLICT', 409);
    const receipt = ledger?.receipts?.[suppliedDigest];
    if (receipt) return { ...clone(receipt), replayed: true, events: [] };
    const current = buildPlan(repo, { identityPlan });
    requireValue(current.digest === suppliedDigest, 'GRANT_MIGRATION_PLAN_STALE', 409);
    const updates = current.accounts.filter(a => a.status === 'update');
    if (!updates.length) return { version: GRANT_MIGRATION_VERSION, planDigest: suppliedDigest,
      changedAccounts: [], counts: current.counts, replayed: false, noWrite: true, events: [] };
    const appliedAt = new Date(now()).toISOString(), events = [], migrated = Object.create(null);
    const miniSessions = Boolean(repo.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='platform_admin_records'").get());
    for (const row of updates) {
      const account = repo.get('accounts', row.accountId);
      requireValue(hash(account) === row.before.hash, 'GRANT_MIGRATION_PLAN_STALE', 409);
      const updated = { ...account, grants: row.afterGrants, permissionVersion: account.permissionVersion + 1, revision: account.revision + 1 };
      repo.put('accounts', updated);
      for (const session of repo.all('sessions').filter(s => s.accountId === row.accountId)) repo.remove('sessions', session.id);
      if (miniSessions) repo.db.prepare("DELETE FROM platform_admin_records WHERE kind='mini-session' AND json_extract(payload,'$.accountId')=?").run(row.accountId);
      const event = { id: `event_${randomUUID()}`, accountId: row.accountId, reason: 'permissions_changed',
        migrationVersion: GRANT_MIGRATION_VERSION, planDigest: suppliedDigest, permissionVersion: updated.permissionVersion, createdAt: appliedAt };
      repo.put('events', event); events.push(event);
      repo.put('audits', { id: `audit_${randomUUID()}`, action: 'grants_migrated', accountId: operatorId,
        targetAccountId: row.accountId, migrationVersion: GRANT_MIGRATION_VERSION, planDigest: suppliedDigest,
        beforeHash: row.before.hash, afterHash: hash(updated), createdAt: appliedAt });
      migrated[row.accountId] = { beforeHash: row.before.hash, afterHash: hash(updated),
        sourceVersion: row.sourceVersion, permissionVersion: updated.permissionVersion, revision: updated.revision, planDigest: suppliedDigest };
    }
    const result = { version: GRANT_MIGRATION_VERSION, planDigest: suppliedDigest, appliedAt,
      changedAccounts: updates.map(a => a.accountId), counts: current.counts, eventIds: events.map(e => e.id), noWrite: false };
    repo.setScalar(GRANT_MIGRATION_MARKER, { version: GRANT_MIGRATION_VERSION,
      accounts: { ...ledger?.accounts, ...migrated }, receipts: { ...ledger?.receipts, [suppliedDigest]: result } });
    return { ...result, replayed: false, events };
  });
}
