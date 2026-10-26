import { normalizeText, nowIso } from './store.js';

export const SYNC_AUTO_RULE_TYPES = new Set(['battlemetrics_identity', 'battlemetrics_playtime', 'kda', 'member_profile']);
export const SYNC_AUTO_RULE_SCOPES = new Set(['current_wipe', 'all_members', 'missing_only', 'custom']);
export const SYNC_AUTO_RULE_MIN_INTERVAL_MINUTES = 5;
export const SYNC_AUTO_RULE_MAX_INTERVAL_MINUTES = 7 * 24 * 60;

function timestampForSort(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}

function intervalMinutesFromMs(value, fallbackMs) {
  const ms = Number(value || fallbackMs);
  return Math.max(SYNC_AUTO_RULE_MIN_INTERVAL_MINUTES, Math.round(ms / 60_000));
}

export function syncAutoRuleRuntimeDefaults(type, options = {}) {
  if (type === 'kda') {
    return {
      intervalMinutes: intervalMinutesFromMs(options.kdaAutoSyncIntervalMs, 60 * 60 * 1000),
      scope: 'current_wipe'
    };
  }
  if (type === 'battlemetrics_playtime') {
    return {
      intervalMinutes: intervalMinutesFromMs(options.battlemetricsMemberSyncIntervalMs, 60 * 60 * 1000),
      scope: 'current_wipe'
    };
  }
  if (type === 'member_profile') {
    return {
      intervalMinutes: intervalMinutesFromMs(options.memberProfileSyncIntervalMs, 24 * 60 * 60 * 1000),
      scope: 'all_members'
    };
  }
  return { intervalMinutes: 60, scope: 'custom' };
}

export function ensureSyncAutoRules(store) {
  store.syncAutoRules ||= [];
  return store.syncAutoRules;
}

export function syncAutoRuleTypeLabel(type) {
  if (type === 'battlemetrics_identity') return 'BM ID 自动匹配';
  if (type === 'battlemetrics_playtime') return 'BM 在线时间自动同步';
  if (type === 'kda') return 'KDA 自动同步';
  if (type === 'member_profile') return '成员资料自动同步';
  return type || '自动任务';
}

export function nextSyncAutoRuleRunAt(rule = {}, intervalMinutes = 60) {
  if (rule.enabled === false) return '';
  const lastRunAtMs = Date.parse(rule.lastRunAt || rule.updatedAt || rule.createdAt || '');
  if (!Number.isFinite(lastRunAtMs)) return '';
  return new Date(lastRunAtMs + intervalMinutes * 60_000).toISOString();
}

export function publicSyncAutoRule(rule = {}, options = {}) {
  const type = SYNC_AUTO_RULE_TYPES.has(rule.type) ? rule.type : 'member_profile';
  const defaults = syncAutoRuleRuntimeDefaults(type, options);
  const intervalMinutes = Math.max(
    SYNC_AUTO_RULE_MIN_INTERVAL_MINUTES,
    Math.min(SYNC_AUTO_RULE_MAX_INTERVAL_MINUTES, Number(rule.intervalMinutes || defaults.intervalMinutes || 60))
  );
  const scope = SYNC_AUTO_RULE_SCOPES.has(rule.scope) ? rule.scope : defaults.scope;
  return {
    id: rule.id || '',
    name: normalizeText(rule.name, 120) || syncAutoRuleTypeLabel(type),
    type,
    enabled: rule.enabled !== false,
    intervalMinutes,
    scope,
    notes: normalizeText(rule.notes, 500),
    lastRunAt: rule.lastRunAt || '',
    nextRunAt: nextSyncAutoRuleRunAt(rule, intervalMinutes),
    createdAt: rule.createdAt || '',
    updatedAt: rule.updatedAt || ''
  };
}

export function syncAutoRulesPayload(store, options = {}) {
  const rules = ensureSyncAutoRules(store)
    .map((rule) => publicSyncAutoRule(rule, options))
    .toSorted((left, right) => timestampForSort(left.createdAt) - timestampForSort(right.createdAt));
  return {
    rules,
    options: {
      types: [...SYNC_AUTO_RULE_TYPES].map((type) => ({ value: type, label: syncAutoRuleTypeLabel(type) })),
      scopes: [
        { value: 'current_wipe', label: '当前档期' },
        { value: 'all_members', label: '全部成员' },
        { value: 'missing_only', label: '仅缺失数据' },
        { value: 'custom', label: '自定义' }
      ],
      minIntervalMinutes: SYNC_AUTO_RULE_MIN_INTERVAL_MINUTES,
      maxIntervalMinutes: SYNC_AUTO_RULE_MAX_INTERVAL_MINUTES
    },
    updatedAt: nowIso()
  };
}

export function normalizeSyncAutoRuleInput(body = {}, existing = null, options = {}) {
  const type = normalizeText(body.type || existing?.type, 80);
  if (!SYNC_AUTO_RULE_TYPES.has(type)) {
    throw Object.assign(new Error('自动任务类型无效'), { status: 400 });
  }
  const defaults = syncAutoRuleRuntimeDefaults(type, options);
  const rawInterval = Number(body.intervalMinutes ?? existing?.intervalMinutes ?? defaults.intervalMinutes);
  if (!Number.isFinite(rawInterval)) {
    throw Object.assign(new Error('自动任务间隔无效'), { status: 400 });
  }
  const intervalMinutes = Math.round(rawInterval);
  if (intervalMinutes < SYNC_AUTO_RULE_MIN_INTERVAL_MINUTES || intervalMinutes > SYNC_AUTO_RULE_MAX_INTERVAL_MINUTES) {
    throw Object.assign(new Error(`自动任务间隔需要在 ${SYNC_AUTO_RULE_MIN_INTERVAL_MINUTES}-${SYNC_AUTO_RULE_MAX_INTERVAL_MINUTES} 分钟之间`), { status: 400 });
  }
  const scope = normalizeText(body.scope || existing?.scope || defaults.scope, 80);
  if (!SYNC_AUTO_RULE_SCOPES.has(scope)) {
    throw Object.assign(new Error('自动任务范围无效'), { status: 400 });
  }
  return {
    name: normalizeText(body.name || existing?.name || syncAutoRuleTypeLabel(type), 120),
    type,
    enabled: Object.hasOwn(body, 'enabled') ? Boolean(body.enabled) : existing?.enabled !== false,
    intervalMinutes,
    scope,
    notes: normalizeText(body.notes ?? existing?.notes, 500)
  };
}

export function syncAutoRuleDue(rule = {}, nowMs = Date.now(), options = {}) {
  const publicRule = publicSyncAutoRule(rule, options);
  if (!publicRule.enabled) return false;
  if (!publicRule.lastRunAt) return true;
  const lastRunAtMs = Date.parse(publicRule.lastRunAt);
  return !Number.isFinite(lastRunAtMs) || nowMs - lastRunAtMs >= publicRule.intervalMinutes * 60_000;
}
