import { readLogListStore } from './audit-logs.js';
import { parseLogDateRange } from './log-date-range.js';

const LOG_DEFAULT_LIMIT = 300;
const LOG_MAX_LIMIT = 300;
const LOG_TYPE_GROUP_IDS = ['access', 'members', 'squads', 'wipes', 'sync', 'integrations', 'wechat', 'system'];
const LOG_ACCESS_TYPES = new Set(['login', 'login_failed', 'query', 'query_failed', 'public_api_query']);
const LOG_SYNC_TYPES = new Set([
  'battlemetrics_playtime_sync',
  'battlemetrics_id_refresh',
  'kda_sync',
  'member_profile_sync',
  'member_profile_sync_cancel',
  'sync_job_delete',
  'sync_auto_rule_add',
  'sync_auto_rule_edit',
  'sync_auto_rule_delete',
  'wechat_admin_kda_sync',
  'wechat_admin_playtime_sync'
]);
const LOG_SYSTEM_TYPES = new Set([
  'system_settings_edit',
  'third_party_login_settings_edit',
  'public_api_token_edit',
  'battlemetrics_api_key_edit',
  'steam_web_api_key_edit',
  'export'
]);

function sendOk(res, data = {}) {
  res.json({ ok: true, ...data });
}

function requiredDependency(name, value) {
  if (typeof value !== 'function') {
    throw new TypeError(`registerLogRoutes requires ${name}`);
  }
  return value;
}

export function logTypeGroupFor(type = '', normalizeText = (value) => String(value || '').trim()) {
  const normalized = normalizeText(type, 80);
  if (!normalized) return 'other';
  if (LOG_ACCESS_TYPES.has(normalized)) return 'access';
  if (LOG_SYNC_TYPES.has(normalized) || normalized.startsWith('sync_')) return 'sync';
  if (normalized.startsWith('discord_') || normalized.startsWith('kook_') || normalized.startsWith('rustplus_')) return 'integrations';
  if (normalized.startsWith('wechat_') || normalized.startsWith('member_bind_request_')) return 'wechat';
  if (normalized.startsWith('squad_')) return 'squads';
  if (normalized.startsWith('wipe_')) return 'wipes';
  if (normalized.startsWith('member_') || normalized.startsWith('join_application_') || normalized.startsWith('account_') || normalized === 'battlemetrics_id_edit') return 'members';
  if (normalized.startsWith('user_') || normalized.startsWith('permission_role_') || LOG_SYSTEM_TYPES.has(normalized)) return 'system';
  return 'other';
}

export function normalizeLogTypeGroup(value = '', normalizeText = (input) => String(input || '').trim()) {
  const group = normalizeText(value, 40);
  if (group === 'other') return group;
  return LOG_TYPE_GROUP_IDS.includes(group) ? group : '';
}

export function logLimitFromQuery(query = {}) {
  const limit = Math.floor(Number(query.limit || LOG_DEFAULT_LIMIT));
  if (!Number.isFinite(limit) || limit <= 0) return LOG_DEFAULT_LIMIT;
  return Math.min(LOG_MAX_LIMIT, limit);
}

export function registerLogRoutes(router, {
  requireModuleView,
  normalizeText,
  expandVitalRustName,
  timestampForSort
} = {}) {
  const requireLogView = requiredDependency('requireModuleView', requireModuleView)('logs');
  const cleanText = requiredDependency('normalizeText', normalizeText);
  const expandServerName = requiredDependency('expandVitalRustName', expandVitalRustName);
  const toTimestamp = requiredDependency('timestampForSort', timestampForSort);

  router.get('/logs', requireLogView, async (req, res, next) => {
    try {
      const store = await readLogListStore();
      const q = cleanText(req.query?.q, 120).toLowerCase();
      const type = cleanText(req.query?.type, 80);
      const typeGroup = normalizeLogTypeGroup(req.query?.typeGroup || req.query?.type_group, cleanText);
      const limit = logLimitFromQuery(req.query);
      const range = parseLogDateRange(req.query);
      const publicLogs = store.logs.map((log) => ({
        ...log,
        summary: expandServerName(log.summary)
      }));
      const filteredLogs = publicLogs
        .filter((log) => {
          const createdMs = toTimestamp(log.createdAt);
          return createdMs >= range.fromMs && createdMs < range.toMs;
        })
        .filter((log) => !type || log.type === type)
        .filter((log) => type || !typeGroup || logTypeGroupFor(log.type, cleanText) === typeGroup)
        .filter((log) => {
          if (!q) return true;
          return [
            log.type,
            log.actorUsername,
            log.ip,
            log.steamId,
            log.summary
          ].some((value) => String(value || '').toLowerCase().includes(q));
        });
      const logs = filteredLogs.slice(0, limit);
      const logTypes = [...new Set(store.logs.map((log) => log.type))].sort();
      const logTypeGroups = [...new Set(logTypes.map((typeValue) => logTypeGroupFor(typeValue, cleanText)))].sort();
      sendOk(res, {
        logs,
        logTypes,
        logTypeGroups,
        total: filteredLogs.length,
        limit,
        range: {
          from: range.from,
          to: range.to
        }
      });
    } catch (error) {
      next(error);
    }
  });
}
