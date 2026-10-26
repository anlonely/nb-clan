export const KDA_SYNC_BATCH_SIZE = 10;
export const KDA_SYNC_BATCH_DELAY_MS = 450;
export const KDA_SYNC_BATCH_REQUEST_ESTIMATE_MS = 1800;
export const KDA_SYNC_COOLDOWN_SECONDS = 180;

const HIDDEN_PAGE_POLL_DELAY_MS = 5000;

export function isPageHidden() {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function visibleAwarePollDelay(delayMs) {
  const normalizedDelay = Math.max(0, Number(delayMs) || 0);
  return isPageHidden() ? Math.max(normalizedDelay, HIDDEN_PAGE_POLL_DELAY_MS) : normalizedDelay;
}

export function schedulePollTimeout(timerRef, callback, delayMs) {
  if (timerRef.current) clearTimeout(timerRef.current);
  timerRef.current = setTimeout(callback, visibleAwarePollDelay(delayMs));
}

export function deferPollWhileHidden(timerRef, callback, delayMs) {
  if (!isPageHidden()) return false;
  schedulePollTimeout(timerRef, callback, delayMs);
  return true;
}

export function syncUiStateFromServer(state = {}) {
  if (state.status === 'queued') return 'syncing';
  if (state.status === 'running') return 'syncing';
  if (state.status === 'complete') return 'complete';
  if (state.status === 'failed') return 'error';
  if (state.status === 'cancelled') return 'complete';
  if (state.status === 'rate_limited') return 'rateLimited';
  return 'idle';
}

export function syncProgressFromServer(state = {}, fallbackTotal = 0) {
  const total = Math.max(0, Number(state.requested ?? fallbackTotal) || 0);
  const completed = Math.max(0, Math.min(total || Number(state.completed || 0), Number(state.completed || 0)));
  const percent = Number.isFinite(Number(state.percent))
    ? Number(state.percent)
    : (total ? Math.round((completed / total) * 100) : 0);
  return {
    total,
    completed,
    percent: Math.max(0, Math.min(100, percent)),
    etaSeconds: Math.max(0, Math.ceil(Number(state.etaSeconds || 0)))
  };
}

export function syncVisualProgressPercent(state, percent) {
  const normalizedPercent = Math.max(0, Math.min(100, Number(percent || 0)));
  if (state === 'complete') return 100;
  if (state === 'rateLimited') return 100 - normalizedPercent;
  return normalizedPercent;
}

export function shouldShowFinishedSyncState(state = {}) {
  const status = state.status || '';
  if (status !== 'complete' && status !== 'failed') return true;
  const updatedMs = Date.parse(state.updatedAt || state.syncedAt || '');
  return Number.isFinite(updatedMs) && Date.now() - updatedMs < 5 * 60 * 1000;
}

export function estimateKdaSyncSeconds(total) {
  const normalizedTotal = Math.max(0, Math.floor(Number(total) || 0));
  if (!normalizedTotal) return 3;
  const batches = Math.max(1, Math.ceil(normalizedTotal / KDA_SYNC_BATCH_SIZE));
  const requestBudgetMs = batches * KDA_SYNC_BATCH_REQUEST_ESTIMATE_MS;
  const throttleBudgetMs = Math.max(0, batches - 1) * KDA_SYNC_BATCH_DELAY_MS;
  return Math.max(3, Math.ceil((requestBudgetMs + throttleBudgetMs) / 1000));
}
