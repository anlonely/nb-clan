import { formatCurrencyValue } from './currency.js';
import { formatCopy, formatPlayTimeMinutes, formatStatNumber } from './format.js';

const MEMBER_NOTIFICATION_RULES = {
  lowGameHours: 500,
  lowInventoryValue: 50,
  trustedGameHours: 3000,
  offlineDays: 14
};

const PRIVATE_INVENTORY_ALERT_TYPE = 'private-inventory';
const PRIVATE_PLAY_TIME_ALERT_TYPE = 'private-playtime';
const PRIVATE_ACCOUNT_ALERT_TYPE = 'private-account';
const PRIVATE_DATA_RISK_RULE_TYPES = new Set(['private_inventory', 'private_playtime']);
const ACCOUNT_RISK_UNASSIGNED_SQUAD_FILTER = '__unassigned';
const ACCOUNT_RISK_RULE_TYPE_OPTIONS = [
  { value: 'account_restricted', labelKey: 'riskRuleTypeAccountRestricted' },
  { value: 'steam_ban_or_restriction', labelKey: 'riskRuleTypeSteamBanOrRestriction' },
  { value: 'unassigned_squad', labelKey: 'riskRuleTypeUnassignedSquad' },
  { value: 'playtime_hours', labelKey: 'riskRuleTypePlaytimeHours' },
  { value: 'inventory_value', labelKey: 'riskRuleTypeInventoryValue' },
  { value: 'no_online_days', labelKey: 'riskRuleTypeNoOnlineDays' },
  { value: 'kd', labelKey: 'riskRuleTypeKd' },
  { value: 'kills', labelKey: 'riskRuleTypeKills' },
  { value: 'deaths', labelKey: 'riskRuleTypeDeaths' },
  { value: 'rockets', labelKey: 'riskRuleTypeRockets' }
];
const ACCOUNT_RISK_RULE_OPERATOR_OPTIONS = [
  { value: 'lt', labelKey: 'riskRuleOperatorLt' },
  { value: 'lte', labelKey: 'riskRuleOperatorLte' },
  { value: 'gt', labelKey: 'riskRuleOperatorGt' },
  { value: 'gte', labelKey: 'riskRuleOperatorGte' },
  { value: 'eq', labelKey: 'riskRuleOperatorEq' },
  { value: 'unavailable', labelKey: 'riskRuleOperatorUnavailable' },
  { value: 'is', labelKey: 'riskRuleOperatorIs' }
];
const DEFAULT_ACCOUNT_RISK_RULE_TITLE_KEYS = {
  'account-restricted': 'riskRuleDefaultAccountRestricted',
  'steam-ban-or-restriction': 'riskRuleDefaultSteamBanOrRestriction',
  'low-game-hours': 'riskRuleDefaultLowGameHours',
  'low-inventory': 'riskRuleDefaultLowInventory',
  'no-online-14d': 'riskRuleDefaultNoOnline14d',
  'unassigned-squad': 'riskRuleDefaultUnassignedSquad'
};
const DEFAULT_ACCOUNT_RISK_RULE_NAMES = {
  'account-restricted': new Set(['Steam 受限账号', 'Steam restricted account', 'Steam account restricted']),
  'steam-ban-or-restriction': new Set(['Steam 封禁或限制', 'Steam ban or restriction', 'Any Steam ban or restriction']),
  'low-game-hours': new Set(['游戏时长低于 500h', 'Game time below 500h']),
  'low-inventory': new Set(['库存价值低于 $50', 'Inventory value below $50']),
  'no-online-14d': new Set(['14 天无在线记录', 'No online record for 14 days']),
  'unassigned-squad': new Set(['未分配队伍', 'Unassigned squad'])
};

function defaultAccountRiskRules() {
  return [
    { id: 'account-restricted', name: 'Steam 受限账号', type: 'account_restricted', operator: 'is', threshold: 0, squadFilter: '', enabled: true },
    { id: 'steam-ban-or-restriction', name: 'Steam 封禁或限制', type: 'steam_ban_or_restriction', operator: 'is', threshold: 0, squadFilter: '', enabled: true },
    { id: 'low-game-hours', name: '游戏时长低于 500h', type: 'playtime_hours', operator: 'lt', threshold: 500, squadFilter: '', enabled: true },
    { id: 'low-inventory', name: '库存价值低于 $50', type: 'inventory_value', operator: 'lt', threshold: 50, squadFilter: '', enabled: true },
    { id: 'no-online-14d', name: '14 天无在线记录', type: 'no_online_days', operator: 'gte', threshold: 14, squadFilter: '', enabled: true },
    { id: 'unassigned-squad', name: '未分配队伍', type: 'unassigned_squad', operator: 'is', threshold: 0, squadFilter: '', enabled: false }
  ];
}

function requiredDefaultAccountRiskRules() {
  return defaultAccountRiskRules().filter((rule) => (
    rule.type === 'account_restricted' || rule.type === 'steam_ban_or_restriction'
  ));
}

function memberNotificationStorageKey(user) {
  return `nb-member-notifications:${user?.id || user?.username || 'default'}`;
}

function readMemberNotificationState(user) {
  try {
    const raw = localStorage.getItem(memberNotificationStorageKey(user));
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeMemberNotificationState(user, state) {
  try {
    localStorage.setItem(memberNotificationStorageKey(user), JSON.stringify(state || {}));
  } catch {
    // Local notification state is best-effort only.
  }
}

function notificationStatus(state, id) {
  const status = state?.[id]?.status;
  return status === 'read' || status === 'done' ? status : 'unread';
}

function daysSinceIso(value) {
  const time = Date.parse(value || '');
  if (!Number.isFinite(time)) return Infinity;
  return (Date.now() - time) / 86400000;
}

function notificationSortTime(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}

function memberNotificationName(member) {
  return member?.displayName || member?.customName || member?.steamNickname || member?.steamId || '-';
}

function accountAlertId(memberId, type) {
  return `${memberId}:${type}`;
}

function alertDismissalIdSet(dismissals = []) {
  return new Set((dismissals || []).map((item) => item.id).filter(Boolean));
}

function alertDismissedMemberIdSet(dismissals = []) {
  return new Set((dismissals || [])
    .filter((item) => item.type === PRIVATE_ACCOUNT_ALERT_TYPE)
    .map((item) => item.memberId)
    .filter(Boolean));
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function memberSignalNumbers(signals = {}) {
  const playTimeMinutes = finiteNumberOrNull(signals.playTimeMinutes);
  const onlineTimeMinutes = finiteNumberOrNull(signals.onlineTimeMinutes);
  const inventoryValue = finiteNumberOrNull(signals.inventoryValue);
  return {
    playTimeMinutes,
    onlineTimeMinutes,
    inventoryValue,
    hasKnownPlayTime: Boolean(signals.playTimeKnown) && playTimeMinutes !== null,
    hasKnownOnlineTime: Boolean(signals.onlineTimeKnown) && onlineTimeMinutes !== null,
    hasPublicInventoryValue: Boolean(signals.inventoryPublic) && inventoryValue !== null
  };
}

function accountRiskRulesOrDefault(rules = []) {
  const baseRules = Array.isArray(rules) && rules.length ? rules : defaultAccountRiskRules();
  const missingRequiredRules = requiredDefaultAccountRiskRules().filter((requiredRule) => (
    !baseRules.some((rule) => rule?.id === requiredRule.id || rule?.type === requiredRule.type)
  ));
  return missingRequiredRules.length ? [...missingRequiredRules, ...baseRules] : baseRules;
}

function highRiskRulesOnly(rules = []) {
  return accountRiskRulesOrDefault(rules)
    .filter((rule) => !PRIVATE_DATA_RISK_RULE_TYPES.has(rule?.type))
    .map(normalizeAccountRiskRule);
}

function accountRiskRuleTypeOption(type) {
  return ACCOUNT_RISK_RULE_TYPE_OPTIONS.find((item) => item.value === type) || ACCOUNT_RISK_RULE_TYPE_OPTIONS[0];
}

function accountRiskRuleOperatorOption(operator) {
  return ACCOUNT_RISK_RULE_OPERATOR_OPTIONS.find((item) => item.value === operator) || ACCOUNT_RISK_RULE_OPERATOR_OPTIONS[0];
}

function accountRiskOperatorOptionsForType(type) {
  if (type === 'account_restricted') {
    return [{ value: 'is', labelKey: 'riskRuleOperatorRestricted' }];
  }
  if (type === 'steam_ban_or_restriction') {
    return [{ value: 'is', labelKey: 'riskRuleOperatorDetected' }];
  }
  if (type === 'unassigned_squad') {
    return [{ value: 'is', labelKey: 'riskRuleOperatorUnassigned' }];
  }
  if (type === 'private_inventory' || type === 'private_playtime') {
    return ACCOUNT_RISK_RULE_OPERATOR_OPTIONS.filter((option) => option.value === 'unavailable');
  }
  return ACCOUNT_RISK_RULE_OPERATOR_OPTIONS.filter((option) => !['unavailable', 'is'].includes(option.value));
}

function accountRiskRuleNeedsThreshold(type) {
  return !['account_restricted', 'steam_ban_or_restriction', 'private_inventory', 'private_playtime', 'unassigned_squad'].includes(type);
}

function defaultAccountRiskOperator(type) {
  if (type === 'private_inventory' || type === 'private_playtime') return 'unavailable';
  if (type === 'account_restricted' || type === 'steam_ban_or_restriction' || type === 'unassigned_squad') return 'is';
  if (type === 'playtime_hours' || type === 'inventory_value') return 'lt';
  if (type === 'no_online_days') return 'gte';
  return 'gt';
}

function normalizeAccountRiskRule(rule = {}) {
  const type = accountRiskRuleTypeOption(rule.type).value;
  const operatorOptions = accountRiskOperatorOptionsForType(type);
  const operator = operatorOptions.some((option) => option.value === rule.operator)
    ? rule.operator
    : defaultAccountRiskOperator(type);
  return {
    id: rule.id || `risk_rule_${Date.now()}`,
    name: String(rule.name || '').trim() || type,
    type,
    operator,
    threshold: Number.isFinite(Number(rule.threshold)) ? Number(rule.threshold) : 0,
    squadFilter: rule.squadFilter || '',
    enabled: rule.enabled !== false
  };
}

function memberMatchesRiskSquadFilter(member, squadFilter = '') {
  if (!squadFilter) return true;
  if (squadFilter === ACCOUNT_RISK_UNASSIGNED_SQUAD_FILTER) return !member?.squadId;
  return member?.squadId === squadFilter;
}

function riskRuleAppliesToMember(rule, member, globalSquadFilter = '') {
  if (!rule?.enabled) return false;
  return memberMatchesRiskSquadFilter(member, globalSquadFilter)
    && memberMatchesRiskSquadFilter(member, rule.squadFilter || '');
}

function compareRiskValue(value, operator, threshold) {
  if (value === null || value === undefined || value === '') return false;
  if (threshold === null || threshold === undefined || threshold === '') return false;
  const left = Number(value);
  const right = Number(threshold);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  if (operator === 'lt') return left < right;
  if (operator === 'lte') return left <= right;
  if (operator === 'gt') return left > right;
  if (operator === 'gte') return left >= right;
  if (operator === 'eq') return left === right;
  return false;
}

function accountRiskRuleValue(rule, member) {
  const signals = member?.accountSignals || {};
  const officialKda = signals.officialKda || {};
  if (rule.type === 'playtime_hours') {
    const playTimeMinutes = finiteNumberOrNull(signals.playTimeMinutes);
    return Boolean(signals.playTimeKnown) && playTimeMinutes !== null ? playTimeMinutes / 60 : null;
  }
  if (rule.type === 'inventory_value') {
    const inventoryValue = finiteNumberOrNull(signals.inventoryValue);
    return Boolean(signals.inventoryPublic) && inventoryValue !== null ? inventoryValue : null;
  }
  if (rule.type === 'no_online_days') return daysSinceIso(signals.lastOnlineAt || '');
  if (rule.type === 'kd') return finiteNumberOrNull(officialKda.kda);
  if (rule.type === 'kills') return finiteNumberOrNull(officialKda.kills);
  if (rule.type === 'deaths') return finiteNumberOrNull(officialKda.deaths);
  if (rule.type === 'rockets') return finiteNumberOrNull(officialKda.rockets);
  return null;
}

function hasSteamBanOrRestriction(signals = {}) {
  const economyBan = String(signals.economyBan || 'none').trim().toLowerCase();
  return Boolean(signals.communityBanned)
    || Boolean(signals.economyRestricted)
    || (economyBan && economyBan !== 'none')
    || Boolean(signals.vacBanned)
    || Number(signals.numberOfVacBans || 0) > 0
    || Number(signals.numberOfGameBans || 0) > 0;
}

function accountRiskRuleMatches(rule, member) {
  if (rule.type === 'account_restricted') return Boolean(member?.accountSignals?.accountRestricted);
  if (rule.type === 'steam_ban_or_restriction') return hasSteamBanOrRestriction(member?.accountSignals || {});
  if (rule.type === 'private_inventory') return shouldShowPrivateInventoryAlert(member);
  if (rule.type === 'private_playtime') return shouldShowPrivatePlayTimeAlert(member);
  if (rule.type === 'unassigned_squad') return !member?.squadId;
  return compareRiskValue(accountRiskRuleValue(rule, member), rule.operator, rule.threshold);
}

function hasTrustedInventoryValue(signals = {}) {
  const { inventoryValue, hasPublicInventoryValue } = memberSignalNumbers(signals);
  return hasPublicInventoryValue && inventoryValue > MEMBER_NOTIFICATION_RULES.lowInventoryValue;
}

function hasTrustedGameTime(signals = {}) {
  const { playTimeMinutes, hasKnownPlayTime } = memberSignalNumbers(signals);
  return hasKnownPlayTime && playTimeMinutes > MEMBER_NOTIFICATION_RULES.trustedGameHours * 60;
}

function shouldShowPrivatePlayTimeAlert(member) {
  const signals = member?.accountSignals || {};
  const { hasKnownPlayTime } = memberSignalNumbers(signals);
  return !hasKnownPlayTime;
}

function shouldShowPrivateInventoryAlert(member) {
  const signals = member?.accountSignals || {};
  const { hasPublicInventoryValue } = memberSignalNumbers(signals);
  return !hasPublicInventoryValue;
}

function privateAccountAlertReasons(member) {
  const reasons = [];
  if (shouldShowPrivateInventoryAlert(member)) reasons.push(PRIVATE_INVENTORY_ALERT_TYPE);
  if (shouldShowPrivatePlayTimeAlert(member)) reasons.push(PRIVATE_PLAY_TIME_ALERT_TYPE);
  return reasons;
}

function shouldShowPrivateAccountAlert(member, dismissedIds = new Set()) {
  if (dismissedIds.has(accountAlertId(member.id, PRIVATE_ACCOUNT_ALERT_TYPE))) return false;
  return privateAccountAlertReasons(member).some((type) => !dismissedIds.has(accountAlertId(member.id, type)));
}

function shouldSuppressMemberRiskNotifications(member) {
  const signals = member?.accountSignals || {};
  const { inventoryValue, hasPublicInventoryValue } = memberSignalNumbers(signals);
  if (!signals.playTimeKnown && hasTrustedInventoryValue(signals)) return true;
  if (hasTrustedGameTime(signals) && (!signals.inventoryPublic || (hasPublicInventoryValue && inventoryValue <= 0))) return true;
  return false;
}

function pushMemberNotification(list, state, dismissedIds, item) {
  if (dismissedIds?.has(item.id)) return;
  const status = notificationStatus(state, item.id);
  if (status === 'done') return;
  list.push({ ...item, status });
}

function defaultAccountRiskRuleTitleKey(rule = {}) {
  const id = String(rule.id || '').trim();
  const titleKey = DEFAULT_ACCOUNT_RISK_RULE_TITLE_KEYS[id];
  if (!titleKey) return '';
  const name = String(rule.name || '').trim();
  if (!name || name === rule.type || DEFAULT_ACCOUNT_RISK_RULE_NAMES[id]?.has(name)) return titleKey;
  return '';
}

function accountRiskRuleTitle(rule, t) {
  const defaultTitleKey = defaultAccountRiskRuleTitleKey(rule);
  if (defaultTitleKey) return t(defaultTitleKey);
  return rule.name || t(accountRiskRuleTypeOption(rule.type).labelKey);
}

function accountRiskRuleDetail(rule, member, t, lang, currencyContext = null) {
  const name = memberNotificationName(member);
  if (rule.type === 'account_restricted') return t('riskRuleAccountRestrictedDetail').replace('{name}', name);
  if (rule.type === 'steam_ban_or_restriction') return t('riskRuleSteamBanOrRestrictionDetail').replace('{name}', name);
  if (rule.type === 'private_inventory') return t('riskRulePrivateInventoryDetail').replace('{name}', name);
  if (rule.type === 'private_playtime') return t('riskRulePrivatePlayTimeDetail').replace('{name}', name);
  if (rule.type === 'unassigned_squad') return t('riskRuleUnassignedSquadDetail').replace('{name}', name);
  const value = accountRiskRuleValue(rule, member);
  const threshold = Number(rule.threshold || 0);
  const operatorText = t(accountRiskRuleOperatorOption(rule.operator).labelKey);
  let formattedValue = formatStatNumber(value, lang, { maximumFractionDigits: 2 });
  let formattedThreshold = formatStatNumber(threshold, lang, { maximumFractionDigits: 2 });
  if (rule.type === 'playtime_hours') {
    formattedValue = formatPlayTimeMinutes(Number(value || 0) * 60, lang);
    formattedThreshold = formatPlayTimeMinutes(threshold * 60, lang);
  } else if (rule.type === 'inventory_value') {
    formattedValue = formatCurrencyValue(value, member?.accountSignals?.inventoryCurrency || 'USD', lang, currencyContext);
    formattedThreshold = formatCurrencyValue(threshold, member?.accountSignals?.inventoryCurrency || 'USD', lang, currencyContext);
  }
  return formatCopy(t('riskRuleThresholdDetail'), {
    name,
    metric: t(accountRiskRuleTypeOption(rule.type).labelKey),
    operator: operatorText,
    value: formattedValue,
    threshold: formattedThreshold
  });
}

function buildMemberNotifications(members, t, lang, state = {}, dismissedIds = new Set(), currencyContext = null, rules = [], squadFilter = '') {
  const items = [];
  const activeRules = highRiskRulesOnly(rules).filter((rule) => rule.enabled);
  (members || []).forEach((member) => {
    activeRules.forEach((rule) => {
      if (!riskRuleAppliesToMember(rule, member, squadFilter)) return;
      if (!accountRiskRuleMatches(rule, member)) return;
      pushMemberNotification(items, state, dismissedIds, {
        id: accountAlertId(member.id, rule.id || rule.type),
        memberId: member.id,
        member,
        memberName: memberNotificationName(member),
        title: accountRiskRuleTitle(rule, t),
        detail: accountRiskRuleDetail(rule, member, t, lang, currencyContext),
        createdAt: member.accountSignals?.fetchedAt || member.accountSignals?.onlineSyncedAt || member.updatedAt || member.createdAt || ''
      });
    });
  });
  return items.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'unread' ? -1 : 1;
    return notificationSortTime(b.createdAt) - notificationSortTime(a.createdAt);
  });
}

export {
  ACCOUNT_RISK_RULE_TYPE_OPTIONS,
  ACCOUNT_RISK_UNASSIGNED_SQUAD_FILTER,
  PRIVATE_ACCOUNT_ALERT_TYPE,
  PRIVATE_INVENTORY_ALERT_TYPE,
  PRIVATE_PLAY_TIME_ALERT_TYPE,
  accountAlertId,
  accountRiskOperatorOptionsForType,
  accountRiskRuleMatches,
  accountRiskRuleNeedsThreshold,
  accountRiskRuleOperatorOption,
  accountRiskRuleTitle,
  accountRiskRuleTypeOption,
  accountRiskRulesOrDefault,
  alertDismissalIdSet,
  alertDismissedMemberIdSet,
  buildMemberNotifications,
  defaultAccountRiskOperator,
  defaultAccountRiskRules,
  highRiskRulesOnly,
  memberMatchesRiskSquadFilter,
  memberNotificationName,
  normalizeAccountRiskRule,
  readMemberNotificationState,
  riskRuleAppliesToMember,
  shouldShowPrivateInventoryAlert,
  shouldShowPrivatePlayTimeAlert,
  writeMemberNotificationState
};
