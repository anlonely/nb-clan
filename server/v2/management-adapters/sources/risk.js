import { hash, need, stamp } from '../../stats/model.js';
import { RISK_FIELDS, RISK_ERRORS } from '../source-host/risk-model.js';
import { readBattlemetricsSessions } from './battlemetrics.js';
import { checkAbort } from './transport.js';
const timeFields = { profile: 'fetchedAt', playtime: 'fetchedAt', inventory: 'fetchedAt', bans: 'steamBanCheckedAt', restriction: 'accountRestrictionCheckedAt', official: 'officialKdaFetchedAt', battlemetrics: 'battlemetricsSyncedAt' };
const get = (obj, key) => key.split('.').reduce((v, k) => v?.[k], obj);
const set = (obj, key, value) => { const [a, b] = key.split('.'); if (b) obj[a] = { ...obj[a], [b]: value }; else obj[a] = value; };
const stringFields = new Set(['displayName','avatar','profileUrl','playTimeVisibility','inventoryVisibility','inventoryCurrency','economyBan','accountRestrictionStatus','battlemetricsLastOnlineAt','battlemetricsLastOfflineAt','squadId']);
const boolFields = new Set(['profilePublic','playTimeKnown','inventoryPublic','vacBanned','communityBanned','economyRestricted','accountRestricted']);
function valid(field, value) {
  if (stringFields.has(field)) return typeof value === 'string' && value.length <= 500 && (!field.startsWith('battlemetricsLast') || value === '' || Boolean(stamp(value)));
  if (boolFields.has(field)) return typeof value === 'boolean';
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
export async function collectRiskBattlemetrics({ member, profile, config, request, signal, cutoff }) {
  if (!config.requiredSources.includes('battlemetrics')) return { status: 'not_required', fields: {}, checkedAt: null, error: null };
  const bm = config.riskBm;
  try {
    need(request && bm.enabled && member.battlemetricsId === bm.playerId, bm.playerId ? 'SOURCE_WINDOW_REQUIRED' : 'SOURCE_MAPPING_REQUIRED', 503);
    need(!profile?.battlemetricsPlayerId || profile.battlemetricsPlayerId === bm.playerId, 'SOURCE_IDENTITY_MISMATCH', 503);
    const to = bm.to && bm.to < cutoff ? bm.to : cutoff;
    need(stamp(bm.from) && Date.parse(to) >= Date.parse(bm.from), 'SOURCE_WINDOW_REQUIRED', 503);
    const result = await readBattlemetricsSessions({ playerId: bm.playerId, context: { battlemetricsServerId: bm.serverId }, config: { sessionPageLimit: 20 },
      signal, request: (path, options = {}) => request(path, { ...options, expectedCredentialsHash: config.credentialBindings.battlemetrics }) });
    need(result.complete, 'SOURCE_PAGE_LIMIT', 503);
    const sessions = result.sessions.filter(s => s.serverId === bm.serverId && Date.parse(s.start) >= Date.parse(bm.from) && Date.parse(s.start) <= Date.parse(to) && (!s.end || Date.parse(s.end) >= Date.parse(s.start)))
      .sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
    need(sessions.length > 0, 'SOURCE_MISSING_FIELDS', 503);
    return { status: 'observed', fields: { battlemetricsLastOnlineAt: sessions[0].start, battlemetricsLastOfflineAt: sessions[0].end && Date.parse(sessions[0].end) <= Date.parse(to) ? sessions[0].end : '' },
      checkedAt: new Date().toISOString(), error: null, window: { from: bm.from, to, serverId: bm.serverId, wipeId: bm.wipeId, playerId: bm.playerId } };
  } catch (error) { checkAbort(signal); return { status: 'unavailable', fields: {}, error: RISK_ERRORS.includes(error?.errorCode) ? error.errorCode : 'SOURCE_UNAVAILABLE', checkedAt: new Date().toISOString(),
    ...(error?.status === 429 ? { retryAfterMs: Math.min(3600000, Math.max(1000, Number(error.retryAfterMs) || 60000)) } : {}) }; }
}
/** Preserve unknown/failed fields with their original observation time; never carry across Steam identities. */
export function applyRiskScan({ profile, member, result, config, now }) {
  need(profile.steamId === member.steamId && result.risk?.scopeHash && result.steamId === member.steamId, 'SOURCE_IDENTITY_MISMATCH', 409);
  const old = structuredClone(profile), fields = {}, sources = {}, parts = result.risk.sources;
  // Previous Steam scans stored K/D under the legacy kda key. Keep that evidence
  // readable as KD until a fresh observation replaces it, without inventing assists.
  for(const target of [old, profile, old.accountSignals, profile.accountSignals].filter(Boolean)) {
    const previous=target.officialKda;
    if(previous?.kd == null && typeof previous?.kda === 'number' && !previous.source)target.officialKda={...previous,kd:previous.kda};
  }
  if(old.riskScan?.fields?.['officialKda.kda']&&!old.riskScan.fields['officialKda.kd'])old.riskScan.fields['officialKda.kd']=old.riskScan.fields['officialKda.kda'];
  need(parts && Object.keys(parts).every(s => Object.hasOwn(RISK_FIELDS, s)), 'INVALID_DATA');
  for (const [source, names] of Object.entries(RISK_FIELDS)) {
    const part = parts[source]; need(part && ['observed','partial','private','unavailable','not_required'].includes(part.status), 'INVALID_DATA');
    need(!part.checkedAt || stamp(part.checkedAt) && Date.parse(part.checkedAt) <= now + 60000, 'INVALID_DATA');
    const known = part.fields || {}; need(Object.keys(known).every(k => names.includes(k) && valid(k, known[k])), 'INVALID_DATA');
    const error = RISK_ERRORS.includes(part.error) ? part.error : part.error ? 'SOURCE_UNAVAILABLE' : null;
    sources[source] = { status: part.status, required: config.requiredSources.includes(source), checkedAt: part.checkedAt,
      error, fields: [...names], ...(part.window ? { window: part.window } : {}) };
    for (const field of names) {
      const oldEvidence = old.riskScan?.steamId === member.steamId ? old.riskScan.fields?.[field] : null;
      const prior = get(old, field) ?? get(old.accountSignals, field);
      const observed = Object.hasOwn(known, field), required = config.required.includes(field), notRequired = !required && !observed && source !== 'profile';
      fields[field] = { source, required, status: observed ? 'observed' : notRequired ? 'not_required' : part.status === 'private' ? 'private' : part.status === 'not_required' ? 'not_required' : 'unavailable',
        checkedAt: notRequired ? null : part.checkedAt, observedAt: observed ? part.checkedAt : oldEvidence?.observedAt || stamp(old[timeFields[source]]) || null,
        context: observed ? { steamId: member.steamId, ...(source === 'battlemetrics' ? part.window : {}) } : oldEvidence?.context || { steamId: member.steamId, ...(source === 'battlemetrics' ? old.riskScan?.sources?.battlemetrics?.window : {}) },
        retained: !observed && prior !== null && prior !== undefined, error: observed || notRequired || part.status === 'not_required' ? null : error || 'SOURCE_MISSING_FIELDS' };
      if (observed && source !== 'squad') {
        set(profile, field, known[field]);
        if (field === 'battlemetricsLastOnlineAt') { profile.lastOnlineAt = known[field]; if (profile.accountSignals) profile.accountSignals.lastOnlineAt = known[field]; }
        // Existing DTO may prioritize accountSignals. Copy only real observations, never defaults.
        if (profile.accountSignals) set(profile.accountSignals, field, known[field]);
      }
    }
    if (source !== 'squad' && names.every(f => fields[f].status === 'observed')) profile[timeFields[source]] = part.checkedAt;
  }
  if (parts.official?.status === 'observed' || parts.official?.status === 'partial') {
    // Steam Rust lifetime statistics provide kills/deaths but no assists.
    // Do not relabel K/D as KDA, including a retained legacy KDA alias.
    const metadata = { source: 'steam', scope: 'lifetime', assists: null, kda: null };
    profile.officialKda = { ...profile.officialKda, ...metadata };
    if (profile.accountSignals) profile.accountSignals.officialKda = { ...profile.accountSignals.officialKda, ...metadata };
  }
  const requested = config.required.map(f => fields[f]);
  const observedCount = requested.filter(f => f.status === 'observed').length;
  const quality = requested.length === observedCount ? 'complete' : observedCount ? 'partial' : 'unknown';
  // fetchedAt is the legacy broad scan timestamp; partial source updates must not advance it.
  profile.fetchedAt = quality === 'complete' ? new Date(now).toISOString() : old.fetchedAt || null;
  if (fields.accountRestricted.status === 'observed') profile.accountRestrictionCheckedAt = fields.accountRestricted.observedAt;
  profile.steamBanError = sources.bans.required ? sources.bans.error || (sources.bans.status === 'partial' ? 'SOURCE_MISSING_FIELDS' : '') : old.steamBanError || '';
  profile.accountRestrictionError = sources.restriction.required ? sources.restriction.error || '' : old.accountRestrictionError || '';
  profile.officialKdaError = sources.official.required ? sources.official.error || '' : old.officialKdaError || '';
  profile.error = quality === 'complete' ? '' : 'RISK_SCAN_INCOMPLETE';
  profile.riskScan = { revision: (old.riskScan?.revision || 0) + 1, steamId: member.steamId, quality, checkedAt: new Date(now).toISOString(),
    lastCompleteAt: quality === 'complete' ? new Date(now).toISOString() : old.riskScan?.steamId === member.steamId ? old.riskScan.lastCompleteAt || null : null,
    binding: config.riskBinding, scopeHash: result.risk.scopeHash, sources, fields };
  return profile.riskScan;
}
