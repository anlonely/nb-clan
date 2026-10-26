import { collectRiskBattlemetrics } from './risk.js';
import { discordId } from '../source-host/discord-membership.js';
import { hash, need, text, stamp, sessionSeconds, METRICS } from '../../stats/model.js';
import { createStatsProviders } from '../../stats/providers.js';
import { TYPES, supportedType } from '../../sync-center/model.js';
import { statusOf } from '../../member-admin/model.js';
import { battlemetricsQueueMetaForSync } from '../../../battlemetrics-queue.js';
import { parseHexaytronMessageProfile } from './hexaytron.js';
import { abortable, checkAbort, sourceFailure } from './transport.js';

export const contextFor = (config = {}) => ({ ...Object.fromEntries(['sourceId', 'serverId', 'providerServerId', 'providerWipeId', 'battlemetricsServerId', 'from', 'to'].map(k => [k, text(config[k], 180)])), ...(config.sourceId === 'discord' ? { auditBinding: config.auditBinding, guildId: config.guildId, discordId: config.discordId } : {}), ...(config.sourceId === 'kook' ? { syncBinding: config.syncBinding, guildId: config.guildId, externalId: config.externalId } : {}), ...(config.memberRisk ? { riskBinding: config.riskBinding } : {}) });
export function createSourceCollectors({ store, readSourceConfig, readers = {}, bmRequest, now = Date.now }) {
  const statsProviders = Object.fromEntries(Object.entries(createStatsProviders(readers.stats || {})).map(([key, provider]) => [key, async (input, options = {}) => {
    checkAbort(options.signal);
    const out = await abortable(Promise.resolve().then(() => { checkAbort(options.signal); return provider(input, options); }), options.signal);
    checkAbort(options.signal); return out;
  }]));
  const call = async (fn, args, signal) => {
    need(typeof fn === 'function', 'SOURCE_NOT_CONFIGURED', 503);
    checkAbort(signal);
    const result = await abortable(Promise.resolve().then(() => { checkAbort(signal); return fn(args); }), signal);
    checkAbort(signal);
    return result;
  };
  const collectors = Object.fromEntries(Object.keys(TYPES).filter(supportedType).map(type => [type, async request => {
    try {
      checkAbort(request.signal);
      const member = store.get('members', request.memberId);
      need(member, 'INVALID_DATA');
      if (['kook_member_sync', 'discord_membership_audit'].includes(type) && statusOf(member) !== 'active') return { outcome: 'skipped', reason: 'NO_APPLICABLE_DATA' };
      const profile = ['discord_membership_audit', 'kook_member_sync'].includes(type) ? null : store.profile(member), wipeId = request.scope.wipeId || (request.scope.kind === 'current_wipe' ? request.scope.id : null);
      const wipe = wipeId ? store.get('v2Wipes', wipeId) : null;
      const config = type === 'local_consistency' ? {} : (store.readSourceConfig || readSourceConfig)?.({ type, scope: request.scope, member });
      if (type === 'kook_member_sync' && !config?.externalId) return { outcome: 'skipped', reason: 'MISSING_IDENTITY' };
      if (type === 'discord_membership_audit' && !discordId(config?.discordId)) return { outcome: 'skipped', reason: 'MISSING_IDENTITY' };
      need(config && !config.then && config.enabled !== false, 'SOURCE_NOT_CONFIGURED', 503);
      const context = contextFor(config), captured = new Date(now()).toISOString();
      if (request.scope.sourceContexts) need(hash(request.scope.sourceContexts[member.id]) === hash(context), 'SOURCE_CONTEXT_CHANGED', 409);
      const data = { memberHash: hash(member), profileHash: hash(profile || {}), context, observedAt: captured, steamId: member.steamId };
      const input = { ...request, member: structuredClone(member), profile: structuredClone(profile), config, context };
      if (!['local_consistency', 'discord_membership_audit', 'kook_member_sync'].includes(type) && !/^7656119\d{10}$/.test(member.steamId || '')) return { outcome: 'skipped', reason: 'MISSING_IDENTITY' };
      if (type.startsWith('battlemetrics_') || config.memberRisk && config.requiredSources.includes('battlemetrics') && bmRequest) {
        need(bmRequest, 'SOURCE_NOT_CONFIGURED', 503);
        // Trigger is held in the authoritative job; never trust source configuration or client metadata.
        const trigger = store.trigger(request.operationId);
        const queueMeta = battlemetricsQueueMetaForSync({ manual: trigger === 'manual' });
        input.request = (path, options = {}) => bmRequest(path, { ...options, queueMeta, signal: request.signal });
      }
      if (type === 'member_profile' && config.memberRisk) {
        need(!profile || profile.steamId === member.steamId && (!profile.accountSignals?.steamId || profile.accountSignals.steamId === member.steamId), 'SOURCE_IDENTITY_MISMATCH', 409);
        const scopeHash = hash(request.scope);
        const [sources, battlemetrics] = await Promise.all([call(readers.memberRisk, input, request.signal), collectRiskBattlemetrics({ ...input, cutoff: captured })]);
        const squad = !config.requiredSources.includes('squad') ? { status: 'not_required', fields: {}, checkedAt: null, error: null } : config.riskSquadId === null ? { status: 'unavailable', fields: {}, checkedAt: captured, error: 'SOURCE_INVALID_DATA' } : { status: 'observed', fields: { squadId: config.riskSquadId }, checkedAt: captured, error: null };
        data.risk = { scopeHash, operationId: request.operationId, sources: { ...sources, battlemetrics, squad } };
        data.observedAt = new Date(now()).toISOString();
      } else if (type === 'discord_membership_audit') {
        data.auditScopeHash = hash(request.scope);
        data.audit = await call(readers.discordMembership, input, request.signal);
        data.observedAt = new Date(now()).toISOString();
      } else if (type === 'kook_member_sync') {
        data.kook = await call(readers.kookMember, input, request.signal);
        data.observedAt = new Date(now()).toISOString();
      } else if (type === 'battlemetrics_identity') {
        const raw = await call(readers.battlemetricsIdentity, input, request.signal);
        if (raw?.match && ['direct', 'verified'].includes(raw.match.confidence)) {
          need(/^\d{1,30}$/.test(raw.match.battlemetricsId) && raw.match.steamId === member.steamId, 'INVALID_DATA');
          data.mapping = { battlemetricsId: raw.match.battlemetricsId, confidence: raw.match.confidence, displayName: text(raw.match.displayName, 120) };
        } else {
          const candidates = (raw?.candidates || (raw?.match ? [raw.match] : [])).slice(0, 10).filter(c => /^\d{1,30}$/.test(c.battlemetricsId)).map(c => ({ battlemetricsId: c.battlemetricsId, confidence: 'alias', displayName: text(c.displayName, 120), memberRevision: member.revision || 1 }));
          return candidates.length ? { outcome: 'conflict', candidates } : { outcome: 'skipped', reason: 'NO_APPLICABLE_DATA' };
        }
      } else if (type === 'battlemetrics_playtime') {
        const playerId = member.battlemetricsId || profile?.battlemetricsPlayerId;
        if (!playerId) return { outcome: 'skipped', reason: 'MISSING_IDENTITY' };
        need(wipe && context.serverId === wipe.serverProfileId && context.battlemetricsServerId && stamp(context.from) && stamp(context.to), 'INVALID_DATA');
        const raw = await call(readers.battlemetricsSessions, { ...input, playerId }, request.signal);
        need(raw && Array.isArray(raw.sessions) && raw.sessions.length <= 10000 && raw.complete === true, 'INVALID_DATA');
        const observedAt = stamp(raw.observedAt) || captured;
        need(Date.parse(observedAt) <= now() + 60000, 'INVALID_DATA');
        data.observedAt = observedAt;
        data.playtime = { seconds: sessionSeconds(raw.sessions, { serverId: context.battlemetricsServerId, from: context.from, to: context.to, observedAt }), playerId, wipeId: wipe.id };
      } else if (type === 'kda') {
        need(wipe && context.sourceId && context.serverId === wipe.serverProfileId && context.providerWipeId, 'INVALID_DATA');
        const old = store.statsRow(wipe.id, member.id);
        // Freeze optimistic versions BEFORE network I/O, not after another worker may commit.
        data.stats = { wipeId: wipe.id, expectedRevision: wipe.revision, expectedRows: { [member.id]: hash(old || {}) } };
        const provider = statsProviders[context.sourceId];
        need(provider, 'SOURCE_NOT_CONFIGURED', 503);
        const raw = await call(() => provider({ steamInput: member.steamId, serverId: config.providerServerId || context.serverId, providerWipeId: context.providerWipeId }, { signal: request.signal }), input, request.signal);
        const row = raw.rows?.find(r => r.steamId === member.steamId);
        if (!row || ['private', 'unavailable', 'unsupported'].includes(raw.status)) return { outcome: 'skipped', reason: 'NO_APPLICABLE_DATA' };
        need(METRICS.some(k => row[k] !== null && row[k] !== undefined), 'INVALID_DATA');
        data.stats.row = { ...row, memberId: member.id, capturedAt: stamp(row.capturedAt) || captured, sourceRevision: (old?.sourceRevision || 0) + 1 };
        data.retainedFields = {};
        if (old && (old.sourceId || old.source) === context.sourceId && old.serverId === context.serverId && old.providerWipeId === context.providerWipeId) {
          for (const key of METRICS) if (row[key] == null && old[key] != null && row.capabilities?.[key] !== false) {
            data.stats.row[key] = old[key]; data.retainedFields[key] = old.capturedAt || old.syncedAt || null;
          }
          if (Object.keys(data.retainedFields).length) data.stats.row.coverage = 'partial_retained';
        }
        data.observedAt = data.stats.row.capturedAt;
      } else if (type === 'hexaytron_profile') {
        // Legacy fetchHexaytronProfileViaDiscord SENDS A MESSAGE. Only read an existing matched card.
        const raw = await call(readers.hexaytronMessage, input, request.signal);
        if (!raw) return { outcome: 'skipped', reason: 'NO_APPLICABLE_DATA' };
        need(raw.steamId === member.steamId && raw.message && stamp(raw.observedAt), 'INVALID_DATA');
        const parsed = parseHexaytronMessageProfile(raw.message, member.steamId);
        if (!parsed) return { outcome: 'skipped', reason: 'NO_APPLICABLE_DATA' };
        const { servers, rustHours, rustMinutes, firstSeenDaysAgo, sourceMessageId } = parsed;
        data.hexaytron = { servers, rustHours, rustMinutes, firstSeenDaysAgo, sourceMessageId, fetchedAt: stamp(raw.observedAt) };
        data.observedAt = data.hexaytron.fetchedAt;
      } else if (type === 'member_profile' || type === 'steam_profile_backfill') {
        const raw = await call(readers.steamProfile, input, request.signal);
        need(raw?.steamId === member.steamId, 'INVALID_DATA');
        data.profile = {};
        for (const [key, value] of Object.entries({ displayName: raw.nickname || raw.name, avatar: raw.avatar, profileUrl: raw.profileUrl })) if (text(value, 500)) data.profile[key] = text(value, key === 'displayName' ? 120 : 500);
        if (typeof raw.profilePublic === 'boolean') data.profile.profilePublic = raw.profilePublic;
        if (raw.playtimeMinutes != null) { need(Number.isFinite(raw.playtimeMinutes) && raw.playtimeMinutes >= 0, 'INVALID_DATA'); data.profile.playTimeMinutes = raw.playtimeMinutes; data.profile.playTimeKnown = true; }
        need(Object.keys(data.profile).length, 'INVALID_DATA');
        if (type === 'steam_profile_backfill') {
          for (const key of Object.keys(data.profile)) if (profile?.[key] != null && profile[key] !== '') delete data.profile[key];
          if (!Object.keys(data.profile).length) return { outcome: 'skipped', reason: 'NO_CHANGE' };
        }
      } else {
        need(profile && (!profile.memberId || profile.memberId === member.id) && profile.steamId === member.steamId, 'INVALID_DATA');
        data.consistency = { memberId: member.id, profileUrl: `https://steamcommunity.com/profiles/${member.steamId}` };
        if (profile.memberId === member.id && profile.profileUrl === data.consistency.profileUrl) return { outcome: 'skipped', reason: 'NO_CHANGE' };
      }
      checkAbort(request.signal);
      return { outcome: 'success', data, observedAt: data.observedAt };
    } catch (error) { return sourceFailure(error); }
  }]));
  return { collectors, statsProviders };
}
