import React, { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import {
  LOG_ACCESS_TYPES,
  LOG_SYNC_TYPES,
  LOG_SYSTEM_TYPES,
  LOG_TYPE_GROUPS,
  LOG_TYPE_KEYS
} from '../../shared/app-constants.js';
import { api } from '../../shared/api.js';
import {
  datetimeLocalToIso,
  displayDataValue,
  formatCopy,
  formatStatNumber,
  formatTime,
  localizeError,
  startOfLocalDayInputValue
} from '../../shared/format.js';
import { Alert } from '../../shared/ui/Alert.jsx';
import { DataTable } from '../../shared/ui/DataTable.jsx';
import { PageLoadingState } from '../../shared/ui/PageLoadingState.jsx';
import { cx } from '../../shared/ui/cx.js';

function extractAfter(summary, prefix) {
  const text = String(summary || '');
  return text.startsWith(prefix) ? text.slice(prefix.length).trim() : '';
}

function localizedLogSummary(log, t) {
  const summary = String(log.summary || '');
  const actor = displayDataValue(log.actorUsername, t);
  const steamId = log.steamId || extractAfter(summary, '查询 SteamID ') || '-';

  if (log.type === 'login') {
    return formatCopy(t('logUserLogin'), { user: actor });
  }
  if (log.type === 'login_failed') {
    const account = extractAfter(summary, '登录失败：');
    return formatCopy(t('logLoginFailed'), {
      account: account === '空账号' ? t('errorEmptyAccount') : displayDataValue(account, t)
    });
  }
  if (log.type === 'query') {
    return formatCopy(t('logQuerySteam'), { steamId });
  }
  if (log.type === 'query_failed') {
    return formatCopy(t('logQueryFailed'), { message: localizeError(summary, t) });
  }
  if (log.type === 'member_add') {
    return formatCopy(t('logMemberAdd'), { name: extractAfter(summary, '添加成员 ') || log.targetId || '-' });
  }
  if (log.type === 'member_bulk_add') {
    const count = log.metadata?.imported || extractAfter(summary, '批量导入成员 ').replace(/\D+/g, '') || '-';
    return formatCopy(t('logMemberBulkAdd'), { count });
  }
  if (log.type === 'member_edit') {
    return formatCopy(t('logMemberEdit'), { name: extractAfter(summary, '编辑成员 ') || log.targetId || '-' });
  }
  if (log.type === 'member_delete') {
    return formatCopy(t('logMemberDelete'), { name: extractAfter(summary, '删除成员 ') || log.targetId || '-' });
  }
  if (log.type === 'member_bulk_delete') {
    const count = log.metadata?.deleted || extractAfter(summary, '批量删除成员 ').replace(/\D+/g, '') || '-';
    return formatCopy(t('logMemberBulkDelete'), { count });
  }
  if (log.type === 'user_add') {
    return formatCopy(t('logUserAdd'), { account: extractAfter(summary, '创建账号 ') || log.targetId || '-' });
  }
  if (log.type === 'user_edit') {
    return formatCopy(t('logUserEdit'), { account: extractAfter(summary, '编辑账号 ') || log.targetId || '-' });
  }
  if (log.type === 'user_delete') {
    return formatCopy(t('logUserDelete'), { account: extractAfter(summary, '删除账号 ') || log.targetId || '-' });
  }
  if (log.type === 'profile_edit') {
    return formatCopy(t('logProfileSteam'), { steamId: log.steamId || t('unbound') });
  }
  if (log.type === 'password_change') {
    return t('logPasswordChange');
  }
  if (LOG_TYPE_KEYS[log.type]) {
    return labelForLogType(log.type, t);
  }
  return localizeError(summary, t);
}

function logTypeGroupFor(type = '') {
  const normalized = String(type || '').trim();
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

function humanizeLogType(type = '') {
  return String(type || '')
    .split('_')
    .filter(Boolean)
    .map((part) => {
      if (part === 'api') return 'API';
      if (part === 'kda') return 'KDA';
      if (part === 'bm') return 'BM';
      if (part === 'id') return 'ID';
      if (part === 'vip') return 'VIP';
      if (part === 'kook') return 'KOOK';
      if (part === 'wechat') return 'WeChat';
      if (part === 'discord') return 'Discord';
      return part.slice(0, 1).toUpperCase() + part.slice(1);
    })
    .join(' ') || type;
}

function labelForLogType(type, t) {
  const key = LOG_TYPE_KEYS[type];
  return key ? t(key) : humanizeLogType(type);
}

function logTypeGroupLabel(groupId, t) {
  const group = LOG_TYPE_GROUPS.find((item) => item.id === groupId);
  return group ? t(group.labelKey) : t('logTypeGroupOther');
}

function logTypeOptionsForGroup(logTypes = [], groupId = '') {
  return [...new Set(logTypes)]
    .filter((type) => !groupId || logTypeGroupFor(type) === groupId)
    .sort((left, right) => left.localeCompare(right));
}

function logTypeGroupsForTypes(logTypes = []) {
  const present = new Set(logTypes.map(logTypeGroupFor));
  return LOG_TYPE_GROUPS.filter((group) => present.has(group.id));
}

function formatLogRangeLabel(range, lang, t) {
  const from = formatTime(range?.from, lang);
  const to = formatTime(range?.to, lang);
  if (!from && !to) return '-';
  return formatCopy(t('logRangeLabel'), {
    from: from || '-',
    to: to || t('logRangeNow')
  });
}

function TypeBadge({ type, t }) {
  return <span className={cx('type-badge', type)}>{labelForLogType(type, t)}</span>;
}

export default function LogsView({ lang, t }) {
  const [logs, setLogs] = useState([]);
  const [logTypes, setLogTypes] = useState([]);
  const [filters, setFilters] = useState({
    q: '',
    typeGroup: '',
    type: '',
    from: startOfLocalDayInputValue(),
    to: ''
  });
  const [logMeta, setLogMeta] = useState({ total: 0, limit: 300, range: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function load(nextFilters = filters) {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (nextFilters.q) params.set('q', nextFilters.q);
      if (nextFilters.type) params.set('type', nextFilters.type);
      if (!nextFilters.type && nextFilters.typeGroup) params.set('typeGroup', nextFilters.typeGroup);
      const fromIso = datetimeLocalToIso(nextFilters.from);
      const toIso = datetimeLocalToIso(nextFilters.to);
      if (fromIso) params.set('from', fromIso);
      if (toIso) params.set('to', toIso);
      const payload = await api(`/api/logs${params.toString() ? `?${params}` : ''}`);
      setLogs(payload.logs);
      setLogTypes(payload.logTypes || []);
      setLogMeta({
        total: Number(payload.total || 0),
        limit: Number(payload.limit || 300),
        range: payload.range || null
      });
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const logResultValues = {
    range: formatLogRangeLabel(logMeta.range, lang, t),
    shown: formatStatNumber(logs.length, lang),
    total: formatStatNumber(logMeta.total, lang),
    limit: formatStatNumber(logMeta.limit, lang)
  };
  const logTypeGroups = useMemo(() => logTypeGroupsForTypes(logTypes), [logTypes]);
  const visibleLogTypes = useMemo(() => (
    filters.typeGroup ? logTypeOptionsForGroup(logTypes, filters.typeGroup) : []
  ), [filters.typeGroup, logTypes]);
  const logTableColumns = useMemo(() => [t('time'), t('type'), t('user'), t('ip'), t('steamId'), t('content')], [t]);
  const logTableRows = useMemo(() => logs.map((log) => (
    <tr key={log.id}>
      <td>{formatTime(log.createdAt, lang)}</td>
      <td><TypeBadge type={log.type} t={t} /></td>
      <td>{displayDataValue(log.actorUsername, t)}</td>
      <td className="mono break-cell">{log.ip}</td>
      <td className="mono break-cell">{log.steamId || '-'}</td>
      <td className="break-cell">{localizedLogSummary(log, t)}</td>
    </tr>
  )), [lang, logs, t]);

  return (
    <section className="page-stack">
      <div className="section-heading">
        <h3>{t('logsTitle')}</h3>
        <button className="ghost-button" onClick={() => load()}>
          <RefreshCw size={17} />
          {t('refresh')}
        </button>
      </div>
      <form className="tool-panel log-filters" onSubmit={(event) => { event.preventDefault(); load(); }}>
        <label className="log-query-field">
          <span>{t('query')}</span>
          <input
            value={filters.q}
            onChange={(event) => setFilters({ ...filters, q: event.target.value })}
            placeholder={t('searchLogs')}
          />
        </label>
        <label className="log-time-field">
          <span>{t('logStartTime')}</span>
          <input
            type="datetime-local"
            value={filters.from}
            onChange={(event) => {
              const nextFilters = { ...filters, from: event.target.value };
              setFilters(nextFilters);
              load(nextFilters);
            }}
          />
        </label>
        <label className="log-time-field">
          <span>{t('logEndTime')}</span>
          <input
            type="datetime-local"
            value={filters.to}
            onChange={(event) => {
              const nextFilters = { ...filters, to: event.target.value };
              setFilters(nextFilters);
              load(nextFilters);
            }}
          />
        </label>
        <button className="primary-button align-end log-submit-button" title={t('query')}>
          <Search size={17} />
          <span>{t('queryShort')}</span>
        </button>
        <label className="log-type-field">
          <span>{t('logTypeCategory')}</span>
          <select value={filters.typeGroup} onChange={(event) => {
            const nextFilters = { ...filters, typeGroup: event.target.value, type: '' };
            setFilters(nextFilters);
            load(nextFilters);
          }}>
            <option value="">{t('allTypes')}</option>
            {logTypeGroups.map((group) => (
              <option key={group.id} value={group.id}>{logTypeGroupLabel(group.id, t)}</option>
            ))}
          </select>
        </label>
        <label className="log-type-field">
          <span>{t('logSpecificType')}</span>
          <select value={filters.type} disabled={!filters.typeGroup || visibleLogTypes.length === 0} onChange={(event) => {
            const nextFilters = { ...filters, type: event.target.value };
            setFilters(nextFilters);
            load(nextFilters);
          }}>
            <option value="">{filters.typeGroup ? t('allSpecificTypes') : t('selectLogTypeGroupFirst')}</option>
            {visibleLogTypes.map((type) => (
              <option key={type} value={type}>{labelForLogType(type, t)}</option>
            ))}
          </select>
        </label>
        <p className="form-hint log-filter-hint">{t('logDateHint')}</p>
      </form>
      <p className="table-meta">{formatCopy(t('logResultMeta'), logResultValues)}</p>
      {error && <Alert tone="danger">{error}</Alert>}
      {loading ? (
        <PageLoadingState title={t('logsTitle')} t={t} compact />
      ) : (
        <DataTable columns={logTableColumns} emptyText={t('noLogs')}>{logTableRows}</DataTable>
      )}
    </section>
  );
}
