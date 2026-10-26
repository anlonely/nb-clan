import React, { useEffect, useMemo, useState } from 'react';
import {
  BadgeCheck,
  BarChart3,
  Cat,
  Database,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  ScrollText,
  Server,
  Settings,
  Square,
  Trash2,
  UserRound,
  X
} from 'lucide-react';
import { api } from '../../shared/api.js';
import {
  formatApiError,
  formatCopy,
  formatPlayTimeMinutes,
  formatStatNumber,
  formatTime,
  localizeError
} from '../../shared/format.js';
import { Alert } from '../../shared/ui/Alert.jsx';
import { ModalFrame } from '../../shared/ui/ModalFrame.jsx';
import { PageLoadingState } from '../../shared/ui/PageLoadingState.jsx';
import { cx } from '../../shared/ui/cx.js';

const HEXAYTRON_FEATURE_ENABLED = ['1', 'true', 'yes', 'on', 'enabled'].includes(String(import.meta.env.VITE_ENABLE_HEXAYTRON || '').trim().toLowerCase());

function secondsUntil(value) {
  const ms = Date.parse(value || '');
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.ceil((ms - Date.now()) / 1000));
}

function queueSourceLabel(source, t) {
  const labels = {
    'manual-query': t('bmQueueManualQuery'),
    'manual-sync': t('bmQueueManualSync'),
    'hourly-sync': t('bmQueueAutoSync'),
    system: t('bmQueueSystem')
  };
  return labels[source] || t('bmQueueSystem');
}

function queueOperationLabel(operation, t) {
  const labels = {
    member_query: t('bmQueueOpMemberQuery'),
    manual_sync: t('bmQueueOpManualSync'),
    hourly_sync: t('bmQueueOpHourlySync'),
    match_players: t('bmQueueOpMatchPlayers'),
    match_player: t('bmQueueOpMatchPlayers'),
    player_sessions: t('bmQueueOpSessions'),
    player_server: t('bmQueueOpServer'),
    refresh_battlemetrics_id: t('bmQueueOpRefreshId'),
    request: t('bmQueueOpRequest')
  };
  return labels[operation] || t('bmQueueOpRequest');
}

function percentOf(value, total) {
  const numeric = Number(value || 0);
  const denominator = Number(total || 0);
  if (!denominator) return 0;
  return Math.max(0, Math.min(100, Math.round((numeric / denominator) * 100)));
}

function BattlemetricsQueuePanel({ queue, lang, t }) {
  const limits = queue?.limits || {};
  const active = queue?.active || null;
  const pendingCount = Number(queue?.pendingCount || 0);
  const waitSeconds = Math.max(
    Number(limits.nextAvailableInSeconds || 0),
    secondsUntil(limits.rateLimitedUntil),
    secondsUntil(limits.blockedUntil)
  );
  const statusLabel = active
    ? t('bmQueueRunning')
    : pendingCount
      ? t('bmQueueWaiting')
      : t('bmQueueIdle');
  const isLimited = Boolean(limits.rateLimitedUntil || limits.blockedUntil || waitSeconds > 0);
  const queueRows = [
    [t('bmQueueManualQuery'), queue?.pendingBySource?.manualQuery || 0],
    [t('bmQueueManualSync'), queue?.pendingBySource?.manualSync || 0],
    [t('bmQueueAutoSync'), queue?.pendingBySource?.hourlySync || 0]
  ];
  const quotaRows = [
    {
      label: t('bmQueueGlobalQuota'),
      used: limits.globalUsed || 0,
      total: limits.globalPerMinute || 0
    },
    {
      label: t('bmQueueAutoQuota'),
      used: limits.autoUsed || 0,
      total: limits.autoPerMinute || 0
    }
  ];
  return (
    <div className="bm-queue-panel span-2">
      <div className="bm-queue-header">
        <div>
          <h3>{t('bmQueueTitle')}</h3>
          <p>{t('bmQueueHint')}</p>
        </div>
        <span className={cx('status-badge', active && 'active', isLimited && 'pending')}>
          {isLimited ? t('bmQueueCooling') : statusLabel}
        </span>
      </div>

      <div className="bm-queue-main">
        <div className="bm-queue-task">
          <span>{t('bmQueueCurrentTask')}</span>
          <strong>{active ? queueSourceLabel(active.source, t) : t('bmQueueNoTask')}</strong>
          {active && <small>{queueOperationLabel(active.operation, t)}</small>}
          {active?.startedAt && <small>{t('startedAt')}: {formatTime(active.startedAt, lang)}</small>}
        </div>
        <div className="bm-queue-task">
          <span>{t('bmQueueNextSlot')}</span>
          <strong>{waitSeconds ? formatCopy(t('bmQueueSeconds'), { seconds: formatStatNumber(waitSeconds, lang) }) : t('bmQueueReady')}</strong>
          <small>{t('bmQueueManualReserve')}: {formatStatNumber(limits.manualReservePerMinute || 0, lang)}/min</small>
        </div>
        <div className="bm-queue-task">
          <span>{t('bmQueueTotals')}</span>
          <strong>{formatStatNumber(queue?.totals?.completed || 0, lang)} / {formatStatNumber(queue?.totals?.failed || 0, lang)}</strong>
          <small>{t('bmQueueCompleted')} / {t('bmQueueFailed')}</small>
        </div>
      </div>

      <div className="bm-queue-metrics">
        <div className="bm-queue-metric">
          <span>{t('bmQueuePending')}</span>
          <strong>{formatStatNumber(pendingCount, lang)}</strong>
          <div className="bm-queue-breakdown">
            {queueRows.map(([label, value]) => (
              <small key={label}>{label}: {formatStatNumber(value, lang)}</small>
            ))}
          </div>
        </div>
        {quotaRows.map((row) => (
          <div className="bm-queue-metric" key={row.label}>
            <span>{row.label}</span>
            <strong>{formatStatNumber(row.used, lang)} / {formatStatNumber(row.total, lang)}</strong>
            <div className="bm-queue-quota-track" aria-hidden="true">
              <i style={{ width: `${percentOf(row.used, row.total)}%` }} />
            </div>
          </div>
        ))}
      </div>

      <div className="bm-queue-footer">
        <span>{t('bmQueueUpdatedAt')}: {formatTime(queue?.updatedAt, lang) || '-'}</span>
        {queue?.lastCompleted && (
          <span>{t('bmQueueLastDone')}: {queueSourceLabel(queue.lastCompleted.source, t)} · {formatTime(queue.lastCompleted.completedAt, lang)}</span>
        )}
        {queue?.lastFailed && (
          <span className="danger-text">{t('bmQueueLastFailed')}: {queue.lastFailed.error || '-'}</span>
        )}
      </div>
    </div>
  );
}

function syncJobTypeLabel(type, t) {
  if (type === 'battlemetrics_identity') return t('syncJobBattlemetricsIdentity');
  if (type === 'battlemetrics_playtime') return t('syncJobBattlemetricsPlaytime');
  if (type === 'kda') return t('syncJobKda');
  if (type === 'hexaytron_profile') return t('syncJobHexaytronProfile');
  if (type === 'member_profile') return t('syncJobMemberProfile');
  if (type === 'steam_profile_backfill') return t('syncJobSteamProfile');
  return t('syncJobLocalConsistency');
}

function syncJobStatusLabel(status, t) {
  if (status === 'queued') return t('syncJobQueued');
  if (status === 'running') return t('syncJobRunning');
  if (status === 'completed') return t('syncJobCompleted');
  if (status === 'partial_failed') return t('syncJobPartialFailed');
  if (status === 'failed') return t('syncJobFailed');
  if (status === 'cancelled') return t('syncJobCancelled');
  return status || '-';
}

function syncJobSourceLabel(source, t) {
  if (source === 'auto') return t('syncJobAuto');
  if (source === 'compensation') return t('syncJobCompensation');
  return t('syncJobManual');
}

const CONTINUABLE_SYNC_JOB_TYPES = new Set([
  'battlemetrics_identity',
  'battlemetrics_playtime',
  'kda',
  'hexaytron_profile',
  'member_profile'
]);

function canContinueSyncJob(job = {}) {
  if (!HEXAYTRON_FEATURE_ENABLED && job?.type === 'hexaytron_profile') return false;
  return CONTINUABLE_SYNC_JOB_TYPES.has(job?.type) && !['queued', 'running'].includes(job?.status);
}

function isEmptyCompletedSyncJob(job = {}) {
  return (
    job?.status === 'completed' &&
    Number(job?.totalCount || 0) === 0 &&
    Number(job?.doneCount || 0) === 0 &&
    Number(job?.failedCount || 0) === 0 &&
    Number(job?.skippedCount || 0) === 0
  );
}

function syncJobFailureItems(job = {}, t) {
  const items = Array.isArray(job?.details?.failedItems) ? job.details.failedItems : [];
  const normalized = items
    .map((item) => ({
      memberId: item?.memberId || '',
      steamId: item?.steamId || '',
      displayName: item?.displayName || item?.steamId || '-',
      message: localizeError(item?.message || job?.errorSummary || t('requestFailed'), t),
      occurredAt: item?.occurredAt || '',
      battlemetricsCandidates: (Array.isArray(item?.battlemetricsCandidates) ? item.battlemetricsCandidates : [])
        .map((candidate) => ({
          battlemetricsId: candidate?.battlemetricsId || candidate?.playerId || candidate?.id || '',
          displayName: candidate?.displayName || candidate?.name || '',
          alias: candidate?.alias || '',
          confidence: candidate?.confidence || '',
          firstSeenAt: candidate?.firstSeenAt || '',
          lastSeenAt: candidate?.lastSeenAt || '',
          serverTimePlayedSeconds: Number(candidate?.serverTimePlayedSeconds || candidate?.timePlayed || 0),
          online: Boolean(candidate?.online)
        }))
        .filter((candidate) => candidate.battlemetricsId)
    }))
    .filter((item) => item.message || item.steamId || item.displayName);
  if (!normalized.length && (Number(job?.failedCount || 0) > 0 || job?.errorSummary)) {
    normalized.push({
      memberId: '',
      steamId: '',
      displayName: syncJobTypeLabel(job?.type, t),
      message: localizeError(job?.errorSummary || t('requestFailed'), t),
      occurredAt: job?.finishedAt || job?.updatedAt || ''
    });
  }
  return normalized;
}

function steamProfileUrlForId(steamId = '') {
  const id = String(steamId || '').trim();
  return /^\d{17}$/.test(id) ? `https://steamcommunity.com/profiles/${encodeURIComponent(id)}` : '';
}

function battlemetricsPlayerUrlForId(battlemetricsId = '') {
  const id = String(battlemetricsId || '').trim();
  return id ? `https://www.battlemetrics.com/players/${encodeURIComponent(id)}` : '';
}

function SyncJobFailureModal({ job, lang, t, onClose, canManage = false, setToast = null, onConfirmed = null }) {
  const items = syncJobFailureItems(job, t);
  const titleId = `sync-job-failures-${job?.id || 'detail'}`;
  const [confirmingKey, setConfirmingKey] = useState('');
  const [confirmedKeys, setConfirmedKeys] = useState(() => new Set());
  const canConfirmBattlemetrics = canManage && job?.type === 'battlemetrics_identity';

  async function confirmBattlemetricsCandidate(item, candidate, index) {
    const battlemetricsId = candidate?.battlemetricsId || '';
    if (!canConfirmBattlemetrics || !item?.memberId || !battlemetricsId || confirmingKey) return;
    const key = `${item.memberId}:${battlemetricsId}:${index}`;
    setConfirmingKey(key);
    try {
      await api(`/api/members/${encodeURIComponent(item.memberId)}/battlemetrics-id`, {
        method: 'PUT',
        body: { battlemetricsId }
      });
      setConfirmedKeys((current) => new Set([...current, key]));
      if (setToast) setToast(t('syncJobBattlemetricsCandidateSaved'));
      if (onConfirmed) {
        try {
          await onConfirmed();
        } catch {
          // Confirmation succeeded; the next polling refresh will catch up.
        }
      }
    } catch (err) {
      if (setToast) {
        setToast(formatCopy(t('syncJobBattlemetricsCandidateFailed'), {
          message: formatApiError(err, t)
        }));
      }
    } finally {
      setConfirmingKey('');
    }
  }

  return (
    <ModalFrame className="wide-modal sync-failure-modal" labelledBy={titleId} onClose={onClose}>
      <div className="modal-title">
        <div>
          <h3 id={titleId}>{t('syncJobFailureTitle')}</h3>
          <span className="modal-subtitle">
            {formatCopy(t('syncJobFailureSubtitle'), {
              type: syncJobTypeLabel(job?.type, t),
              failed: formatStatNumber(job?.failedCount || items.length, lang)
            })}
          </span>
        </div>
        <button type="button" className="icon-button" title={t('close')} onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      {items.length ? (
        <div className="sync-failure-list">
          {items.map((item, index) => {
            const candidates = canConfirmBattlemetrics ? item.battlemetricsCandidates : [];
            const steamProfileUrl = steamProfileUrlForId(item.steamId);
            return (
              <div className="sync-failure-row" key={`${item.memberId || item.steamId || item.message}-${index}`}>
                <div className="sync-failure-row-main">
                  <div>
                    <strong>{item.displayName || '-'}</strong>
                    {steamProfileUrl ? (
                      <a className="sync-failure-external-link mono" href={steamProfileUrl} target="_blank" rel="noreferrer">
                        {item.steamId}
                      </a>
                    ) : (
                      <span>{item.steamId || '-'}</span>
                    )}
                  </div>
                  <p>{item.message || '-'}</p>
                  <small>{formatTime(item.occurredAt, lang) || '-'}</small>
                </div>
                {candidates.length > 0 && (
                  <div className="sync-failure-candidates">
                    <div className="sync-failure-candidates-head">
                      <strong>{t('syncJobBattlemetricsCandidates')}</strong>
                      <span>{t('syncJobBattlemetricsCandidateHint')}</span>
                    </div>
                    {candidates.map((candidate, candidateIndex) => {
                      const battlemetricsId = candidate.battlemetricsId || '';
                      const battlemetricsUrl = battlemetricsPlayerUrlForId(battlemetricsId);
                      const key = `${item.memberId}:${battlemetricsId}:${candidateIndex}`;
                      const confirmed = confirmedKeys.has(key);
                      const timePlayed = formatPlayTimeMinutes(Math.round(Number(candidate.serverTimePlayedSeconds || 0) / 60), lang);
                      return (
                        <div className="sync-failure-candidate" key={key}>
                          <div>
                            <strong>{candidate.displayName || battlemetricsId}</strong>
                            <span>
                              {t('battlemetricsId')}: {battlemetricsUrl ? (
                                <a className="sync-failure-external-link mono" href={battlemetricsUrl} target="_blank" rel="noreferrer">
                                  {battlemetricsId}
                                </a>
                              ) : (battlemetricsId || '-')}
                            </span>
                            <small>
                              {formatCopy(t('syncJobBattlemetricsCandidateMeta'), {
                                alias: candidate.alias || '-',
                                lastSeen: formatTime(candidate.lastSeenAt, lang) || '-',
                                timePlayed: timePlayed || '-'
                              })}
                            </small>
                          </div>
                          <button
                            type="button"
                            className={cx('primary-button mini-button sync-failure-confirm-button', confirmed && 'confirmed')}
                            onClick={() => confirmBattlemetricsCandidate(item, candidate, candidateIndex)}
                            disabled={!canConfirmBattlemetrics || !item.memberId || confirmingKey === key || confirmed}
                            title={t('syncJobBattlemetricsCandidateConfirm')}
                          >
                            <BadgeCheck size={14} />
                            <span>{confirmed ? t('syncJobBattlemetricsCandidateConfirmed') : (confirmingKey === key ? t('loading') : t('syncJobBattlemetricsCandidateConfirm'))}</span>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="empty-state compact">{t('syncJobFailureEmpty')}</div>
      )}
    </ModalFrame>
  );
}

function SyncJobCard({ job, lang, t, onOpenFailures = null, onContinue = null, onCancel = null, onDelete = null, canManage = false, busy = false, cancelling = false, deleting = false }) {
  const percent = Math.max(0, Math.min(100, Number(job?.percent || 0)));
  const status = job?.status || 'queued';
  const failureItems = syncJobFailureItems(job, t);
  const canOpenFailures = Boolean(
    onOpenFailures &&
    ['failed', 'partial_failed'].includes(status) &&
    failureItems.length
  );
  const markerPercent = status === 'completed' && percent >= 100
    ? 100
    : Math.max(3, Math.min(97, percent));
  const target = job?.targetServerName || job?.targetServerId || job?.targetWipeId || '-';
  const progressText = formatCopy(t('syncJobProgressLine'), {
    done: formatStatNumber(job?.doneCount || 0, lang),
    total: formatStatNumber(job?.totalCount || 0, lang),
    failed: formatStatNumber(job?.failedCount || 0, lang),
    skipped: formatStatNumber(job?.skippedCount || 0, lang)
  });
  const startedAt = formatTime(job?.startedAt || job?.createdAt, lang) || '-';
  const finishedAt = formatTime(job?.finishedAt, lang) || '-';
  const canContinue = Boolean(canManage && onContinue && canContinueSyncJob(job));
  const canCancel = Boolean(canManage && onCancel && ['queued', 'running'].includes(status));
  const canDelete = Boolean(canManage && onDelete && !['queued', 'running'].includes(status));
  const hasActions = canOpenFailures || canContinue || canCancel || canDelete;
  return (
    <div className={cx('sync-job-card', status)}>
      <div className="sync-job-card-main">
        <div className="sync-job-card-head">
          <div>
            <strong>{syncJobTypeLabel(job?.type, t)}</strong>
            <span>{syncJobSourceLabel(job?.source, t)}</span>
          </div>
          <div className="sync-job-card-head-actions">
            <span className={cx('status-badge', ['running', 'queued'].includes(status) && 'active')}>{syncJobStatusLabel(status, t)}</span>
            {hasActions && (
              <div className="sync-job-actions">
                {canOpenFailures && (
                  <button type="button" className="ghost-button mini-button" onClick={() => onOpenFailures(job)} title={t('syncJobFailureOpen')}>
                    <ScrollText size={14} />
                    <span>{t('syncJobFailureOpen')}</span>
                  </button>
                )}
                {canContinue && (
                  <button type="button" className="ghost-button mini-button" onClick={() => onContinue(job)} disabled={busy} title={t('syncJobContinue')}>
                    <RefreshCw size={14} />
                    <span>{busy ? t('syncJobRunning') : t('syncJobContinue')}</span>
                  </button>
                )}
                {canCancel && (
                  <button type="button" className="ghost-button mini-button danger" onClick={() => onCancel(job)} disabled={cancelling} title={t('syncJobCancel')}>
                    <Square size={14} />
                    <span>{cancelling ? t('loading') : t('syncJobCancel')}</span>
                  </button>
                )}
                {canDelete && (
                  <button type="button" className="ghost-button mini-button danger" onClick={() => onDelete(job)} disabled={deleting} title={t('syncJobDelete')}>
                    <Trash2 size={14} />
                    <span>{deleting ? t('loading') : t('syncJobDelete')}</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="sync-job-meta">
          <span>{progressText}</span>
          <span className="sync-job-meta-target"><b>{t('syncJobTarget')}</b> {target}</span>
          <span><b>{t('syncJobStartedAt')}</b> {startedAt}</span>
          <span><b>{t('syncJobFinishedAt')}</b> {finishedAt}</span>
          {job?.etaSeconds > 0 && <span>{formatCopy(t('syncJobEta'), { seconds: formatStatNumber(job.etaSeconds, lang) })}</span>}
        </div>
      </div>
      <div className="sync-job-progress-wrap">
        <div
          className="sync-job-progress cat-progress"
          aria-label={progressText}
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={Math.round(percent)}
        >
          <span style={{ width: `${percent}%` }} />
          <b className="cat-progress-marker" style={{ left: `${markerPercent}%` }} aria-hidden="true">
            <Cat size={15} />
          </b>
        </div>
      </div>
      {job?.errorSummary && <Alert tone="danger" className="sync-job-error">{localizeError(job.errorSummary, t)}</Alert>}
    </div>
  );
}

const DEFAULT_SYNC_AUTO_RULE_FORM = {
  name: '',
  type: 'kda',
  enabled: true,
  intervalMinutes: 60,
  scope: 'current_wipe',
  notes: ''
};

function SyncAutoRulesModal({ lang, setToast, t, canEdit = false, onClose }) {
  const [rules, setRules] = useState([]);
  const [options, setOptions] = useState({ types: [], scopes: [], minIntervalMinutes: 5, maxIntervalMinutes: 10080 });
  const [form, setForm] = useState(DEFAULT_SYNC_AUTO_RULE_FORM);
  const [editingId, setEditingId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState('');
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const payload = await api('/api/sync/auto-rules');
      setRules(payload.rules || []);
      setOptions(payload.options || options);
    } catch (err) {
      setError(formatCopy(t('syncAutoRuleLoadFailed'), { message: formatApiError(err, t) }));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function editRule(rule) {
    setEditingId(rule.id);
    setForm({
      name: rule.name || '',
      type: rule.type || 'kda',
      enabled: rule.enabled !== false,
      intervalMinutes: rule.intervalMinutes || 60,
      scope: rule.scope || 'current_wipe',
      notes: rule.notes || ''
    });
  }

  function resetForm() {
    setEditingId('');
    setForm(DEFAULT_SYNC_AUTO_RULE_FORM);
  }

  async function saveRule(event) {
    event.preventDefault();
    if (!canEdit || saving) return;
    setSaving(true);
    setError('');
    try {
      const payload = await api(editingId ? `/api/sync/auto-rules/${encodeURIComponent(editingId)}` : '/api/sync/auto-rules', {
        method: editingId ? 'PUT' : 'POST',
        body: { ...form, intervalMinutes: Number(form.intervalMinutes || 0) }
      });
      setRules(payload.rules || []);
      setOptions(payload.options || options);
      resetForm();
      setToast(t('syncAutoRuleSaved'));
    } catch (err) {
      setError(formatApiError(err, t));
    } finally {
      setSaving(false);
    }
  }

  async function deleteRule(rule) {
    if (!canEdit || deletingId) return;
    setDeletingId(rule.id);
    setError('');
    try {
      const payload = await api(`/api/sync/auto-rules/${encodeURIComponent(rule.id)}`, { method: 'DELETE' });
      setRules(payload.rules || []);
      if (editingId === rule.id) resetForm();
      setToast(t('syncAutoRuleDeleted'));
    } catch (err) {
      setError(formatApiError(err, t));
    } finally {
      setDeletingId('');
    }
  }

  return (
    <ModalFrame className="wide-modal sync-auto-rules-modal" labelledBy="sync-auto-rules-title" onClose={onClose}>
      <div className="modal-title">
        <div>
          <h3 id="sync-auto-rules-title">{t('syncAutoRulesTitle')}</h3>
          <span className="modal-subtitle">{t('syncAutoRulesHint')}</span>
        </div>
        <button type="button" className="icon-button" title={t('close')} onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <form className="sync-auto-rule-form" onSubmit={saveRule}>
        <label>
          <span>{t('syncAutoRuleName')}</span>
          <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} maxLength={120} required disabled={!canEdit} />
        </label>
        <label>
          <span>{t('syncAutoRuleType')}</span>
          <select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })} disabled={!canEdit}>
            {(options.types || []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label>
          <span>{t('syncAutoRuleInterval')}</span>
          <input
            type="number"
            min={options.minIntervalMinutes || 5}
            max={options.maxIntervalMinutes || 10080}
            value={form.intervalMinutes}
            onChange={(event) => setForm({ ...form, intervalMinutes: event.target.value })}
            disabled={!canEdit}
          />
        </label>
        <label>
          <span>{t('syncAutoRuleScope')}</span>
          <select value={form.scope} onChange={(event) => setForm({ ...form, scope: event.target.value })} disabled={!canEdit}>
            {(options.scopes || []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label className="checkbox-row">
          <input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} disabled={!canEdit} />
          <span>{t('syncAutoRuleEnabled')}</span>
        </label>
        <label className="sync-auto-rule-notes">
          <span>{t('syncAutoRuleNotes')}</span>
          <input value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} maxLength={500} disabled={!canEdit} />
        </label>
        <div className="modal-actions sync-auto-rule-submit">
          {editingId && (
            <button type="button" className="ghost-button" onClick={resetForm}>
              <Plus size={17} />
              <span>{t('syncAutoRuleAdd')}</span>
            </button>
          )}
          <button className="primary-button" disabled={!canEdit || saving}>
            <Save size={17} />
            <span>{editingId ? t('syncAutoRuleEdit') : t('syncAutoRuleAdd')}</span>
          </button>
        </div>
      </form>
      <div className="sync-auto-rule-list">
        {loading && <PageLoadingState title={t('syncAutoRulesTitle')} t={t} compact />}
        {!loading && !rules.length && <div className="empty-state compact">{t('syncNoRecentJob')}</div>}
        {rules.map((rule) => (
          <div className="sync-auto-rule-card" key={rule.id}>
            <div className="sync-auto-rule-main">
              <strong>{rule.name}</strong>
              <span>{syncJobTypeLabel(rule.type, t)} · {rule.scope} · {formatStatNumber(rule.intervalMinutes, lang)} min</span>
              <small>{rule.notes || '-'}</small>
              <small>{t('syncAutoRuleLastRun')}: {formatTime(rule.lastRunAt, lang) || '-'} · {t('syncAutoRuleNextRun')}: {formatTime(rule.nextRunAt, lang) || '-'}</small>
            </div>
            <span className={cx('status-badge', rule.enabled && 'active')}>{rule.enabled ? t('syncJobAuto') : t('syncJobCancelled')}</span>
            <div className="sync-job-actions">
              <button type="button" className="ghost-button mini-button" onClick={() => editRule(rule)} title={t('syncAutoRuleEdit')} disabled={!canEdit}>
                <Pencil size={14} />
              </button>
              <button type="button" className="ghost-button mini-button danger" onClick={() => deleteRule(rule)} title={t('syncJobDelete')} disabled={!canEdit || deletingId === rule.id}>
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </ModalFrame>
  );
}

export default function SyncCenterPanel({ lang, setToast, t, canEdit = false }) {
  const [jobs, setJobs] = useState({ current: [], recent: [] });
  const [jobsHealth, setJobsHealth] = useState({ loaded: false, partial: false, readError: '', updatedAt: '' });
  const [battlemetricsQueue, setBattlemetricsQueue] = useState(null);
  const [runningAction, setRunningAction] = useState('');
  const [cancellingJobId, setCancellingJobId] = useState('');
  const [deletingJobId, setDeletingJobId] = useState('');
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [failureJob, setFailureJob] = useState(null);
  const [autoRulesOpen, setAutoRulesOpen] = useState(false);

  function applyJobsPayload(payload = {}) {
    if (!payload.partial) {
      setJobs({
        current: payload.current || payload.jobs || [],
        recent: payload.recent || []
      });
    }
    setJobsHealth({
      loaded: true,
      partial: Boolean(payload.partial),
      readError: payload.readError || '',
      updatedAt: payload.updatedAt || ''
    });
    return Boolean(payload.partial);
  }

  function setJobsLoadFailure(error) {
    const message = formatApiError(error, t);
    setJobsHealth({
      loaded: true,
      partial: true,
      readError: message,
      updatedAt: ''
    });
    setLoadError(formatCopy(t('syncCenterLoadFailed'), { message }));
  }

  function setJobsPartialLoadError(payload = {}) {
    const message = payload.readError || t('requestFailed');
    setLoadError(formatCopy(t('syncCenterLoadFailed'), { message }));
  }

  async function load() {
    const [jobsResult, queueResult] = await Promise.allSettled([
      api('/api/sync/jobs/recent?limit=16'),
      api('/api/settings/battlemetrics/queue')
    ]);
    if (jobsResult.status === 'fulfilled') {
      applyJobsPayload(jobsResult.value);
    } else {
      setJobsLoadFailure(jobsResult.reason);
    }
    if (queueResult.status === 'fulfilled') {
      setBattlemetricsQueue(queueResult.value.battlemetricsQueue || null);
    }
    const failed = [jobsResult, queueResult].find((result) => result.status === 'rejected');
    if (failed) {
      throw failed.reason;
    }
    if (jobsResult.value.partial) setJobsPartialLoadError(jobsResult.value);
    else setLoadError('');
  }

  useEffect(() => {
    let mounted = true;
    let timer = null;
    const scheduleNext = (active = false) => {
      if (!mounted) return;
      timer = window.setTimeout(refresh, active ? 5000 : 10000);
    };
    const refresh = async () => {
      try {
        const [jobsResult, queueResult] = await Promise.allSettled([
          api('/api/sync/jobs/recent?limit=16'),
          api('/api/settings/battlemetrics/queue')
        ]);
        if (!mounted) return;
        if (jobsResult.status === 'fulfilled') {
          applyJobsPayload(jobsResult.value);
        } else {
          setJobsLoadFailure(jobsResult.reason);
        }
        if (queueResult.status === 'fulfilled') {
          setBattlemetricsQueue(queueResult.value.battlemetricsQueue || null);
        }
        const failed = [jobsResult, queueResult].find((result) => result.status === 'rejected');
        if (failed) {
          setLoadError(formatCopy(t('syncCenterLoadFailed'), { message: formatApiError(failed.reason, t) }));
          scheduleNext(Boolean((jobs.current || []).length));
          return;
        }
        if (jobsResult.value.partial) setJobsPartialLoadError(jobsResult.value);
        else setLoadError('');
        scheduleNext(Boolean((jobsResult.value.current || []).length));
      } catch (err) {
        if (!mounted) return;
        setLoadError(formatCopy(t('syncCenterLoadFailed'), { message: formatApiError(err, t) }));
        scheduleNext(Boolean((jobs.current || []).length));
      }
    };
    refresh();
    return () => {
      mounted = false;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  async function startSync(action) {
    if (!canEdit || runningAction) return;
    const endpoints = {
      battlemetrics_identity: { url: '/api/sync/jobs/battlemetrics-id', body: {}, label: t('syncBattlemetricsIds') },
      battlemetrics_playtime: { url: '/api/sync/jobs/battlemetrics-playtime', body: {}, label: t('syncBattlemetricsOnline') },
      ...(HEXAYTRON_FEATURE_ENABLED ? { hexaytron_profile: { url: '/api/sync/jobs/hexaytron-profile', body: {}, label: t('syncHexaytronProfiles') } } : {}),
      member_profile: { url: '/api/settings/member-profiles/sync', body: {}, label: t('syncMemberProfiles') },
      kda: { url: '/api/kda/sync', body: {}, label: t('syncKdaData') }
    };
    const target = endpoints[action];
    if (!target) return;
    setRunningAction(action);
    setActionError('');
    try {
      await api(target.url, { method: 'POST', body: target.body });
      setToast(t('syncJobActionQueued'));
      try {
        await load();
      } catch (err) {
        setLoadError(formatCopy(t('syncCenterLoadFailed'), { message: formatApiError(err, t) }));
      }
    } catch (err) {
      setActionError(formatCopy(t('syncJobActionFailed'), {
        action: target.label,
        message: formatApiError(err, t)
      }));
    } finally {
      setRunningAction('');
    }
  }

  async function deleteJob(job) {
    if (!canEdit || !job?.id || deletingJobId) return;
    setDeletingJobId(job.id);
    setActionError('');
    try {
      const payload = await api(`/api/sync/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' });
      applyJobsPayload(payload);
      if (payload.partial) setJobsPartialLoadError(payload);
      else setLoadError('');
      if (failureJob?.id === job.id) setFailureJob(null);
      setToast(t('syncJobDeleted'));
    } catch (err) {
      setActionError(formatCopy(t('syncJobDeleteFailed'), { message: formatApiError(err, t) }));
    } finally {
      setDeletingJobId('');
    }
  }

  async function cancelJob(job) {
    if (!canEdit || !job?.id || cancellingJobId) return;
    setCancellingJobId(job.id);
    setActionError('');
    try {
      const payload = await api(`/api/sync/jobs/${encodeURIComponent(job.id)}/cancel`, { method: 'POST' });
      applyJobsPayload(payload);
      if (payload.partial) setJobsPartialLoadError(payload);
      else setLoadError('');
      setToast(t('syncJobCancelledToast'));
    } catch (err) {
      setActionError(formatCopy(t('syncJobCancelFailed'), { message: formatApiError(err, t) }));
    } finally {
      setCancellingJobId('');
    }
  }

  const visibleCurrentJobs = useMemo(() => (jobs.current || []).filter((job) => HEXAYTRON_FEATURE_ENABLED || job.type !== 'hexaytron_profile'), [jobs.current]);
  const activeTypes = useMemo(() => new Set(visibleCurrentJobs.map((job) => job.type)), [visibleCurrentJobs]);
  const syncJobsUnavailable = Boolean(!jobsHealth.loaded || jobsHealth.partial);
  const actionButtons = useMemo(() => [
    { type: 'battlemetrics_identity', label: t('syncBattlemetricsIds'), icon: BadgeCheck },
    { type: 'battlemetrics_playtime', label: t('syncBattlemetricsOnline'), icon: Server },
    { type: 'kda', label: t('syncKdaData'), icon: BarChart3 },
    ...(HEXAYTRON_FEATURE_ENABLED ? [{ type: 'hexaytron_profile', label: t('syncHexaytronProfiles'), icon: Database }] : []),
    { type: 'member_profile', label: t('syncMemberProfiles'), icon: UserRound }
  ], [t]);
  const recentJobs = useMemo(() => {
    const currentIds = new Set(visibleCurrentJobs.map((job) => job.id));
    return (jobs.recent || [])
      .filter((job) => HEXAYTRON_FEATURE_ENABLED || job.type !== 'hexaytron_profile')
      .filter((job) => !isEmptyCompletedSyncJob(job))
      .filter((job) => !currentIds.has(job.id))
      .slice(0, 8);
  }, [visibleCurrentJobs, jobs.recent]);

  return (
    <section className="page-stack sync-center-page">
      <section className="tool-panel sync-center-toolbar">
        <div className="section-heading sync-center-heading">
          <div className="heading-stack">
            <p>{t('syncCenterHint')}</p>
          </div>
          <button type="button" className="action-button" onClick={() => setAutoRulesOpen(true)} title={t('syncAutoRules')}>
            <Settings size={16} />
            <span>{t('syncAutoRules')}</span>
          </button>
        </div>
        {!canEdit && <Alert tone="info">{t('syncCenterReadOnly')}</Alert>}
        {loadError && <Alert tone="danger">{loadError}</Alert>}
        {actionError && <Alert tone="danger">{actionError}</Alert>}
        <div className="sync-center-actions">
          {actionButtons.map(({ type, label, icon: Icon }) => {
            const busy = runningAction === type || activeTypes.has(type);
            return (
              <button key={type} type="button" className="action-button" onClick={() => startSync(type)} disabled={!canEdit || busy || syncJobsUnavailable} title={label}>
                <Icon size={16} />
                <span>{busy ? t('syncJobRunning') : label}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="tool-panel sync-jobs-panel">
        <div className="sync-jobs-board">
          <div className="sync-job-lane">
            <h3>{t('syncCurrentJobs')}</h3>
            <div className="sync-job-list">
              {visibleCurrentJobs.length
                ? visibleCurrentJobs.map((job) => (
                  <SyncJobCard
                    key={job.id}
                    job={job}
                    lang={lang}
                    t={t}
                    onCancel={cancelJob}
                    canManage={canEdit}
                    cancelling={cancellingJobId === job.id}
                  />
                ))
                : <div className="empty-state compact">{t('syncNoCurrentJob')}</div>}
            </div>
          </div>
          <div className="sync-job-lane">
            <h3>{t('syncRecentJobs')}</h3>
            <div className="sync-job-list">
              {recentJobs.length
                ? recentJobs.map((job) => (
                  <SyncJobCard
                    key={job.id}
                    job={job}
                    lang={lang}
                    t={t}
                    onOpenFailures={setFailureJob}
                    onContinue={() => startSync(job.type)}
                    onCancel={cancelJob}
                    onDelete={deleteJob}
                    canManage={canEdit}
                    busy={runningAction === job.type || activeTypes.has(job.type)}
                    cancelling={cancellingJobId === job.id}
                    deleting={deletingJobId === job.id}
                  />
                ))
                : <div className="empty-state compact">{t('syncNoRecentJob')}</div>}
            </div>
          </div>
        </div>
      </section>

      <BattlemetricsQueuePanel queue={battlemetricsQueue} lang={lang} t={t} />
      {failureJob && (
        <SyncJobFailureModal
          job={failureJob}
          lang={lang}
          t={t}
          canManage={canEdit}
          setToast={setToast}
          onConfirmed={load}
          onClose={() => setFailureJob(null)}
        />
      )}
      {autoRulesOpen && <SyncAutoRulesModal lang={lang} setToast={setToast} t={t} canEdit={canEdit} onClose={() => setAutoRulesOpen(false)} />}
    </section>
  );
}
