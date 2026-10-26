import { hash, need, stamp } from '../../stats/model.js';
import { defaultRules } from '../../member-admin/risk.js';
export const RISK_FIELDS = Object.freeze({
  profile: ['displayName','avatar','profileUrl','profilePublic'],
  playtime: ['playTimeMinutes','playTimeKnown','playTimeVisibility'],
  inventory: ['inventoryValue','inventoryCurrency','inventoryPublic','inventoryVisibility'],
  bans: ['vacBanned','numberOfVacBans','numberOfGameBans','daysSinceLastBan','communityBanned','economyBan','economyRestricted'],
  restriction: ['accountRestricted','accountRestrictionStatus','accountRestrictionRetryMs','accountRestrictionEresult'],
  official: ['officialKda.kills','officialKda.deaths','officialKda.kd','officialKda.rockets'],
  battlemetrics: ['battlemetricsLastOnlineAt','battlemetricsLastOfflineAt'],
  squad: ['squadId']
});
export const RISK_ERRORS = Object.freeze(['SOURCE_NOT_CONFIGURED','SOURCE_UNAVAILABLE','SOURCE_TIMEOUT','CREDENTIALS_INVALID','CREDENTIALS_CHANGED',
  'RATE_LIMITED','SOURCE_INVALID_DATA','SOURCE_INVALID_JSON','SOURCE_PAGE_LIMIT','SOURCE_RESPONSE_TOO_LARGE','SOURCE_REDIRECT_REJECTED',
  'SOURCE_PRIVATE','SOURCE_MISSING_FIELDS','SOURCE_IDENTITY_MISMATCH','SOURCE_WINDOW_REQUIRED','SOURCE_MAPPING_REQUIRED','SOURCE_PRICE_UNAVAILABLE','PROXY_UNAVAILABLE']);
export function riskConfiguration({ settings, member = {}, profile, memberships = [], riskWipes = [], credentials, capabilities }) {
  const rules = structuredClone(settings.accountRisk?.rules || defaultRules()); need(Array.isArray(rules) && rules.length <= 50, 'INVALID_DATA');
  for (const rule of defaultRules().slice(0, 2)) if (!rules.some(r => r.type === rule.type)) rules.push(rule);
  const squadIds = [...new Set(memberships.map(s => s.squadId))];
  const match = id => !id || id === '__unassigned' && !squadIds.length || squadIds.includes(id);
  const types = new Set(rules.filter(r => r.enabled && match(r.squadFilter) && match(settings.accountRisk?.squadFilter)).map(r => r.type));
  // Keep baseline visibility fields in scan quality, even when no privacy alert rule is enabled.
  const required = ['playTimeMinutes','playTimeKnown','playTimeVisibility','inventoryPublic','inventoryVisibility'];
  if (types.has('inventory_value')) required.push('inventoryValue','inventoryCurrency');
  if (types.has('account_restricted')) required.push('accountRestricted');
  if (types.has('steam_ban_or_restriction')) required.push('vacBanned','numberOfVacBans','numberOfGameBans','communityBanned','economyBan','economyRestricted');
  for (const [type, field] of Object.entries({ kd: 'kd', kills: 'kills', deaths: 'deaths', rockets: 'rockets' })) if (types.has(type)) required.push(`officialKda.${field}`);
  if (types.has('no_online_days')) required.push('battlemetricsLastOnlineAt');
  if (types.has('unassigned_squad')) required.push('squadId');
  const requiredSources = Object.entries(RISK_FIELDS).filter(([, fields]) => fields.some(f => required.includes(f))).map(([source]) => source);
  const wipe = riskWipes.length === 1 && ['active','scheduled'].includes(riskWipes[0].lifecycle) ? riskWipes[0] : null;
  const bmServer = String(wipe?.serverSnapshot?.battlemetricsId || wipe?.serverSnapshot?.battlemetricsServerId || '');
  const bmPlayer = member.battlemetricsId || profile?.battlemetricsPlayerId || '';
  const bmTrusted = member.battlemetricsId && (!profile?.battlemetricsPlayerId || member.battlemetricsId === profile.battlemetricsPlayerId) || ['direct','verified','manual'].includes(profile?.battlemetricsMatchConfidence);
  const credentialBindings = Object.fromEntries(['steam','community','battlemetrics'].map(source => [source, hash(credentials(source))]));
  return { enabled: true, memberRisk: true, sourceId: 'steam', required, requiredSources, credentialBindings,
    riskBinding: hash({ member: { id: member.id, steamId: member.steamId, battlemetricsId: member.battlemetricsId || '' },
      profileMapping: { steamId: profile?.steamId || member.steamId, id: profile?.battlemetricsPlayerId, confidence: profile?.battlemetricsMatchConfidence },
      memberships, riskWipes, accountRisk: settings.accountRisk || {}, sourceSettings: { steamWebApi: settings.steamWebApi, battlemetrics: settings.battlemetrics, proxy: settings.system?.proxy }, credentialBindings, capabilities }),
    riskSquadId: squadIds.length === 1 ? squadIds[0] : squadIds.length ? null : '',
    riskBm: { enabled: Boolean(capabilities.battlemetrics && credentials('battlemetrics').key && bmTrusted && /^\d{1,30}$/.test(bmPlayer) && /^\d{1,30}$/.test(bmServer) && stamp(wipe?.serverActualWipeAt || wipe?.actualStartedAt)),
      playerId: bmPlayer, serverId: bmServer, wipeId: wipe?.id || '', from: stamp(wipe?.serverActualWipeAt || wipe?.actualStartedAt),
      to: stamp(wipe?.endedAt) },
    riskCapabilities: { ...capabilities } };
}
