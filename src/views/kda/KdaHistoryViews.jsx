import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, CalendarClock, Clipboard, Download, ExternalLink, FileUp, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { EXPORT_RANKINGS, HTML_EXPORT_RANKINGS, LANGUAGES, detectLanguage, exportTimeZoneFor, languageOptionLabel } from '../../i18n/languages.js';
import { api } from '../../shared/api.js';
import { downloadFetchResponse, copyText } from '../../shared/browser.js';
import { calculateWipePlayDays, datetimeLocalToIso, formatCompactResource, formatCopy, formatPlayDays, formatPlayTimeMinutes, formatStatNumber, formatTime, latestTimestamp, localizeError } from '../../shared/format.js';
import { KDA_TABLE_COLUMNS, kdaRowOnlineMinutes } from '../../shared/kda.js';
import { Avatar } from '../../shared/member/Avatar.jsx';
import { MemberProfileDialogStack } from '../../shared/member/dialogs.jsx';
import { normalizeMemberProfileCandidate } from '../../shared/member/MemberName.jsx';
import { canViewOperationalBackendData } from '../../shared/permissions.js';
import { createLatestRequestController, isAbortError } from '../../shared/request-control.js';
import { KDA_SYNC_COOLDOWN_SECONDS, deferPollWhileHidden, estimateKdaSyncSeconds, isPageHidden, schedulePollTimeout, shouldShowFinishedSyncState, syncProgressFromServer, syncUiStateFromServer, syncVisualProgressPercent } from '../../shared/sync-status.js';
import { Alert } from '../../shared/ui/Alert.jsx';
import { DataTable } from '../../shared/ui/DataTable.jsx';
import { InfoGrid } from '../../shared/ui/InfoGrid.jsx';
import { MetricCard } from '../../shared/ui/MetricCard.jsx';
import { PageLoadingState } from '../../shared/ui/PageLoadingState.jsx';
import { cx } from '../../shared/ui/cx.js';
import { wipeStatusText } from '../../shared/wipes.js';

function kdaFilterRequestKey(filters = {}) {
  return JSON.stringify([
    filters.wipeId || 'current',
    filters.scope || '',
    filters.squadId || '',
    filters.sort || '',
    filters.order || '',
    filters.q || ''
  ]);
}

function historyDetailRequestKey(conditions = {}) {
  return JSON.stringify([
    conditions.selectedId || '',
    Boolean(conditions.canViewAll),
    conditions.sort || '',
    conditions.order || ''
  ]);
}

export function KdaView({ user, lang, t, setToast, onOpenRustKdaLookup = null }) {
  const [rows, setRows] = useState([]);
  const [wipe, setWipe] = useState(null);
  const [dataFreshness, setDataFreshness] = useState(null);
  const [wipes, setWipes] = useState([]);
  const [squads, setSquads] = useState([]);
  const canViewAll = canViewOperationalBackendData(user);
  const [filters, setFilters] = useState({ wipeId: 'current', scope: canViewAll ? 'all' : 'my_squad', squadId: '', sort: 'kda', order: 'desc', q: '' });
  const [showImport, setShowImport] = useState(false);
  const [exportModal, setExportModal] = useState(null);
  const [profileMember, setProfileMember] = useState(null);
  const [importText, setImportText] = useState('');
  const [initialLoading, setInitialLoading] = useState(true);
  const [syncState, setSyncState] = useState('idle');
  const [syncProgress, setSyncProgress] = useState({ total: 0, completed: 0, percent: 0, etaSeconds: 0 });
  const syncStateRef = useRef('idle');
  const syncTimerRef = useRef(null);
  const syncPollRef = useRef(null);
  const syncResetRef = useRef(null);
  const loadKdaRef = useRef(null);
  const filtersRef = useRef(filters);
  const activeRef = useRef(true);
  const loadRequestControlRef = useRef(null);
  const syncPollRequestControlRef = useRef(null);
  if (!loadRequestControlRef.current) loadRequestControlRef.current = createLatestRequestController();
  if (!syncPollRequestControlRef.current) syncPollRequestControlRef.current = createLatestRequestController();
  const [error, setError] = useState('');
  const isAdmin = user.role === 'admin';
  const kdaSquadFilterValue = filters.scope === 'squad' ? filters.squadId : filters.scope;
  const kdaSyncFallbackTotal = useMemo(() => {
    const rowCount = Math.max(0, Math.floor(Number(dataFreshness?.rowCount) || 0));
    const visibleRows = Array.isArray(rows) ? rows.length : 0;
    const participantCount = Math.max(0, Math.floor(Number(wipe?.participantCount) || 0));
    if (wipe?.kdaMemberScope === 'all_members') {
      return Math.max(rowCount, visibleRows, participantCount);
    }
    return participantCount || rowCount || visibleRows;
  }, [dataFreshness?.rowCount, rows.length, wipe?.kdaMemberScope, wipe?.participantCount]);

  function updateSyncState(nextState) {
    syncStateRef.current = nextState;
    setSyncState(nextState);
  }

  useLayoutEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  async function load(next = filtersRef.current) {
    const requestKey = kdaFilterRequestKey(next);
    if (requestKey !== kdaFilterRequestKey(filtersRef.current)) return null;
    const requestControl = loadRequestControlRef.current;
    const request = requestControl.begin();
    const params = new URLSearchParams();
    params.set('wipeId', next.wipeId || 'current');
    params.set('scope', next.scope);
    if (next.squadId) params.set('squadId', next.squadId);
    if (next.sort) params.set('sort', next.sort);
    if (next.order) params.set('order', next.order);
    if (next.q) params.set('q', next.q);
    try {
      const payload = await api(`/api/kda?${params}`, { signal: request.signal });
      if (!requestControl.isCurrent(request) || requestKey !== kdaFilterRequestKey(filtersRef.current)) return null;
      setRows(payload.rows || []);
      setWipe(payload.wipe);
      setDataFreshness(payload.dataFreshness || null);
      setSquads(payload.squads || []);
      return payload;
    } catch (error) {
      if (isAbortError(error) || requestKey !== kdaFilterRequestKey(filtersRef.current)) return null;
      throw error;
    } finally {
      requestControl.finish(request);
    }
  }
  loadKdaRef.current = load;

  async function loadWipes() {
    const payload = await api('/api/wipes');
    if (!activeRef.current) return;
    setWipes(payload.wipes || []);
  }

  useEffect(() => {
    activeRef.current = true;
    loadRequestControlRef.current.activate();
    syncPollRequestControlRef.current.activate();
    return () => {
      activeRef.current = false;
      if (syncTimerRef.current) clearInterval(syncTimerRef.current);
      if (syncPollRef.current) clearTimeout(syncPollRef.current);
      if (syncResetRef.current) clearTimeout(syncResetRef.current);
      loadRequestControlRef.current.dispose();
      syncPollRequestControlRef.current.dispose();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setInitialLoading(true);
    Promise.allSettled([
      load().catch((err) => setError(localizeError(err.message, t))),
      loadWipes().catch(() => {}),
      pollKdaSyncStatus().catch(() => {})
    ]).finally(() => {
      if (!cancelled) setInitialLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function stopSyncProgressTimer() {
    if (syncTimerRef.current) {
      clearInterval(syncTimerRef.current);
      syncTimerRef.current = null;
    }
  }

  function scheduleSyncFeedbackReset() {
    if (syncResetRef.current) clearTimeout(syncResetRef.current);
    syncResetRef.current = setTimeout(() => {
      if (syncStateRef.current === 'complete') updateSyncState('idle');
      syncResetRef.current = null;
    }, 3500);
  }

  function beginSyncProgress(total, estimatedSeconds) {
    stopSyncProgressTimer();
    const normalizedTotal = Math.max(0, Math.floor(Number(total) || 0));
    const normalizedEstimate = Math.max(3, Math.ceil(Number(estimatedSeconds) || estimateKdaSyncSeconds(normalizedTotal)));
    const startedAt = Date.now();
    setSyncProgress({ total: normalizedTotal, completed: 0, percent: normalizedTotal ? 4 : 18, etaSeconds: normalizedEstimate });
    syncTimerRef.current = setInterval(() => {
      if (isPageHidden()) return;
      const elapsedSeconds = Math.max(0, (Date.now() - startedAt) / 1000);
      const ratio = Math.min(0.92, elapsedSeconds / normalizedEstimate);
      const completed = normalizedTotal
        ? Math.min(Math.max(0, normalizedTotal - 1), Math.floor(normalizedTotal * ratio))
        : 0;
      setSyncProgress({
        total: normalizedTotal,
        completed,
        percent: Math.max(normalizedTotal ? 6 : 18, Math.round(ratio * 100)),
        etaSeconds: Math.max(1, Math.ceil(normalizedEstimate - elapsedSeconds))
      });
    }, 320);
  }

  function completeSyncProgress(payload = {}) {
    stopSyncProgressTimer();
    const total = Math.max(0, Math.floor(Number(payload.requested ?? syncProgress.total) || 0));
    const completed = Math.max(0, Math.min(total || Number(payload.completed || 0), Math.floor(Number(payload.completed ?? total) || 0)));
    setSyncProgress({
      total,
      completed: total ? completed : 0,
      percent: 100,
      etaSeconds: 0
    });
  }

  function failSyncProgress() {
    stopSyncProgressTimer();
    setSyncProgress((current) => ({
      total: current.total,
      completed: Math.min(current.completed, current.total),
      percent: 100,
      etaSeconds: 0
    }));
  }

  function beginRateLimitCountdown(seconds, { total = 0, completed = 0, phase = 'rateLimited' } = {}) {
    stopSyncProgressTimer();
    if (syncPollRef.current) {
      clearTimeout(syncPollRef.current);
      syncPollRef.current = null;
    }
    const totalSeconds = Math.max(1, Math.ceil(Number(seconds) || 180));
    const normalizedTotal = Math.max(0, Math.floor(Number(total) || 0));
    const normalizedCompleted = Math.max(0, Math.min(normalizedTotal || Number(completed || 0), Math.floor(Number(completed) || 0)));
    const startedAt = Date.now();
    updateSyncState('rateLimited');
    setSyncProgress({ total: normalizedTotal, completed: normalizedCompleted, percent: 0, etaSeconds: totalSeconds, phase });
    syncTimerRef.current = setInterval(() => {
      if (isPageHidden()) return;
      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
      const remainingSeconds = Math.max(0, totalSeconds - elapsedSeconds);
      const percent = Math.min(100, Math.round(((totalSeconds - remainingSeconds) / totalSeconds) * 100));
      setSyncProgress({ total: normalizedTotal, completed: normalizedCompleted, percent, etaSeconds: remainingSeconds, phase });
      if (remainingSeconds <= 0) {
        stopSyncProgressTimer();
        setError('');
        updateSyncState('idle');
      }
    }, 1000);
  }

  function applyKdaSyncStatus(status = {}) {
    const nextState = syncUiStateFromServer(status);
    if (nextState === 'idle' || !shouldShowFinishedSyncState(status)) return false;
    const nextProgress = syncProgressFromServer(status, kdaSyncFallbackTotal);
    const currentState = syncStateRef.current;
    if (nextState === 'complete') {
      if (currentState === 'syncing') {
        completeSyncProgress({
          requested: nextProgress.total,
          completed: nextProgress.completed || nextProgress.total
        });
        updateSyncState('complete');
        scheduleSyncFeedbackReset();
      }
      return false;
    }
    if (nextState === 'rateLimited') {
      beginRateLimitCountdown(nextProgress.etaSeconds || KDA_SYNC_COOLDOWN_SECONDS);
      return false;
    }
    if (nextState === 'syncing' || nextState === 'error') {
      stopSyncProgressTimer();
    }
    updateSyncState(nextState);
    setSyncProgress(nextProgress);
    if (nextState === 'error' && status.error) setError(localizeError(status.error, t));
    return nextState === 'syncing';
  }

  async function pollKdaSyncStatus() {
    if (!activeRef.current) return;
    if (syncPollRef.current) {
      clearTimeout(syncPollRef.current);
      syncPollRef.current = null;
    }
    if (deferPollWhileHidden(syncPollRef, () => pollKdaSyncStatus().catch(() => {}), 1200)) return;
    const requestControl = syncPollRequestControlRef.current;
    const request = requestControl.begin();
    try {
      const payload = await api('/api/sync-status?kind=kda', { signal: request.signal });
      if (!requestControl.isCurrent(request)) return;
      const status = payload.syncState?.kda || {};
      const keepPolling = applyKdaSyncStatus(status);
      if (keepPolling) {
        schedulePollTimeout(syncPollRef, () => pollKdaSyncStatus().catch(() => {}), 1200);
        return;
      }
      if (status.status === 'complete') {
        await loadKdaRef.current?.();
        if (!requestControl.isCurrent(request)) return;
        setToast(t('kdaSynced'));
      } else if (status.status === 'failed') {
        setError(localizeError(status.error || t('kdaSyncFailed'), t));
      }
    } catch (error) {
      if (isAbortError(error) || !requestControl.isCurrent(request)) return;
      // Best-effort progress recovery.
    } finally {
      requestControl.finish(request);
    }
  }

  async function sync() {
    setError('');
    if (syncState === 'syncing' || syncState === 'rateLimited') return;
    const syncFilters = filtersRef.current;
    const syncRequestKey = kdaFilterRequestKey(syncFilters);
    const total = kdaSyncFallbackTotal;
    beginSyncProgress(total, estimateKdaSyncSeconds(total));
    updateSyncState('syncing');
    schedulePollTimeout(syncPollRef, () => pollKdaSyncStatus().catch(() => {}), 500);
    try {
      const payload = await api('/api/kda/sync', { method: 'POST', body: { ...syncFilters, wipeId: wipe?.id || syncFilters.wipeId } });
      if (!activeRef.current) return;
      const requestMatchesFilters = syncRequestKey === kdaFilterRequestKey(filtersRef.current);
      const status = payload.syncState || {};
      const queued = Boolean(payload.queued || ['queued', 'running'].includes(payload.job?.status) || syncUiStateFromServer(status) === 'syncing');
      if (queued) {
        applyKdaSyncStatus(status);
        if (requestMatchesFilters) {
          if (payload.rows) setRows(payload.rows || []);
          if (payload.wipe) setWipe(payload.wipe);
          setDataFreshness(payload.dataFreshness || null);
        }
        setToast(t('syncJobActionQueued'));
        if (!syncPollRef.current) {
          schedulePollTimeout(syncPollRef, () => pollKdaSyncStatus().catch(() => {}), 1200);
        }
        return;
      }
      if (requestMatchesFilters) {
        setRows(payload.rows || []);
        if (payload.wipe) setWipe(payload.wipe);
        setDataFreshness(payload.dataFreshness || null);
      }
      setToast(payload.kdaSyncSkipped && payload.kdaSyncMessage ? payload.kdaSyncMessage : t('kdaSynced'));
      stopSyncProgressTimer();
      const completed = Math.max(0, Math.floor(Number(payload.completed ?? payload.requested ?? total) || 0));
      completeSyncProgress({
        requested: Math.max(0, Math.floor(Number(payload.requested ?? total) || 0)),
        completed
      });
      updateSyncState('complete');
      scheduleSyncFeedbackReset();
    } catch (err) {
      if (!activeRef.current) return;
      const message = localizeError(err.message, t);
      setError(message);
      if (err.status === 429 || err.retryAfter) {
        beginRateLimitCountdown(err.retryAfter);
        return;
      }
      failSyncProgress();
      updateSyncState('error');
    }
  }

  async function importKda(event) {
    event.preventDefault();
    setError('');
    try {
      const payload = await api('/api/kda/import', { method: 'POST', body: { wipeId: wipe?.id, text: importText } });
      setToast(formatCopy(t('kdaImported'), { imported: payload.imported || 0, ignored: payload.ignored || 0 }));
      setImportText('');
      setShowImport(false);
      await load();
    } catch (err) {
      setError(localizeError(err.message, t));
    }
  }

  const sortByColumn = useCallback((sortKey) => {
    if (!sortKey) return;
    const current = filtersRef.current;
    const next = {
      ...current,
      sort: sortKey,
      order: current.sort === sortKey && current.order === 'desc' ? 'asc' : 'desc'
    };
    filtersRef.current = next;
    setFilters(next);
    loadKdaRef.current?.(next).catch((err) => setError(localizeError(err.message, t)));
  }, [t]);

  function updateKdaSquadFilter(value) {
    if (value === 'my_squad') {
      setFilters({ ...filters, scope: 'my_squad', squadId: '' });
      return;
    }
    if (value === 'all') {
      setFilters({ ...filters, scope: 'all', squadId: '' });
      return;
    }
    setFilters({ ...filters, scope: 'squad', squadId: value });
  }

  const exportParams = new URLSearchParams({
    wipeId: wipe?.id || filters.wipeId || 'current',
    scope: filters.scope,
    squadId: filters.squadId,
    sort: filters.sort,
    order: filters.order,
    q: filters.q
  });
  const syncProgressPercent = Math.max(0, Math.min(100, Number(syncProgress.percent || 0)));
  const syncProgressValues = {
    total: formatStatNumber(syncProgress.total, lang),
    completed: formatStatNumber(syncProgress.completed, lang),
    seconds: formatStatNumber(syncProgress.etaSeconds, lang),
    message: error || t('requestFailed')
  };
  const isRecoveryCountdown = syncState === 'rateLimited' && syncProgress.phase === 'recovery';
  const syncProgressMeta = syncState === 'syncing'
    ? formatCopy(t('syncKdaProgressMeta'), syncProgressValues)
    : syncState === 'complete'
      ? formatCopy(t('syncKdaCompleteMeta'), syncProgressValues)
      : syncState === 'rateLimited'
        ? formatCopy(t(isRecoveryCountdown ? 'syncKdaRecoveryMeta' : 'syncKdaRateLimitedMeta'), syncProgressValues)
        : formatCopy(t('syncKdaFailedMeta'), syncProgressValues);
  const syncFeedbackTitle = syncState === 'syncing'
    ? t('syncingKda')
    : syncState === 'complete'
      ? t('syncKdaComplete')
      : syncState === 'rateLimited'
        ? t(isRecoveryCountdown ? 'syncKdaRecovery' : 'syncKdaRateLimited')
        : t('syncKdaFailed');
  const syncFeedbackText = syncState === 'syncing'
    ? t('syncKdaWaiting')
    : syncState === 'complete'
      ? t('kdaSynced')
      : syncState === 'rateLimited'
        ? t(isRecoveryCountdown ? 'syncKdaRecoveryCountdown' : 'syncKdaRetryCountdown')
        : error;
  const syncButtonText = syncState === 'syncing'
    ? t('syncingKda')
    : syncState === 'complete'
      ? t('syncKdaComplete')
      : syncState === 'rateLimited'
        ? (isRecoveryCountdown ? t('syncKdaRecoveringShort') : formatCopy(t('syncKdaCooldownShort'), syncProgressValues))
        : t('syncKdaShort');
  const syncVisualPercent = syncVisualProgressPercent(syncState, syncProgressPercent);
  const syncCatPosition = `${syncVisualPercent}%`;
  const kdaDataTime = useMemo(
    () => dataFreshness?.syncedAt || latestTimestamp(rows, (row) => row.capturedAt || row.syncedAt || row.updatedAt || row.createdAt),
    [dataFreshness?.syncedAt, rows]
  );
  const wipeCanSync = isAdmin && wipe && (wipe.status === 'active' || wipe.status === 'closed');
  const wipeCanImport = isAdmin && wipe && wipe.status === 'active';
  const kdaSortState = useMemo(() => ({ sort: filters.sort, order: filters.order }), [filters.order, filters.sort]);

  if (initialLoading) {
    return (
      <section className="page-stack">
        <PageLoadingState title={t('kdaData')} t={t} />
      </section>
    );
  }

  return (
    <section className="page-stack">
      <form className="tool-panel log-filters kda-filters" onSubmit={(event) => { event.preventDefault(); load().catch((err) => setError(localizeError(err.message, t))); }}>
        <label>
          <span>{t('kdaServer')}</span>
          <select value={filters.wipeId} onChange={(event) => setFilters({ ...filters, wipeId: event.target.value })}>
            <option value="current">{t('activeWipe')}</option>
            {wipes.map((item) => (
              <option key={item.id} value={item.id}>
                {item.serverName} · {formatTime(item.startedAt, lang)} · {wipeStatusText(item.status, t)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t('selectSquad')}</span>
          <select value={kdaSquadFilterValue} onChange={(event) => updateKdaSquadFilter(event.target.value)}>
            <option value="my_squad">{t('mySquad')}</option>
            {canViewAll && <option value="all">{t('allSquads')}</option>}
            {canViewAll && squads.map((squad) => <option key={squad.id} value={squad.id}>{squad.name}</option>)}
          </select>
        </label>
        <label className="kda-query-field">
          <span>{t('nickname')}</span>
          <input value={filters.q} onChange={(event) => setFilters({ ...filters, q: event.target.value })} placeholder={t('kdaSearchPlaceholder')} />
        </label>
        <button className="primary-button align-end" title={t('query')}>
          <Search size={17} />
          <span>{t('queryShort')}</span>
        </button>
      </form>
      {error && syncState !== 'rateLimited' && <Alert tone="danger">{error}</Alert>}
      <div className="section-heading">
        <div className="heading-stack">
          <h3>{wipe?.name || t('kdaData')}</h3>
          <DataFreshnessMeta label={t('kdaDataTime')} value={kdaDataTime} lang={lang} t={t} />
        </div>
        <div className="row-actions toolbar-compact">
          {wipe?.kdaUrl && (
            <a className="ghost-button" title={t('externalKda')} href={wipe.kdaUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={17} />
              <span>{t('externalKdaShort')}</span>
            </a>
          )}
          {wipeCanSync && (
            <button className={cx('ghost-button sync-kda-button', syncState === 'syncing' && 'syncing', syncState === 'complete' && 'complete', syncState === 'error' && 'error', syncState === 'rateLimited' && 'rate-limited')} title={t('syncKda')} onClick={sync} disabled={syncState === 'syncing' || syncState === 'rateLimited'}>
              <RefreshCw size={17} />
              <span>{syncButtonText}</span>
            </button>
          )}
          {wipeCanImport && (
            <button className="ghost-button" title={t('importKda')} onClick={() => setShowImport((value) => !value)}>
              <Clipboard size={17} />
              <span>{t('importKdaShort')}</span>
            </button>
          )}
          <button type="button" className="primary-button fit-button export-button" title={t('exportHtml')} onClick={() => setExportModal('html')} disabled={!wipe}>
            <Download size={17} />
            <span>{t('exportHtmlShort')}</span>
          </button>
          <button type="button" className="ghost-button fit-button export-button" title={t('exportPdf')} onClick={() => setExportModal('pdf')} disabled={!wipe}>
            <FileUp size={17} />
            <span>{t('exportPdfShort')}</span>
          </button>
        </div>
      </div>
      {syncState !== 'idle' && (
        <div className={cx('sync-feedback', syncState)} aria-live="polite" style={{ '--sync-progress': `${syncVisualPercent}%`, '--sync-cat-position': syncCatPosition }}>
          <span className="sync-feedback-orbit" />
          <div className="sync-feedback-content">
            <div className="sync-feedback-title-row">
              <strong>{syncFeedbackTitle}</strong>
              <span className="sync-feedback-count">{syncProgressMeta}</span>
            </div>
            <small>{syncFeedbackText}</small>
            <div className="sync-progress-track" aria-hidden="true">
              <span className="sync-progress-fill" />
              <span className="sync-cat-runner">
                <span className="sync-cat-tail" />
                <span className="sync-cat-body" />
                <span className="sync-cat-head" />
              </span>
            </div>
          </div>
        </div>
      )}
      {showImport && (
        <form className="tool-panel import-panel" onSubmit={importKda}>
          <label>
            <span>{t('importKda')}</span>
            <textarea value={importText} onChange={(event) => setImportText(event.target.value)} placeholder={t('kdaImportPlaceholder')} required />
          </label>
          <div className="row-actions">
            <button type="button" className="ghost-button" onClick={() => setShowImport(false)}>{t('cancel')}</button>
            <button className="primary-button" title={t('importKda')}>
              <Clipboard size={17} />
              <span>{t('importKdaShort')}</span>
            </button>
          </div>
        </form>
      )}
      <KdaTable rows={rows} lang={lang} t={t} setToast={setToast} sortState={kdaSortState} onSort={sortByColumn} onProfileClick={setProfileMember} />
      {exportModal && wipe && (
        <RankingExportModal
          format={exportModal}
          endpoint="/api/kda/export"
          subject={wipe?.name || t('kdaData')}
          baseParams={exportParams}
          squads={squads}
          canExportAll={isAdmin}
          currentLang={lang}
          t={t}
          onClose={() => setExportModal(null)}
        />
      )}
      <MemberProfileDialogStack
        member={profileMember}
        user={user}
        lang={lang}
        t={t}
        setToast={setToast}
        onMemberUpdated={async () => {
          await load();
        }}
        onOpenRustKdaLookup={onOpenRustKdaLookup}
        onClose={() => setProfileMember(null)}
      />
    </section>
  );
}

export function HistoryView({ user, lang, t, setToast, onOpenRustKdaLookup = null, StatusBadge }) {
  const [wipes, setWipes] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState('');
  const [historySort, setHistorySort] = useState({ sort: 'kills', order: 'desc' });
  const [exportModal, setExportModal] = useState(null);
  const [profileMember, setProfileMember] = useState(null);
  const wipesRequestControlRef = useRef(null);
  const detailRequestControlRef = useRef(null);
  const historyConditionsRef = useRef(null);
  if (!wipesRequestControlRef.current) wipesRequestControlRef.current = createLatestRequestController();
  if (!detailRequestControlRef.current) detailRequestControlRef.current = createLatestRequestController();
  const isAdmin = user.role === 'admin';
  const canViewAll = canViewOperationalBackendData(user);
  const historyConditions = useMemo(() => ({
    selectedId,
    canViewAll,
    sort: historySort.sort,
    order: historySort.order
  }), [canViewAll, historySort.order, historySort.sort, selectedId]);
  if (!historyConditionsRef.current) historyConditionsRef.current = historyConditions;

  useLayoutEffect(() => {
    historyConditionsRef.current = historyConditions;
  }, [historyConditions]);

  async function loadWipes(preferredId = selectedId) {
    const requestControl = wipesRequestControlRef.current;
    const request = requestControl.begin();
    try {
      const payload = await api('/api/wipes', { signal: request.signal });
      if (!requestControl.isCurrent(request)) return;
      const nextWipes = payload.wipes || [];
      const nextSelectedId = nextWipes.some((wipe) => wipe.id === preferredId)
        ? preferredId
        : nextWipes[0]?.id || '';
      setWipes(nextWipes);
      setSelectedId(nextSelectedId);
      if (!nextSelectedId) setDetail(null);
    } catch (error) {
      if (!isAbortError(error)) throw error;
    } finally {
      requestControl.finish(request);
    }
  }

  useEffect(() => {
    wipesRequestControlRef.current.activate();
    detailRequestControlRef.current.activate();
    return () => {
      wipesRequestControlRef.current.dispose();
      detailRequestControlRef.current.dispose();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setInitialLoading(true);
    loadWipes('')
      .catch((err) => setError(localizeError(err.message, t)))
      .finally(() => {
        if (!cancelled) setInitialLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedId) {
      detailRequestControlRef.current.cancel();
      setDetail(null);
      setDetailLoading(false);
      return undefined;
    }
    const requestControl = detailRequestControlRef.current;
    const request = requestControl.begin();
    const requestKey = historyDetailRequestKey(historyConditions);
    setDetail((current) => (current?.wipe?.id === selectedId ? current : null));
    setDetailLoading(true);
    setError('');
    const params = new URLSearchParams({ scope: canViewAll ? 'all' : 'my_squad', sort: historySort.sort, order: historySort.order });
    api(`/api/wipes/${selectedId}?${params}`, { signal: request.signal })
      .then((payload) => {
        if (!requestControl.isCurrent(request) || requestKey !== historyDetailRequestKey(historyConditionsRef.current)) return;
        setDetail(payload);
        setError('');
      })
      .catch((err) => {
        if (!requestControl.isCurrent(request) || requestKey !== historyDetailRequestKey(historyConditionsRef.current) || isAbortError(err)) return;
        setError(localizeError(err.message, t));
      })
      .finally(() => {
        const isCurrent = requestControl.isCurrent(request) && requestKey === historyDetailRequestKey(historyConditionsRef.current);
        requestControl.finish(request);
        if (isCurrent) setDetailLoading(false);
      });
    return () => requestControl.cancel();
  }, [canViewAll, selectedId, historySort.sort, historySort.order]);

  const currentDetail = detail?.wipe?.id === selectedId ? detail : null;
  const selected = currentDetail?.wipe || wipes.find((wipe) => wipe.id === selectedId);
  const exportParams = selected ? new URLSearchParams({ scope: canViewAll ? 'all' : 'my_squad', sort: historySort.sort, order: historySort.order }) : null;
  const historySummary = useMemo(() => summarizeHistoryDetail(currentDetail), [currentDetail]);
  const historyTopValues = useMemo(() => {
    const keys = ['kills', 't3Kills', 'rockets', 'sulfur', 'metalOre', 'building'];
    const topRows = Object.fromEntries(keys.map((key) => [key, null]));
    for (const row of currentDetail?.rows || []) {
      for (const key of keys) {
        if (!topRows[key] || Number(row[key] || 0) > Number(topRows[key][key] || 0)) {
          topRows[key] = row;
        }
      }
    }
    return Object.fromEntries(keys.map((key) => {
      const row = topRows[key];
      if (!row) return [key, ''];
      const value = key === 'sulfur' || key === 'metalOre'
        ? formatCompactResource(row[key], lang)
        : formatStatNumber(row[key] || 0, lang);
      return [key, `${row.displayName || row.member?.displayName || row.steamId || '-'} · ${value}`];
    }));
  }, [currentDetail, lang]);
  const topHistoryValue = (key, legacySteamId = '') => {
    const rowValue = historyTopValues[key];
    if (rowValue) return rowValue;
    if (legacySteamId) return legacySteamId;
    return '-';
  };
  const settlementSummary = currentDetail?.wipe?.settlementSummary || selected?.settlementSummary || {};
  const topSummaryItems = [
    [t('topKills'), topHistoryValue('kills', settlementSummary.topKillsSteamId)],
    [t('topT3Kills'), topHistoryValue('t3Kills', settlementSummary.topT3KillsSteamId)],
    [t('topRockets'), topHistoryValue('rockets', settlementSummary.topRocketsSteamId)],
    [t('topSulfur'), topHistoryValue('sulfur', settlementSummary.topSulfurSteamId)],
    [t('topMetalOre'), topHistoryValue('metalOre', settlementSummary.topMetalOreSteamId)],
    [t('topBuilding'), topHistoryValue('building', settlementSummary.topBuildingSteamId)]
  ];
  const historyParticipantCount = historySummary.hasParticipantSnapshot
    ? historySummary.participantCount
    : Math.max(0, Math.floor(Number(selected?.participantCount) || 0));
  const historyKdaMemberCount = Math.max(0, Math.floor(Number(historySummary.kdaMemberCount) || 0));
  const historyUsesAllMembers = historySummary.kdaMemberScope === 'all_members' ||
    (historyKdaMemberCount > historyParticipantCount && historyKdaMemberCount > 0);
  const historyInfoCountItems = historyUsesAllMembers
    ? [
        [t('kdaMemberCount'), formatStatNumber(historyKdaMemberCount, lang)],
        [t('signupParticipantCount'), formatStatNumber(historyParticipantCount, lang)]
      ]
    : [[t('participantCount'), formatStatNumber(historyParticipantCount, lang)]];

  function sortHistory(sortKey) {
    if (!sortKey) return;
    setHistorySort((current) => ({
      sort: sortKey,
      order: current.sort === sortKey && current.order === 'desc' ? 'asc' : 'desc'
    }));
  }

  async function deleteWipe(wipe) {
    if (!wipe || !window.confirm(formatCopy(t('confirmDeleteWipe'), { name: wipe.name }))) return;
    setError('');
    try {
      await api(`/api/wipes/${wipe.id}`, { method: 'DELETE' });
      setToast(t('wipeDeleted'));
      await loadWipes('');
    } catch (err) {
      setError(localizeError(err.message, t));
    }
  }

  async function refreshSelectedDetail() {
    const conditions = historyConditionsRef.current;
    if (!conditions?.selectedId) return;
    const requestControl = detailRequestControlRef.current;
    const request = requestControl.begin();
    const requestKey = historyDetailRequestKey(conditions);
    const params = new URLSearchParams({
      scope: conditions.canViewAll ? 'all' : 'my_squad',
      sort: conditions.sort,
      order: conditions.order
    });
    try {
      const payload = await api(`/api/wipes/${conditions.selectedId}?${params}`, { signal: request.signal });
      if (requestControl.isCurrent(request) && requestKey === historyDetailRequestKey(historyConditionsRef.current)) {
        setDetail(payload);
        setError('');
      }
    } catch (error) {
      if (!isAbortError(error)) throw error;
    } finally {
      requestControl.finish(request);
    }
  }

  if (initialLoading) {
    return (
      <section className="page-stack history-page">
        {error && <Alert tone="danger">{error}</Alert>}
        <PageLoadingState title={t('history')} t={t} />
      </section>
    );
  }

  return (
    <section className="page-stack history-page">
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="split-grid">
        <div className="tool-panel">
          <h3>{t('history')}</h3>
          <div className="list-stack">
            {wipes.map((wipe) => (
              <button key={wipe.id} className={cx('list-row-button', selectedId === wipe.id && 'active')} onClick={() => setSelectedId(wipe.id)}>
                <strong>{wipe.name}</strong>
                <span>{wipe.serverName}</span>
                <small>{formatTime(wipe.startedAt, lang)} · {wipeStatusText(wipe.status, t)}</small>
              </button>
            ))}
            {!wipes.length && <div className="empty-state">{t('noWipes')}</div>}
          </div>
        </div>
        <div className="tool-panel">
          {selected ? (
            <div className="detail-stack">
              <div className="section-heading">
                <div className="heading-stack">
                  <h3>{selected.name}</h3>
                  <DataFreshnessMeta label={t('kdaDataTime')} value={currentDetail?.dataFreshness?.syncedAt} lang={lang} t={t} />
                </div>
                <div className="row-actions toolbar-compact">
                  <StatusBadge status={selected.status} t={t} />
                  {isAdmin && selected.status === 'closed' && (
                    <button type="button" className="action-button danger" title={t('deleteWipe')} onClick={() => deleteWipe(selected)}>
                      <Trash2 size={16} />
                      <span>{t('delete')}</span>
                    </button>
                  )}
                </div>
              </div>
              <InfoGrid items={[
                [t('serverName'), selected.serverName],
                [t('startedAt'), formatTime(selected.startedAt, lang)],
                [t('closed'), selected.closedAt ? formatTime(selected.closedAt, lang) : '-'],
                ...historyInfoCountItems,
                ...topSummaryItems
              ]} />
              {selected.notes && <Alert>{selected.notes}</Alert>}
              {exportParams && (
                <div className="row-actions export-actions">
                  <button type="button" className="primary-button fit-button export-button" title={t('exportHtml')} onClick={() => setExportModal('html')}>
                    <Download size={17} />
                    <span>{t('exportHtmlShort')}</span>
                  </button>
                  <button type="button" className="ghost-button fit-button export-button" title={t('exportPdf')} onClick={() => setExportModal('pdf')}>
                    <FileUp size={17} />
                    <span>{t('exportPdfShort')}</span>
                  </button>
                </div>
              )}
            </div>
          ) : <div className="empty-state">{t('noWipes')}</div>}
        </div>
      </div>
      {selected && detailLoading && (
        <HistoryDetailLoading selected={selected} t={t} />
      )}
      {selected && !detailLoading && currentDetail && (
        <section className="page-stack printable-history">
          <div className="tool-panel print-only">
            <div className="section-heading">
              <h3>{selected.name}</h3>
              <StatusBadge status={selected.status} t={t} />
            </div>
            <InfoGrid items={[
              [t('serverName'), selected.serverName],
              [t('startedAt'), formatTime(selected.startedAt, lang)],
              [t('closed'), selected.closedAt ? formatTime(selected.closedAt, lang) : '-'],
              ...historyInfoCountItems,
              ...topSummaryItems
            ]} />
            {selected.notes && <Alert>{selected.notes}</Alert>}
          </div>
          <div className="section-heading">
            <h3>{t('historyDetail')}</h3>
            {currentDetail.settlement?.generatedAt && <small>{t('generatedAt')}: {formatTime(currentDetail.settlement.generatedAt, lang)}</small>}
          </div>
          <div className="history-summary-grid">
            {historyUsesAllMembers && <MetricCard label={t('kdaMemberCount')} value={formatStatNumber(historyKdaMemberCount, lang)} />}
            <MetricCard label={historyUsesAllMembers ? t('signupParticipantCount') : t('participantCount')} value={formatStatNumber(historyParticipantCount, lang)} />
            <MetricCard label={t('totalSulfur')} value={formatCompactResource(historySummary.sulfur, lang)} />
            <MetricCard label={t('totalMetalOre')} value={formatCompactResource(historySummary.metalOre, lang)} />
            <MetricCard label={t('totalRockets')} value={formatStatNumber(historySummary.rockets, lang)} />
            <MetricCard label={t('totalKills')} value={formatStatNumber(historySummary.kills, lang)} />
            <MetricCard label={t('totalPlayDays')} value={formatPlayDays(historySummary.playDays, lang)} />
          </div>
          <KdaTable rows={currentDetail.rows || []} lang={lang} t={t} setToast={setToast} sortState={historySort} onSort={sortHistory} onProfileClick={setProfileMember} />
        </section>
      )}
      {exportModal && selected && exportParams && (
        <RankingExportModal
          format={exportModal}
          endpoint={`/api/wipes/${selected.id}/export`}
          subject={selected?.name || t('history')}
          baseParams={exportParams}
          squads={currentDetail?.squads || []}
          canExportAll={isAdmin}
          currentLang={lang}
          t={t}
          onClose={() => setExportModal(null)}
        />
      )}
      <MemberProfileDialogStack
        member={profileMember}
        user={user}
        lang={lang}
        t={t}
        setToast={setToast}
        onMemberUpdated={async () => {
          await refreshSelectedDetail();
        }}
        onOpenRustKdaLookup={onOpenRustKdaLookup}
        onClose={() => setProfileMember(null)}
      />
    </section>
  );
}


function HistoryDetailLoading({ selected, t }) {
  return <PageLoadingState title={selected?.name || t('historyDetailLoading')} t={t} compact />;
}

function RankingExportModal({ format, endpoint, subject, baseParams, squads = [], canExportAll = false, currentLang, t, onClose }) {
  const isPdf = format === 'pdf';
  const availableRankings = isPdf ? EXPORT_RANKINGS : HTML_EXPORT_RANKINGS;
  const [language, setLanguage] = useState(() => detectLanguage() || currentLang || 'zh');
  const [ranking, setRanking] = useState(() => (isPdf ? 'all' : 'kills'));
  const [selectedSquadIds, setSelectedSquadIds] = useState([]);
  const [timeRange, setTimeRange] = useState({ from: '', to: '' });
  const [exportState, setExportState] = useState('idle');
  const [exportProgress, setExportProgress] = useState(0);
  const [exportError, setExportError] = useState('');
  const autoCloseTimerRef = useRef(null);
  const exporting = exportState === 'generating' || exportState === 'downloading';
  const selectedRanking = availableRankings.find((item) => item.id === ranking) || availableRankings[0] || EXPORT_RANKINGS[1];
  const activeRanking = selectedRanking?.id || 'kills';
  const squadOptions = useMemo(() => {
    const seen = new Set();
    return (squads || [])
      .filter((squad) => {
        const id = String(squad?.id || '');
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .map((squad) => ({
        id: squad.id,
        name: squad.name || t('unassignedSquad'),
        participantCount: Number(squad.participantCount || 0),
        memberCount: Number(squad.memberCount || 0)
      }));
  }, [squads, t]);
  const selectedSquadCount = selectedSquadIds.length;
  const squadScopeLabel = selectedSquadCount
    ? formatCopy(t('selectedSquads'), { count: selectedSquadCount })
    : t('allSquads');
  const timeScopeLabel = timeRange.from || timeRange.to
    ? `${timeRange.from || '-'} ~ ${timeRange.to || '-'}`
    : t('exportAllTime');

  useEffect(() => {
    if (!availableRankings.some((item) => item.id === ranking)) {
      setRanking(availableRankings[0]?.id || 'kills');
    }
  }, [availableRankings, ranking]);

  useEffect(() => {
    const validIds = new Set(squadOptions.map((squad) => squad.id));
    setSelectedSquadIds((current) => {
      const next = current.filter((id) => validIds.has(id));
      return next.length === current.length ? current : next;
    });
  }, [squadOptions]);

  useEffect(() => () => {
    if (autoCloseTimerRef.current) window.clearTimeout(autoCloseTimerRef.current);
  }, []);

  function toggleSquad(squadId) {
    if (exporting) return;
    setSelectedSquadIds((current) => (
      current.includes(squadId)
        ? current.filter((id) => id !== squadId)
        : [...current, squadId]
    ));
  }

  async function submit(event) {
    event.preventDefault();
    if (exporting) return;
    const params = new URLSearchParams(baseParams);
    params.set('format', isPdf ? 'pdf' : 'html');
    params.set('language', language);
    params.set('ranking', activeRanking);
    params.set('timeZone', exportTimeZoneFor(language));
    params.delete('from');
    params.delete('to');
    const fromIso = datetimeLocalToIso(timeRange.from);
    const toIso = datetimeLocalToIso(timeRange.to);
    if (fromIso) params.set('from', fromIso);
    if (toIso) params.set('to', toIso);
    params.delete('squadId');
    params.delete('squadIds');
    if (selectedSquadIds.length) {
      params.set('scope', 'squad');
      params.set('squadIds', selectedSquadIds.join(','));
    } else {
      params.set('scope', canExportAll ? 'all' : 'my_squad');
    }
    setExportState('generating');
    setExportProgress(8);
    setExportError('');
    try {
      const response = await fetch(`${endpoint}?${params}`, { credentials: 'include' });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || t('requestFailed'));
      }
      setExportState('downloading');
      setExportProgress(20);
      await downloadFetchResponse(
        response,
        isPdf
          ? activeRanking === 'all' ? 'NB-Clan-rankings.zip' : 'NB-Clan-ranking.pdf'
          : 'NB-Clan-ranking.html',
        (percent) => setExportProgress((current) => Math.max(current, percent))
      );
      setExportState('complete');
      setExportProgress(100);
      if (isPdf) {
        autoCloseTimerRef.current = window.setTimeout(onClose, 250);
      }
    } catch (err) {
      setExportState('error');
      setExportError(localizeError(err.message, t) || t('exportFailed'));
    }
  }

  const exportProgressText = exportState === 'complete'
    ? t('exportReady')
    : exportState === 'downloading'
      ? t('exportDownloading')
      : exportState === 'error'
        ? exportError || t('exportFailed')
        : isPdf ? t('exportGenerating') : t('exportPreparing');

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal history-export-modal" role="dialog" aria-modal="true" aria-labelledby="ranking-export-title" onSubmit={submit}>
        <div className="modal-title">
          <div>
            <h3 id="ranking-export-title">{isPdf ? t('exportPdfOptions') : t('exportHtmlOptions')}</h3>
            <span className="modal-subtitle">{subject || '-'}</span>
          </div>
          <button type="button" className="icon-button" title={t('close')} onClick={onClose} disabled={exporting}>
            <X size={18} />
          </button>
        </div>
        <p className="modal-hint">{isPdf ? t('exportPdfHint') : t('exportHtmlHint')}</p>
        <div className="export-modal-fields">
          <label>
            <span>{t('exportLanguage')}</span>
            <select value={language} onChange={(event) => setLanguage(event.target.value)} disabled={exporting}>
              {LANGUAGES.map((item) => (
                <option key={item.id} value={item.id}>{languageOptionLabel(item, currentLang)}</option>
              ))}
            </select>
          </label>
          <label>
            <span>{t('exportRankingScope')}</span>
            <select value={activeRanking} onChange={(event) => setRanking(event.target.value)} disabled={exporting}>
              {availableRankings.map((item) => (
                <option key={item.id} value={item.id}>{t(item.labelKey)}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="export-ranking-preview">
          {availableRankings.map((item) => (
            <button
              type="button"
              key={item.id}
              className={cx('export-ranking-pill', activeRanking === item.id && 'active')}
              disabled={exporting}
              onClick={() => setRanking(item.id)}
            >
              {t(item.labelKey)}
            </button>
          ))}
        </div>
        <section className="export-time-section" aria-label={t('exportTimeRange')}>
          <div className="export-time-head">
            <span>{t('exportTimeRange')}</span>
            <b>{timeScopeLabel}</b>
          </div>
          <div className="export-modal-fields">
            <label>
              <span>{t('exportStartTime')}</span>
              <input
                type="datetime-local"
                value={timeRange.from}
                onChange={(event) => setTimeRange((current) => ({ ...current, from: event.target.value }))}
                disabled={exporting}
              />
            </label>
            <label>
              <span>{t('exportEndTime')}</span>
              <input
                type="datetime-local"
                value={timeRange.to}
                onChange={(event) => setTimeRange((current) => ({ ...current, to: event.target.value }))}
                disabled={exporting}
              />
            </label>
          </div>
          <p>{t('exportTimeHint')}</p>
        </section>
        {squadOptions.length > 0 && (
          <section className="export-squad-section" aria-label={t('exportSquadScope')}>
            <div className="export-squad-toolbar">
              <span>{t('exportSquadScope')}</span>
              <button
                type="button"
                className={cx('export-ranking-pill', selectedSquadIds.length === 0 && 'active')}
                disabled={exporting}
                onClick={() => setSelectedSquadIds([])}
              >
                {t('allSquads')}
              </button>
            </div>
            <div className="export-squad-list">
              {squadOptions.map((squad) => {
                const checked = selectedSquadIds.includes(squad.id);
                return (
                  <label key={squad.id} className={cx('export-squad-option', checked && 'active')}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={exporting}
                      onChange={() => toggleSquad(squad.id)}
                    />
                    <span>
                      <strong>{squad.name}</strong>
                      <small>{t('participantCount')}: {squad.participantCount || 0} · {t('memberCount')}: {squad.memberCount || 0}</small>
                    </span>
                  </label>
                );
              })}
            </div>
          </section>
        )}
        {exportState !== 'idle' && (
          <div className={cx('export-progress', exportState)} aria-live="polite">
            <div className="export-progress-row">
              <span>{exportProgressText}</span>
              {exportState !== 'error' && <strong>{exportProgress}%</strong>}
            </div>
            <div className="export-progress-track">
              <div style={{ width: `${exportProgress}%` }} />
            </div>
          </div>
        )}
        <div className="modal-actions">
          <span>{t('exportRankingScope')}: {t(selectedRanking?.labelKey || 'rankKills')} · {t('exportSquadScope')}: {squadScopeLabel}</span>
          <button type="button" className="ghost-button" onClick={onClose} disabled={exporting}>{t('cancel')}</button>
          <button className="primary-button" title={t('exportConfirm')} disabled={exporting}>
            {isPdf ? <FileUp size={17} /> : <Download size={17} />}
            <span>{exporting ? t('loading') : t('exportConfirm')}</span>
          </button>
        </div>
      </form>
    </div>
  );
}


function summarizeHistoryDetail(detail) {
  const rows = detail?.rows || [];
  const participantCount = Array.isArray(detail?.participants) ? detail.participants.length : 0;
  const kdaMemberKeys = new Set();
  rows.forEach((row, index) => {
    const key = row?.memberId || row?.member?.id || row?.steamId || row?.steamId64 || row?.id || `row:${index}`;
    kdaMemberKeys.add(String(key));
  });
  const playDays = calculateWipePlayDays(detail?.wipe);
  return rows.reduce((acc, row) => ({
    participantCount,
    hasParticipantSnapshot: Array.isArray(detail?.participants),
    kdaMemberCount: kdaMemberKeys.size,
    kdaMemberScope: detail?.settlement?.kdaMemberScope || detail?.wipe?.kdaMemberScope || null,
    kills: acc.kills + Number(row.kills || 0),
    sulfur: acc.sulfur + Number(row.sulfur || 0),
    metalOre: acc.metalOre + Number(row.metalOre || 0),
    rockets: acc.rockets + Number(row.rockets || 0),
    playDays
  }), {
    participantCount,
    hasParticipantSnapshot: Array.isArray(detail?.participants),
    kdaMemberCount: kdaMemberKeys.size,
    kdaMemberScope: detail?.settlement?.kdaMemberScope || detail?.wipe?.kdaMemberScope || null,
    kills: 0,
    sulfur: 0,
    metalOre: 0,
    rockets: 0,
    playDays
  });
}


function DataFreshnessMeta({ label, value, lang, t }) {
  return (
    <span className="data-freshness-meta">
      <CalendarClock size={15} />
      <span>{label}: {formatTime(value, lang) || t('notSyncedYet')}</span>
    </span>
  );
}


const KdaTable = React.memo(function KdaTable({ rows, lang = 'zh', t, setToast, sortState = null, onSort = null, onProfileClick = null }) {
  const columns = useMemo(() => KDA_TABLE_COLUMNS.map((column) => {
    const label = t(column.label);
    if (!column.sortKey || !onSort) return { key: column.id, content: label, label };
    const isActive = sortState?.sort === column.sortKey;
    const SortIcon = isActive ? (sortState.order === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
    return {
      key: column.id,
      label,
      content: (
        <button
          type="button"
          className={cx('table-sort-button', isActive && 'active')}
          title={`${t('sortByField')}: ${label}`}
          onClick={() => onSort(column.sortKey)}
        >
          <span>{label}</span>
          <SortIcon size={14} />
        </button>
      )
    };
  }), [onSort, sortState?.order, sortState?.sort, t]);
  return (
    <DataTable className="kda-table" columns={columns} emptyText={t('noKda')}>
      {(rows || []).map((row, index) => (
        <tr key={row.id || row.memberId || row.steamId}>
          <td>{index + 1}</td>
          <td><KdaMemberName row={row} t={t} setToast={setToast} onProfileClick={onProfileClick} /></td>
          <td>{row.squadName || t('unassignedSquad')}</td>
          <td>{formatPlayTimeMinutes(kdaRowOnlineMinutes(row), lang)}</td>
          <td>{row.kills || 0}</td>
          <td>{row.t3Kills || 0}</td>
          <td>{row.deaths || 0}</td>
          <td>{row.kda || 0}</td>
          <td>{row.rockets || 0}</td>
          <td>{formatCompactResource(row.sulfur, lang)}</td>
          <td>{formatCompactResource(row.metalOre, lang)}</td>
          <td>{row.building || 0}</td>
        </tr>
      ))}
    </DataTable>
  );
});

function KdaMemberName({ row, t, setToast, onProfileClick = null }) {
  const member = normalizeMemberProfileCandidate(row || {});
  const steamId = row?.steamId || member.steamId || '';
  const steamNickname = member.steamNickname || row?.steamNickname || '';
  const customName = member.customName || row?.customName || '';
  const displayName = member.displayName || row?.displayName || steamId || '-';
  const steamLine = steamNickname && customName ? `${t('steamNicknamePrefix')}: ${steamNickname}` : '\u00a0';
  const avatar = <Avatar member={member} />;
  const canOpenProfile = Boolean(onProfileClick && member?.id);
  return (
    <div className="member-name-cell kda-member-name-cell">
      {canOpenProfile ? (
        <button type="button" className="avatar-profile-button" title={t('viewProfile')} onClick={() => onProfileClick(member)}>
          {avatar}
        </button>
      ) : avatar}
      <div className="member-name-text kda-member-name-text">
        <div className="strong-cell">{displayName}</div>
        <small className={cx('member-name-steam', !steamNickname || !customName ? 'placeholder-line' : '')}>{steamLine}</small>
        <button
          type="button"
          className="steam-copy-line mono"
          title={steamId ? t('copy') : undefined}
          onClick={() => steamId && copyText(steamId, setToast, t)}
          disabled={!steamId}
        >
          {steamId || '-'}
        </button>
      </div>
    </div>
  );
}
