import { requireValue } from './repository.js';
export const defaultRules = () => [{
  id: 'account-restricted',
  name: 'Steam 受限账号',
  type: 'account_restricted',
  operator: 'is',
  threshold: 0,
  enabled: true,
  squadFilter: ''
}, {
  id: 'steam-ban-or-restriction',
  name: 'Steam 封禁或限制',
  type: 'steam_ban_or_restriction',
  operator: 'is',
  threshold: 0,
  enabled: true,
  squadFilter: ''
}, {
  id: 'low-game-hours',
  name: '游戏时长低于 500h',
  type: 'playtime_hours',
  operator: 'lt',
  threshold: 500,
  enabled: true,
  squadFilter: ''
}, {
  id: 'low-inventory',
  name: '库存价值低于 $50',
  type: 'inventory_value',
  operator: 'lt',
  threshold: 50,
  enabled: true,
  squadFilter: ''
}, {
  id: 'no-online-14d',
  name: '14 天无在线记录',
  type: 'no_online_days',
  operator: 'gte',
  threshold: 14,
  enabled: true,
  squadFilter: ''
}, {
  id: 'unassigned-squad',
  name: '未分配队伍',
  type: 'unassigned_squad',
  operator: 'is',
  threshold: 0,
  enabled: false,
  squadFilter: ''
}];
export const ruleTypes = {
  account_restricted: 'Steam 受限',
  steam_ban_or_restriction: 'Steam 封禁',
  unassigned_squad: '未分队',
  playtime_hours: '游戏时长(h)',
  inventory_value: '库存(USD)',
  no_online_days: '未在线天数',
  kd: 'KD',
  kills: '击杀',
  deaths: '死亡',
  rockets: '火箭',
  private_inventory: '库存不可见',
  private_playtime: '时长不可见'
};
export function validateRules(rules) {
  requireValue(Array.isArray(rules) && rules.length <= 50, 'INVALID_RULES');
  const ids = new Set();
  return rules.map(r => {
    requireValue(typeof r.id === 'string' && r.id.length > 0 && r.id.length <= 100 && !ids.has(r.id), 'INVALID_RULE_ID');
    ids.add(r.id);
    requireValue(Object.hasOwn(ruleTypes, r.type) && ['is', 'unavailable', 'lt', 'lte', 'gt', 'gte', 'eq'].includes(r.operator) && typeof r.name === 'string' && r.name.length > 0 && r.name.length <= 120 && Number.isFinite(r.threshold) && r.threshold >= 0 && typeof r.enabled === 'boolean' && typeof (r.squadFilter || '') === 'string', 'INVALID_RULE');
    const bool = ['account_restricted', 'steam_ban_or_restriction', 'unassigned_squad'].includes(r.type);
    const priv = r.type.startsWith('private_');
    requireValue(bool ? r.operator === 'is' : priv ? r.operator === 'unavailable' : !['is', 'unavailable'].includes(r.operator), 'INVALID_RULE_OPERATOR');
    return {
      id: r.id,
      name: r.name,
      type: r.type,
      operator: r.operator,
      threshold: r.threshold,
      enabled: r.enabled,
      squadFilter: r.squadFilter || ''
    };
  });
}
const finite = v => v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
export function riskEvidence(member, rules, globalSquad = '', now = Date.now()) {
  const s = member.accountSignals || {},
    result = [],
    match = f => !f || (f === '__unassigned' ? !member.squadId : member.squadId === f);
  const play = Boolean(s.playTimeKnown) && finite(s.playTimeMinutes) !== null,
    inv = Boolean(s.inventoryPublic) && finite(s.inventoryValue) !== null;
  const suppressed = !play && inv && s.inventoryValue > 50 || play && s.playTimeMinutes > 180000 && (!inv || s.inventoryValue <= 0);
  for (const r of rules) {
    if (!r.enabled || !match(globalSquad) || !match(r.squadFilter)) continue;
    let value = null,
      matched = false;
    if (r.type === 'account_restricted') {
      value = Boolean(s.accountRestricted);
      matched = value;
    } else if (r.type === 'steam_ban_or_restriction') {
      value = Boolean(s.vacBanned || s.communityBanned || s.economyRestricted || Number(s.numberOfVacBans) > 0 || Number(s.numberOfGameBans) > 0 || s.economyBan && s.economyBan !== 'none');
      matched = value;
    } else if (r.type === 'unassigned_squad') {
      value = !member.squadId;
      matched = value;
    } else if (r.type === 'private_inventory') {
      value = !inv;
      matched = value;
    } else if (r.type === 'private_playtime') {
      value = !play;
      matched = value;
    } else {
      if (r.type === 'playtime_hours') value = play ? s.playTimeMinutes / 60 : null;
      if (r.type === 'inventory_value') value = inv ? finite(s.inventoryValue) : null;
      if (r.type === 'no_online_days') value = Number.isFinite(Date.parse(s.lastOnlineAt)) ? Math.floor((now - Date.parse(s.lastOnlineAt)) / 86400000) : null;
      const k = {
        kd: 'kd',
        kills: 'kills',
        deaths: 'deaths',
        rockets: 'rockets'
      }[r.type];
      if (k) value = finite(k === 'kd' ? s.officialKda?.kd ?? s.officialKda?.kda : s.officialKda?.[k]);
      if (value !== null) matched = {
        lt: () => value < r.threshold,
        lte: () => value <= r.threshold,
        gt: () => value > r.threshold,
        gte: () => value >= r.threshold,
        eq: () => value === r.threshold
      }[r.operator]?.() || false;
    }
    if (matched) result.push({
      id: r.id,
      name: r.name,
      type: r.type,
      value,
      operator: r.operator,
      threshold: r.threshold,
      suppressed: suppressed && !['account_restricted', 'steam_ban_or_restriction'].includes(r.type)
    });
  }
  return result;
}
