import { applyRiskScan } from './risk.js';
import { SyncCenterRepository } from '../../sync-center/repository.js';
import { applyDiscordAudit } from './discord-membership.js';
import { reconcileMemberRoleDeparture } from '../../identity/departure-lock.js';
import { randomUUID } from 'node:crypto';
import { authorize } from '../../identity/permissions.js';
import { upsertSqliteCollectionRecord, deleteSqliteCollectionRecord } from '../../../storage/sqlite-migrate.js';
import { collections as identityCollections } from '../../identity/repository.js';
import { applyRoleMappings } from '../../identity/role-mappings.js';
import { StatsService } from '../../stats/service.js';
import { hash, need, stamp } from '../../stats/model.js';
import { TYPES, hash as scopeHash } from '../../sync-center/model.js';
import { createSqliteSyncAuthority } from '../../sync-center/authority.js';
import { contextFor } from './collectors.js';
import { selectVitalWipeForStats } from './vital-wipe-binding.js';

export function installSourceAdapterSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS v2_source_adapter_receipts (
    actor_id TEXT NOT NULL, operation_id TEXT NOT NULL, command_hash TEXT NOT NULL,
    result TEXT NOT NULL, PRIMARY KEY(actor_id,operation_id));
    CREATE TABLE IF NOT EXISTS v2_source_adapter_cache (
    collection TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(collection,id));`);
}
export function createSourceAuthority({ identity, runWrite, patchCache, authorizeStatsWrite, readSourceConfig: hostSourceConfig, captureSourceWindow, now = Date.now, staleAfterMs = 3600000 }) {
  const db = identity.repo.db;
  need(typeof runWrite === 'function' && typeof patchCache === 'function', 'SOURCE_WRITER_REQUIRED', 503);
  const get = (collection, id) => { const r = db.prepare('SELECT payload_json FROM json_records WHERE collection=? AND id=?').get(collection, id); return r ? JSON.parse(r.payload_json) : null; };
  const readSourceConfig = args => {
    if (!['discord_membership_audit','member_profile'].includes(args.type)) return hostSourceConfig?.(args);
    const memberships = args.member ? db.prepare("SELECT payload_json FROM json_records WHERE collection='squadMembers' AND json_extract(payload_json,'$.memberId')=? AND COALESCE(json_extract(payload_json,'$.validTo'),'')='' ORDER BY id LIMIT 501").all(args.member.id).map(r => JSON.parse(r.payload_json)) : [];
    const explicitRiskWipe = args.scope?.wipeId || (args.scope?.kind === 'current_wipe' ? args.scope.id : null);
    const riskWipes = args.type === 'member_profile' && explicitRiskWipe ? [get('v2Wipes', explicitRiskWipe)].filter(Boolean) : args.type === 'member_profile' ? db.prepare("SELECT payload_json FROM json_records WHERE collection='v2Wipes' AND json_extract(payload_json,'$.lifecycle') IN ('active','scheduled') ORDER BY id LIMIT 2").all().map(r => JSON.parse(r.payload_json)) : [];
    return hostSourceConfig?.({ ...args, memberships, riskWipes, ...(args.type === 'member_profile' && args.member ? { profile: profile(args.member) } : {}) });
  };
  const find = (collection, key, id) => db.prepare(`SELECT payload_json FROM json_records WHERE collection=? AND json_extract(payload_json,'$.${key}')=? LIMIT 3`).all(collection, id).map(r => JSON.parse(r.payload_json));
  const profile = member => {
    const rows = find('memberProfiles', 'memberId', member.id);
    need(rows.length <= 1, 'SOURCE_PROFILE_CONFLICT', 409);
    if (rows.length) return rows[0];
    const bySteam = find('memberProfiles', 'steamId', member.steamId);
    need(bySteam.length <= 1 && (!bySteam[0]?.memberId || bySteam[0].memberId === member.id), 'SOURCE_PROFILE_CONFLICT', 409);
    return bySteam[0] || null;
  };
  const statsRow = (wipeId, memberId) => {
    const rows = db.prepare("SELECT payload_json FROM json_records WHERE collection='kdaRows' AND json_extract(payload_json,'$.wipeId')=? AND json_extract(payload_json,'$.memberId')=? LIMIT 2").all(wipeId, memberId);
    need(rows.length <= 1, 'SOURCE_STATS_CONFLICT', 409);
    return rows.length ? JSON.parse(rows[0].payload_json) : null;
  };
  const trigger = operationId => {
    const jobId = operationId.match(/^sync-item:([^:]+):/)?.[1];
    const job = jobId && db.prepare("SELECT payload FROM sync_center_records WHERE kind='job' AND id=?").get(jobId);
    need(job, 'SOURCE_JOB_REQUIRED', 503);
    return JSON.parse(job.payload).trigger;
  };
  let writing = false;
  const sync = value => { need(!value?.then, 'SYNC_ADAPTER_ATOMICITY_REQUIRED', 503); return value; };
  function put(collection, row) {
    need(writing && db.isTransaction, 'SOURCE_TRANSACTION_REQUIRED', 503);
    upsertSqliteCollectionRecord(db, collection, row.id, row);
    db.prepare('INSERT OR IGNORE INTO v2_source_adapter_cache VALUES(?,?)').run(collection, row.id);
  }
  function bindVitalWipe({ actor, expectedWipe, binding }) {
    need(writing && db.isTransaction, 'SOURCE_TRANSACTION_REQUIRED', 503);
    const fresh = identity.actorForAccount(actor.id), resource = { kind: 'wipe', id: expectedWipe.id };
    need(fresh.status === 'active' && !fresh.restricted && fresh.permissionVersion === actor.permissionVersion, 'ACCESS_DENIED', 403);
    authorize(fresh, 'sync.run', resource, identity.relations());
    need(authorizeStatsWrite?.(fresh, 'stats.sync', resource) === true, 'STATS_WRITE_NOT_GRANTED', 403);
    const current = get('v2Wipes', expectedWipe.id);
    need(current && ['scheduled', 'active'].includes(current.lifecycle), 'WIPE_IMMUTABLE', 409);
    const config = sync(readSourceConfig({ type: 'kda', scope: { kind: 'current_wipe', id: current.id, wipeId: current.id } }));
    need(config?.sourceId === 'vital' && config.serverId === current.serverProfileId &&
      config.providerServerId === binding.providerServerId, 'VITAL_WIPE_CONTEXT_CHANGED', 409);
    selectVitalWipeForStats(expectedWipe, binding.providerServerId,
      [{ id: binding.providerWipeId, gameServerId: binding.providerServerId, startTime: binding.startTime }], now());
    const next = { ...expectedWipe, revision: expectedWipe.revision + 1,
      serverSnapshot: { ...expectedWipe.serverSnapshot, vitalWipeId: binding.providerWipeId, vitalWipeStartedAt: binding.startTime } };
    // Concurrent identical preparations may join the same job; unrelated edits never do.
    const withoutUpdatedAt = row => { const { updatedAt, ...rest } = row; return rest; };
    if (hash(withoutUpdatedAt(current)) === hash(withoutUpdatedAt(next))) return current;
    need(hash(current) === hash(expectedWipe) && !config.providerWipeId, 'VITAL_WIPE_CONTEXT_CHANGED', 409);
    next.updatedAt = new Date(now()).toISOString();
    put('v2Wipes', next);
    return next;
  }
  const roleRepo = {
    db, get: (name, id) => identity.repo.get(name, id), all: name => identity.repo.all(name),
    put: (name, row) => name === 'accounts' ? identity.repo.put(name, row) :
      ['members', 'squadMembers'].includes(name) ? put(identityCollections[name], row) : need(false, 'INVALID_DATA'),
    remove: (name, id) => {
      need(name === 'squadMembers' && writing && db.isTransaction, 'SOURCE_TRANSACTION_REQUIRED', 503);
      deleteSqliteCollectionRecord(db, identityCollections[name], id);
      db.prepare('INSERT OR IGNORE INTO v2_source_adapter_cache VALUES(?,?)').run(identityCollections[name], id);
    }
  };
  const flushCache = async () => {
    const rows = db.prepare('SELECT collection,id FROM v2_source_adapter_cache ORDER BY collection,id LIMIT 1001').all();
    need(rows.length <= 1000, 'SOURCE_CACHE_BACKLOG', 503);
    if (!rows.length) return;
    await patchCache(rows.map(r => ({ ...r, record: get(r.collection, r.id) })));
    for (const r of rows) db.prepare('DELETE FROM v2_source_adapter_cache WHERE collection=? AND id=?').run(r.collection, r.id);
  };
  const serializeWrite = fn => runWrite(async () => {
    await flushCache();
    let result;
    try { writing = true; result = sync(fn()); } finally { writing = false; }
    await flushCache();
    return result;
  });
  // StatsService validates authorization, context, source revisions and records its own receipt.
  // This private instance NEVER enters another queue or commits outside the caller's transaction.
  const ingestService = new StatsService(identity, { now, authorizeWrite: authorizeStatsWrite, writeCurrent: apply => {
    need(writing && db.isTransaction, 'SOURCE_TRANSACTION_REQUIRED', 503);
    const result = sync(apply());
    if (!result.replayed) for (const row of result.upserts || []) {
      put('kdaRows', row);
      put('kdaSnapshots', { ...row, id: `${row.id}:${row.sourceId}:${row.sourceRevision}` });
    }
    return result;
  }});
  function current(actor, memberId, scope = {}) {
    const fresh = identity.actorForAccount(actor.id);
    need(fresh.status === 'active' && !fresh.restricted && fresh.permissionVersion === actor.permissionVersion, 'ACCESS_DENIED', 403);
    const wipeId = scope.wipeId || (scope.kind === 'current_wipe' ? scope.id : null);
    authorize(fresh, 'sync.run', { kind: 'member', id: memberId, wipeId }, identity.relations());
    const member = get('members', memberId); need(member, 'RESOURCE_NOT_FOUND', 404);
    if (wipeId) {
      const wipe = get('v2Wipes', wipeId); need(wipe, 'RESOURCE_NOT_FOUND', 404);
      const squads = identity.relations().squadMembers.filter(s => s.memberId === memberId && !s.validTo).map(s => s.squadId);
      need(wipe.audience?.allMembers === true || wipe.audience?.memberIds?.includes(memberId) || wipe.audience?.squadIds?.some(id => squads.includes(id)) || wipe.audience?.includeUnassigned && !squads.length, 'SYNC_SCOPE_MISMATCH', 403);
    }
    return member;
  }
  function receipt(args, command, apply) {
    need(writing && db.isTransaction && typeof args.assertCurrent === 'function', 'SOURCE_TRANSACTION_REQUIRED', 503);
    args.assertCurrent(); current(args.actor, args.memberId, args.scope);
    need(typeof args.operationId === 'string' && args.operationId.length >= 8 && args.operationId.length <= 180, 'OPERATION_ID_REQUIRED');
    const digest = hash(command), prior = db.prepare('SELECT * FROM v2_source_adapter_receipts WHERE actor_id=? AND operation_id=?').get(args.actor.id, args.operationId);
    if (prior) { need(prior.command_hash === digest, 'IDEMPOTENCY_CONFLICT', 409); return { ...JSON.parse(prior.result), replayed: true }; }
    const result = { operationReceipt: { operationId: args.operationId, committedAt: new Date(now()).toISOString() }, ...sync(apply()), replayed: false };
    db.prepare('INSERT INTO v2_source_adapter_receipts VALUES(?,?,?,?)').run(args.actor.id, args.operationId, digest, JSON.stringify(result));
    return result;
  }
  function uniqueMapping(member, id) {
    need(/^\d{1,30}$/.test(id), 'INVALID_DATA');
    const owner = db.prepare(`SELECT 1 FROM json_records WHERE
      (collection='members' AND id<>? AND json_extract(payload_json,'$.battlemetricsId')=?) OR
      (collection='memberProfiles' AND COALESCE(json_extract(payload_json,'$.memberId'),'')<>? AND json_extract(payload_json,'$.battlemetricsPlayerId')=?) LIMIT 1`).get(member.id, id, member.id, id);
    need(!owner, 'IDENTITY_CONFLICT', 409);
  }
  function setMapping(member, p, mapping, manual, observedAt) {
    uniqueMapping(member, mapping.battlemetricsId);
    const oldId = member.battlemetricsId || p.battlemetricsPlayerId;
    member.battlemetricsId = mapping.battlemetricsId;
    p.battlemetricsPlayerId = mapping.battlemetricsId;
    p.battlemetricsMatchConfidence = manual ? 'manual' : mapping.confidence;
    p.battlemetricsMappingObservedAt = observedAt;
    if (oldId && oldId !== mapping.battlemetricsId) {
      // An old player's hours remain in historical rows; they cannot be relabelled as the new player.
      for (const key of Object.keys(p)) if (/^battlemetrics(Server|Weekly|Total|Wipe|Range|Last|Session|Synced)/.test(key)) p[key] = null;
    }
  }
  function saveMember(member) {
    put('members', { ...member, revision: (member.revision || 1) + 1, updatedAt: new Date(now()).toISOString() });
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='v2_member_admin_meta'").get()) db.prepare('UPDATE v2_member_admin_meta SET revision=revision+1 WHERE id=1').run();
  }
  function reconcileDeparture(memberId) {
    const account = identity.repo.all('accounts').find(row => row.memberId === memberId);
    const wasLocked = Boolean(account?.roleAccessLock);
    const result = reconcileMemberRoleDeparture(identity, memberId);
    if (account && wasLocked !== Boolean(identity.repo.get('accounts', account.id)?.roleAccessLock)) {
      const mark = db.prepare('INSERT OR IGNORE INTO v2_source_adapter_cache VALUES(?,?)');
      if (account.legacyUserId) mark.run('users', account.legacyUserId);
      for (const row of identity.repo.all('wechatUsers').filter(row => row.memberId === memberId)) mark.run('wechatUsers', row.id);
    }
    return result;
  }
  const applyResult = args => receipt(args, [args.type, args.scope, args.memberId, args.result], () => {
    if (['discord_membership_audit', 'kook_member_sync'].includes(args.type) || args.type === 'battlemetrics_playtime' && captureSourceWindow) {
      const match = args.operationId.match(/^sync-item:([^:]+):(.+)$/);
      const row = match && db.prepare("SELECT payload FROM sync_center_records WHERE kind='job' AND id=?").get(match[1]);
      const job = row && JSON.parse(row.payload);
      need(job && job.type === args.type && (['discord_membership_audit', 'kook_member_sync'].includes(args.type) || match[1] === args.scope.sourceWindowId) && match[2] === args.memberId && job.actorId === args.actor.id &&
        job.items.some(item => item.memberId === args.memberId) && hash(job.scope) === hash(args.scope), 'SOURCE_WINDOW_JOB_MISMATCH', 409);
    }
    const { type, result: r } = args, member = current(args.actor, args.memberId, args.scope), oldProfile = ['discord_membership_audit', 'kook_member_sync'].includes(type) ? null : profile(member);
    const before = { member: structuredClone(member), profile: oldProfile };
    need(Object.hasOwn(TYPES, type) && r && hash(member) === r.memberHash && hash(oldProfile || {}) === r.profileHash && r.steamId === member.steamId, 'REVISION_CONFLICT', 409);
    need(stamp(r.observedAt) && Date.parse(r.observedAt) <= now() + 60000, 'INVALID_DATA');
    const config = type === 'local_consistency' ? {} : sync(readSourceConfig?.({ type, scope: args.scope, member }));
    if (args.scope.sourceContexts) need(hash(args.scope.sourceContexts[member.id]) === hash(r.context), 'SOURCE_CONTEXT_CHANGED', 409);
    need(config && config.enabled !== false && hash(contextFor(config)) === hash(r.context), 'SOURCE_CONTEXT_CHANGED', 409);
    const previousEvidence = type === 'discord_membership_audit' ? member.discordMembershipObservation : type === 'kook_member_sync' ? member.kookRoleSync : oldProfile?.sourceObservations?.[type];
    need(!previousEvidence || Date.parse(r.observedAt) >= Date.parse(previousEvidence.observedAt), 'STALE_SOURCE_REVISION', 409);
    if (type === 'discord_membership_audit') {
      need(r.auditScopeHash === hash(args.scope), 'SYNC_SCOPE_MISMATCH', 409);
      authorize(args.actor, 'members.change_status', { kind: 'member', id: member.id }, identity.relations());
      applyDiscordAudit(member, r.audit, config, r.observedAt);
      member.discordMembershipObservation = { context: r.context, observedAt: r.observedAt, receivedAt: new Date(now()).toISOString(), revision: (previousEvidence?.revision || 0) + 1, quality: r.audit.status === 'check_failed' ? 'unknown' : 'complete' };
      if (r.audit.error === 'DISCORD_RATE_LIMITED') {
        // Persist the upstream cooldown in the existing source window, in this same commit.
        const syncRepo = new SyncCenterRepository(db), source = syncRepo.get('source', 'discord');
        need(source && Number.isFinite(r.audit.retryAfterMs), 'INVALID_DATA');
        source.nextAllowedAt = Math.max(source.nextAllowedAt || 0, now() + Math.min(3600000, Math.max(1000, r.audit.retryAfterMs)));
        source.updatedAt = now(); syncRepo.put('source', source);
      }
      saveMember(member);
      upsertSqliteCollectionRecord(db, 'v2CommunityRoleAudits', `${member.id}:discord`, {
        id: `${member.id}:discord`, memberId: member.id, provider: 'discord', externalId: config.discordId,
        guildId: config.guildId, policyRevision: config.policyRevision, matchMode: config.matchMode,
        expectedRoleIds: config.expectedRoleIds, actualRoleIds: r.audit.actualRoleIds,
        status: r.audit.status, error: member.discordMembershipError, checkedAt: r.observedAt
      });
      reconcileDeparture(member.id);
      return { memberId: member.id, type, status: r.audit.status, quality: member.discordMembershipObservation.quality,
        memberRevision: get('members', member.id).revision, beforeHash: hash(before.member), afterHash: hash(get('members', member.id)) };
    }
    if (type === 'kook_member_sync') {
      authorize(args.actor, 'members.basic_edit', { kind: 'member', id: member.id }, identity.relations());
      authorize(args.actor, 'system.accounts', { kind: 'account', id: '__collection__' }, identity.relations());
      const result = r.kook;
      need(result && ['valid', 'missing_role', 'not_in_guild'].includes(result.status) &&
        result.externalId === config.externalId && result.guildId === config.guildId &&
        Array.isArray(result.roleIds) && result.roleIds.length <= 500 && result.roleIds.every(id => typeof id === 'string' && id.length <= 80) &&
        result.community && typeof result.community.available === 'boolean' && Array.isArray(result.community.roles) &&
        result.community.roles.length <= 500 && result.community.roles.every(role => role &&
          typeof role.id === 'string' && role.id.length <= 80 && result.roleIds.includes(role.id) &&
          typeof role.name === 'string' && role.name.length <= 100), 'INVALID_DATA');
      const actual = new Set(result.roleIds);
      const matched = config.matchMode === 'all' ? config.expectedRoleIds.every(id => actual.has(id)) :
        config.expectedRoleIds.some(id => actual.has(id));
      need(result.status === (result.status === 'not_in_guild' ? 'not_in_guild' : matched ? 'valid' : 'missing_role') &&
        (result.status !== 'not_in_guild' || result.roleIds.length === 0), 'INVALID_DATA');
      const account = identity.repo.all('accounts').find(row => row.memberId === member.id);
      const evidence = { provider: 'kook', externalId: config.externalId, guildId: config.guildId,
        roleIds: result.roleIds, community: result.community };
      applyRoleMappings(roleRepo, member, account, evidence, now);
      const currentMember = identity.repo.get('members', member.id);
      currentMember.kookRoleSync = { context: r.context, observedAt: r.observedAt,
        receivedAt: new Date(now()).toISOString(), revision: (previousEvidence?.revision || 0) + 1,
        status: result.status, roleIds: result.roleIds };
      saveMember(currentMember);
      upsertSqliteCollectionRecord(db, 'v2CommunityRoleAudits', `${member.id}:kook`, {
        id: `${member.id}:kook`, memberId: member.id, provider: 'kook', externalId: config.externalId,
        guildId: config.guildId, policyRevision: config.policyRevision, matchMode: config.matchMode,
        expectedRoleIds: config.expectedRoleIds, actualRoleIds: result.roleIds, status: result.status,
        error: '', checkedAt: r.observedAt
      });
      reconcileDeparture(member.id);
      return { memberId: member.id, type, status: result.status, memberRevision: get('members', member.id).revision,
        beforeHash: hash(before.member), afterHash: hash(get('members', member.id)) };
    }
    const p = { ...(oldProfile || {}), id: oldProfile?.id || randomUUID(), memberId: member.id, steamId: member.steamId };
    if (type === 'member_profile' && config.memberRisk) {
      authorize(args.actor, 'risks.manage', { kind: 'member', id: member.id }, identity.relations());
      need((!oldProfile || oldProfile.steamId === member.steamId) && r.risk?.scopeHash === hash(args.scope) && r.risk.operationId === args.operationId, 'SOURCE_CONTEXT_CHANGED', 409);
      applyRiskScan({ profile: p, member, result: r, config, now: now() });
      const retryAfterMs = Math.max(0, ...Object.values(r.risk.sources).map(part => part.error === 'RATE_LIMITED' ? Math.min(3600000, Math.max(1000, Number(part.retryAfterMs) || 60000)) : 0));
      if (retryAfterMs) { const syncRepo = new SyncCenterRepository(db), source = syncRepo.get('source', 'steam'); need(source, 'INVALID_DATA'); source.nextAllowedAt = Math.max(source.nextAllowedAt || 0, now() + retryAfterMs); source.updatedAt = now(); syncRepo.put('source', source); }
      if (p.displayName) member.steamNickname = p.displayName;
    } else if (type === 'battlemetrics_identity') {
      need(r.mapping && ['direct', 'verified'].includes(r.mapping.confidence), 'INVALID_DATA');
      setMapping(member, p, r.mapping, false, r.observedAt);
    } else if (type === 'battlemetrics_playtime') {
      need(r.playtime && r.playtime.playerId === (member.battlemetricsId || p.battlemetricsPlayerId) && Number.isFinite(r.playtime.seconds) && r.playtime.seconds >= 0 && r.playtime.wipeId === (args.scope.wipeId || args.scope.id), 'INVALID_DATA');
      Object.assign(p, { battlemetricsPlayerId: r.playtime.playerId, battlemetricsServerId: r.context.battlemetricsServerId, battlemetricsWipeId: r.playtime.wipeId, battlemetricsServerPlayTimeSeconds: r.playtime.seconds, battlemetricsWeeklyPlayTimeSeconds: r.playtime.seconds, battlemetricsSyncedAt: r.observedAt, battlemetricsRangeStartAt: r.context.from, battlemetricsRangeStopAt: r.context.to, battlemetricsSessionTruncated: false });
    } else if (type === 'kda') {
      need(r.stats?.wipeId === (args.scope.wipeId || args.scope.id) && r.stats.row?.memberId === member.id, 'INVALID_DATA');
      const wipe = get('v2Wipes', r.stats.wipeId);
      need(['scheduled', 'active'].includes(wipe?.lifecycle), 'WIPE_IMMUTABLE', 409);
      ingestService.ingest(args.actor, { ...r.stats, rows: [r.stats.row], sourceId: r.context.sourceId, serverId: r.context.serverId, providerWipeId: r.context.providerWipeId }, args.operationId);
    } else if (type === 'hexaytron_profile') {
      need(r.hexaytron && Array.isArray(r.hexaytron.servers), 'INVALID_DATA'); p.hexaytron = r.hexaytron;
    } else if (type === 'local_consistency') {
      need(r.consistency?.memberId === member.id && r.consistency.profileUrl === `https://steamcommunity.com/profiles/${member.steamId}`, 'INVALID_DATA');
      Object.assign(p, r.consistency);
    } else {
      const allowed = new Set(['displayName', 'avatar', 'profileUrl', 'profilePublic', 'playTimeMinutes', 'playTimeKnown']);
      need(r.profile && Object.keys(r.profile).every(k => allowed.has(k)), 'INVALID_DATA');
      for (const key of ['displayName','avatar','profileUrl']) if (r.profile[key] != null) need(typeof r.profile[key] === 'string' && r.profile[key].length <= 500, 'INVALID_DATA');
      if (r.profile.playTimeMinutes != null) need(Number.isFinite(r.profile.playTimeMinutes) && r.profile.playTimeMinutes >= 0, 'INVALID_DATA');
      for (const key of ['profilePublic','playTimeKnown']) if (r.profile[key] != null) need(typeof r.profile[key] === 'boolean', 'INVALID_DATA');
      for (const [key, value] of Object.entries(r.profile)) if (value != null && value !== '' && (type !== 'steam_profile_backfill' || p[key] == null || p[key] === '')) p[key] = value;
      if (p.displayName && (type !== 'steam_profile_backfill' || !member.steamNickname)) member.steamNickname = p.displayName;
    }
    p.sourceObservations = { ...p.sourceObservations, [type]: { observedAt: r.observedAt, receivedAt: new Date(now()).toISOString(), revision: (previousEvidence?.revision || 0) + 1, context: r.context, ...(type === 'kda' ? { retainedFields: r.retainedFields || {} } : {}), ...(config.memberRisk ? { quality: p.riskScan.quality } : {}) } };
    if (['member_profile', 'steam_profile_backfill'].includes(type) && p.avatar) {
      if (!member.avatar || member.avatar === member.steamAvatar) member.avatar = p.avatar;
      member.steamAvatar = p.avatar;
    }
    put('memberProfiles', p); saveMember(member);
    return { memberId: member.id, type, ...(config.memberRisk ? {
      quality: p.riskScan.quality, reason: p.riskScan.quality === 'complete' ? null : 'RISK_SCAN_INCOMPLETE',
      sourceResults: Object.entries(p.riskScan.sources).map(([source, evidence]) => ({
        source, status: evidence.status, error: evidence.error, required: evidence.required,
        observedCount: Object.values(p.riskScan.fields).filter(field => field.source === source && field.status === 'observed').length
      }))
    } : {}), memberRevision: (member.revision || 1) + 1, beforeHash: hash(before), beforeMapping: before.member.battlemetricsId || before.profile?.battlemetricsPlayerId || null, afterMapping: member.battlemetricsId || p.battlemetricsPlayerId || null, afterHash: hash({ member: get('members', member.id), profile: p }) };
  });
  const confirmBattlemetricsCandidate = args => receipt(args, ['candidate', args.memberId, args.candidate, args.expectedMemberRevision], () => {
    const member = current(args.actor, args.memberId);
    authorize(args.actor, 'members.basic_edit', { kind: 'member', id: member.id }, identity.relations());
    need((member.revision || 1) === args.expectedMemberRevision && args.candidate.memberRevision === args.expectedMemberRevision, 'REVISION_CONFLICT', 409);
    const old = profile(member), p = { ...(old || {}), id: old?.id || randomUUID(), memberId: member.id, steamId: member.steamId };
    const before = { member: structuredClone(member), profile: old };
    setMapping(member, p, args.candidate, true, new Date(now()).toISOString());
    put('memberProfiles', p); saveMember(member);
    return { memberId: member.id, battlemetricsId: member.battlemetricsId, beforeHash: hash(before), beforeMapping: before.member.battlemetricsId || before.profile?.battlemetricsPlayerId || null, afterMapping: member.battlemetricsId, afterHash: hash({ member: get('members', member.id), profile: p }) };
  });
  function evidence(type, scope, member) {
    if (type === 'member_profile') {
      const config = sync(readSourceConfig({ type, scope, member }));
      if (config?.memberRisk) { const p = profile(member), e = p?.riskScan; return { matched: Boolean(p?.steamId === member.steamId && e?.quality === 'complete' && e.binding === config.riskBinding), conflicted: Boolean(p && p.steamId !== member.steamId), observedAt: e?.checkedAt || null, receivedAt: p?.sourceObservations?.member_profile?.receivedAt || null, revision: e?.revision || 0, riskScan: true, quality: p?.steamId === member.steamId && e?.binding === config.riskBinding ? e.quality : 'unknown', lastSuccessAt: e?.lastCompleteAt || null }; }
    }
    if (type === 'discord_membership_audit') {
      const e = member.discordMembershipObservation, config = sync(readSourceConfig({ type, scope, member }));
      return { matched: Boolean(config?.enabled && e?.quality === 'complete' && ['valid','missing_role','not_in_guild'].includes(member.discordMembershipStatus) && hash(e.context) === hash(contextFor(config))), conflicted: false, observedAt: e?.observedAt || null, receivedAt: e?.receivedAt || null, lastSuccessAt: member.discordMembershipLastKnownAt || null, lastError: member.discordMembershipStatus === 'check_failed' ? member.discordMembershipError : null, revision: e?.revision || 0 };
    }
    if (type === 'kook_member_sync') {
      const config = sync(readSourceConfig({ type, scope, member })), e = member.kookRoleSync;
      return { matched: Boolean(config?.enabled && e && ['valid', 'missing_role', 'not_in_guild'].includes(e.status) &&
        hash(e.context) === hash(contextFor(config))), conflicted: false, observedAt: e?.observedAt || null,
        receivedAt: e?.receivedAt || null, lastSuccessAt: e?.observedAt || null, revision: e?.revision || 0 };
    }
    let p;
    try { p = profile(member); } catch { return { matched: false, conflicted: true }; }
    const wipeId = scope.wipeId || (scope.kind === 'current_wipe' ? scope.id : null);
    const e = p?.sourceObservations?.[type];
    const config = type === 'local_consistency' ? {} : sync(readSourceConfig?.({ type, scope, member }));
    const context = contextFor(config);
    let observedAt = e?.observedAt || null, receivedAt = e?.receivedAt || null;
    let matched = false, conflicted = false;
    if (type === 'battlemetrics_identity') {
      const id = member.battlemetricsId || p?.battlemetricsPlayerId;
      matched = Boolean(id); if (id) { try { uniqueMapping(member, id); } catch { conflicted = true; } }
      if (member.battlemetricsId && p?.battlemetricsPlayerId && member.battlemetricsId !== p.battlemetricsPlayerId) conflicted = true;
    } else if (type === 'battlemetrics_playtime') matched = Boolean(wipeId && p?.battlemetricsWipeId === wipeId && p.battlemetricsServerId === context.battlemetricsServerId && p.battlemetricsServerPlayTimeSeconds != null && p.battlemetricsSyncedAt && (!context.from || p.battlemetricsRangeStartAt === context.from) && (!context.to || p.battlemetricsRangeStopAt === context.to));
    else if (type === 'kda') {
      const row = wipeId && statsRow(wipeId, member.id);
      matched = Boolean(row && (row.sourceId || row.source) === context.sourceId && row.serverId === context.serverId && row.providerWipeId === context.providerWipeId && ['kills','deaths','assists','onlineSeconds','playTimeSeconds','steamTotalSeconds'].some(k => row[k] != null));
      observedAt = row?.capturedAt || row?.syncedAt || null; receivedAt = row?.receivedAt || null;
    }
    else if (type === 'hexaytron_profile') matched = Boolean(p?.hexaytron?.fetchedAt);
    else if (type === 'local_consistency') matched = Boolean(p?.memberId === member.id && p?.steamId === member.steamId && p.profileUrl === `https://steamcommunity.com/profiles/${member.steamId}`);
    else matched = Boolean(p?.displayName && p?.avatar && p?.profileUrl);
    return { matched, conflicted, observedAt: observedAt || (type === 'battlemetrics_identity' ? p?.battlemetricsMappingObservedAt : type === 'battlemetrics_playtime' ? p?.battlemetricsSyncedAt : type === 'hexaytron_profile' ? p?.hexaytron?.fetchedAt : null), receivedAt, revision: e?.revision || 0 };
  }
  const isMissing = ({ type, scope, member }) => !evidence(type, scope, member).matched;
  const readCoverage = ({ actor, type, scope, targets, limit = 500 }) => {
    need(Object.hasOwn(TYPES, type) && targets.length <= Math.min(limit, 500), 'SYNC_SCOPE_TOO_LARGE');
    const fresh = identity.actorForAccount(actor.id);
    const rows = targets.map(t => { authorize(fresh, 'sync.read', { kind: 'member', id: t.memberId, wipeId: scope.wipeId || scope.id }, identity.relations()); const m = get('members', t.memberId); need(m, 'RESOURCE_NOT_FOUND', 404); return evidence(type, scope, m); });
    const latest = key => rows.map(r => stamp(r[key])).filter(Boolean).sort().at(-1) || null;
    const matched = rows.filter(r => r.matched).length, conflicted = rows.filter(r => r.conflicted).length;
    return { source: TYPES[type], scope, observedAt: latest('observedAt'), receivedAt: latest('receivedAt'), lastSuccessAt: latest(['discord_membership_audit', 'kook_member_sync'].includes(type) || rows.some(r => r.riskScan) ? 'lastSuccessAt' : 'receivedAt'), coverage: { total: rows.length, matched, missing: rows.length - matched, conflicted, stale: rows.filter(r => r.matched && (!r.observedAt || now() - Date.parse(r.observedAt) > staleAfterMs)).length }, quality: conflicted ? 'conflicted' : rows.some(r => r.riskScan) ? rows.every(r => r.matched) ? 'complete' : rows.some(r => r.quality === 'partial' || r.matched) ? 'partial' : 'unknown' : !matched ? 'unknown' : matched < rows.length ? 'partial' : 'complete', revision: hash(rows), lastError: type === 'discord_membership_audit' ? rows.find(r => r.lastError)?.lastError || null : null };
  };
  const authority = createSqliteSyncAuthority({ identity, serializeWrite, applyResult, confirmBattlemetricsCandidate, isMissing, readCoverage });
  const resolveScope = authority.resolveScope;
  const sourceContexts = (type, scope, targets) => Object.fromEntries(targets.map(t => {
    const config = sync(readSourceConfig?.({ type, scope, member: get('members', t.memberId) }));
    return [t.memberId, config ? contextFor(config) : null];
  }));
  authority.resolveScope = args => {
    const resolved = resolveScope(args);
    if (args.type === 'member_profile') for (const target of resolved.targets) { const config = sync(readSourceConfig({ type: args.type, scope: resolved.scope, member: get('members', target.memberId) })); if (config?.memberRisk) authorize(args.actor, 'risks.manage', { kind: 'member', id: target.memberId }, identity.relations()); }
    if (args.type === 'discord_membership_audit') for (const target of resolved.targets) authorize(args.actor, 'members.change_status', { kind: 'member', id: target.memberId }, identity.relations());
    if (args.type === 'kook_member_sync') {
      authorize(args.actor, 'system.accounts', { kind: 'account', id: '__collection__' }, identity.relations());
      for (const target of resolved.targets) authorize(args.actor, 'members.basic_edit', { kind: 'member', id: target.memberId }, identity.relations());
    }
    if (args.type !== 'local_consistency') {
      resolved.scope.sourceContexts = sourceContexts(args.type, resolved.scope, resolved.targets);
      // A stable, secret-free source binding, never a clock-derived cutoff in the de-dup key.
      if (args.type === 'discord_membership_audit' || args.type === 'battlemetrics_playtime' && captureSourceWindow) {
        const clean = { ...resolved.scope }; delete clean.sourceContexts;
        resolved.scope.sourceWindowBinding = sync(readSourceConfig?.({ type: args.type, scope: clean }))?.windowBinding || '';
      }
    }
    return resolved;
  };
  if (captureSourceWindow) authority.scopeKey = ({ type, scope, targets, parent }) => scopeHash([type, scope, targets.map(i => i.memberId),
    ...(type === 'battlemetrics_playtime' && captureSourceWindow ? [parent?.scope?.sourceWindowIntentId || parent?.id || null] : [])]);
  if (captureSourceWindow) authority.captureScope = ({ actor, job, parent }) => {
    if (job.type !== 'battlemetrics_playtime' || !captureSourceWindow) return job.scope;
    need(writing && db.isTransaction, 'SOURCE_TRANSACTION_REQUIRED', 503);
    return sync(captureSourceWindow({ actor, job, parent, bind: scope => {
      need(scope?.sourceWindowId === job.id, 'SOURCE_WINDOW_JOB_MISMATCH', 409);
      const clean = { ...scope }; delete clean.sourceContexts;
      for (const item of job.items) need(sync(readSourceConfig({ type: job.type, scope: clean, member: get('members', item.memberId) }))?.enabled !== false, 'SOURCE_NOT_CONFIGURED', 503);
      return { ...clean, sourceContexts: sourceContexts(job.type, clean, job.items) };
    } }));
  };
  authority.isMissing = isMissing;
  return { authority, store: { get, profile, statsRow, trigger, readSourceConfig }, ingestService, flushCache, bindVitalWipe };
}
