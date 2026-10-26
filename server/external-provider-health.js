const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 2 * 60 * 1000;
const DEFAULT_STATE_LIMIT = 100;

const providerStates = new Map();

function normalizeText(value, maxLength = 240) {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, maxLength);
}

function envInteger(name, fallback, min, max) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function failureThreshold() {
  return envInteger('NB_EXTERNAL_PROVIDER_CIRCUIT_FAILURE_THRESHOLD', DEFAULT_FAILURE_THRESHOLD, 1, 20);
}

function cooldownMs() {
  return envInteger('NB_EXTERNAL_PROVIDER_CIRCUIT_COOLDOWN_MS', DEFAULT_COOLDOWN_MS, 10_000, 60 * 60 * 1000);
}

function stateLimit() {
  return envInteger('NB_EXTERNAL_PROVIDER_HEALTH_STATE_LIMIT', DEFAULT_STATE_LIMIT, 10, 1000);
}

function providerStateKey(provider, scope = 'global') {
  const normalizedProvider = normalizeText(provider, 80) || 'unknown';
  const normalizedScope = normalizeText(scope, 160) || 'global';
  return `${normalizedProvider}:${normalizedScope}`;
}

function providerState(provider, scope = 'global') {
  const key = providerStateKey(provider, scope);
  if (!providerStates.has(key)) {
    if (providerStates.size >= stateLimit()) {
      const firstKey = providerStates.keys().next().value;
      if (firstKey) providerStates.delete(firstKey);
    }
    providerStates.set(key, {
      key,
      provider: normalizeText(provider, 80) || 'unknown',
      scope: normalizeText(scope, 160) || 'global',
      total: 0,
      succeeded: 0,
      failed: 0,
      retryableFailed: 0,
      consecutiveFailures: 0,
      openedAt: '',
      openedUntil: '',
      lastSuccessAt: '',
      lastFailureAt: '',
      lastError: '',
      lastStatus: 0
    });
  }
  return providerStates.get(key);
}

function errorStatus(error) {
  const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
  return Number.isFinite(status) ? status : 0;
}

export function retryableExternalProviderError(error) {
  if (error?.circuitOpen) return false;
  const status = errorStatus(error);
  if (status === 429 || status === 408 || status === 425 || status === 504) return true;
  if (status >= 500) return true;
  if (!status && ['AbortError', 'TimeoutError'].includes(error?.name)) return true;
  if (!status && ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(error?.code)) return true;
  return false;
}

function publicProviderState(state, nowMs = Date.now()) {
  const openedUntilMs = Date.parse(state.openedUntil || '');
  const open = Number.isFinite(openedUntilMs) && openedUntilMs > nowMs;
  const halfOpen = Number.isFinite(openedUntilMs) && openedUntilMs > 0 && openedUntilMs <= nowMs && state.consecutiveFailures > 0;
  return {
    key: state.key,
    provider: state.provider,
    scope: state.scope,
    status: open ? 'open' : (halfOpen ? 'half_open' : 'closed'),
    total: state.total,
    succeeded: state.succeeded,
    failed: state.failed,
    retryableFailed: state.retryableFailed,
    consecutiveFailures: state.consecutiveFailures,
    failureRate: state.total ? Number((state.failed / state.total).toFixed(4)) : 0,
    retryableFailureRate: state.total ? Number((state.retryableFailed / state.total).toFixed(4)) : 0,
    openedAt: state.openedAt,
    openedUntil: open ? state.openedUntil : '',
    retryAfterSeconds: open ? Math.max(0, Math.ceil((openedUntilMs - nowMs) / 1000)) : 0,
    lastSuccessAt: state.lastSuccessAt,
    lastFailureAt: state.lastFailureAt,
    lastError: state.lastError,
    lastStatus: state.lastStatus
  };
}

export function assertExternalProviderAvailable(provider, scope = 'global', options = {}) {
  if (options.bypass) return;
  const state = providerState(provider, scope);
  const snapshot = publicProviderState(state);
  if (snapshot.status !== 'open') return;
  const error = new Error(`${state.provider} provider circuit is open for ${state.scope}`);
  error.status = 503;
  error.code = 'external_provider_circuit_open';
  error.provider = state.provider;
  error.scope = state.scope;
  error.retryAfterSeconds = snapshot.retryAfterSeconds;
  error.circuitOpen = true;
  throw error;
}

export function recordExternalProviderSuccess(provider, scope = 'global') {
  const state = providerState(provider, scope);
  const now = new Date().toISOString();
  state.total += 1;
  state.succeeded += 1;
  state.consecutiveFailures = 0;
  state.openedAt = '';
  state.openedUntil = '';
  state.lastSuccessAt = now;
  state.lastError = '';
  state.lastStatus = 0;
  return publicProviderState(state);
}

export function recordExternalProviderFailure(provider, error, scope = 'global') {
  const state = providerState(provider, scope);
  const now = new Date();
  const retryable = retryableExternalProviderError(error);
  state.total += 1;
  state.failed += 1;
  state.lastFailureAt = now.toISOString();
  state.lastError = normalizeText(error?.message || error, 500);
  state.lastStatus = errorStatus(error);
  if (retryable) {
    state.retryableFailed += 1;
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= failureThreshold()) {
      state.openedAt = now.toISOString();
      state.openedUntil = new Date(now.getTime() + cooldownMs()).toISOString();
    }
  }
  return publicProviderState(state);
}

export function externalProviderHealthSnapshot(extra = {}) {
  const nowMs = Date.now();
  const circuits = [...providerStates.values()]
    .map((state) => publicProviderState(state, nowMs))
    .toSorted((left, right) => (
      Number(right.status === 'open') - Number(left.status === 'open') ||
      Date.parse(right.lastFailureAt || right.lastSuccessAt || 0) - Date.parse(left.lastFailureAt || left.lastSuccessAt || 0)
    ));
  const totals = circuits.reduce((sum, state) => ({
    total: sum.total + Number(state.total || 0),
    succeeded: sum.succeeded + Number(state.succeeded || 0),
    failed: sum.failed + Number(state.failed || 0),
    retryableFailed: sum.retryableFailed + Number(state.retryableFailed || 0)
  }), {
    total: 0,
    succeeded: 0,
    failed: 0,
    retryableFailed: 0
  });
  return {
    threshold: failureThreshold(),
    cooldownMs: cooldownMs(),
    openCount: circuits.filter((state) => state.status === 'open').length,
    halfOpenCount: circuits.filter((state) => state.status === 'half_open').length,
    total: totals.total,
    succeeded: totals.succeeded,
    failed: totals.failed,
    retryableFailed: totals.retryableFailed,
    failureRate: totals.total ? Number((totals.failed / totals.total).toFixed(4)) : 0,
    retryableFailureRate: totals.total ? Number((totals.retryableFailed / totals.total).toFixed(4)) : 0,
    failingProviderCount: circuits.filter((state) => Number(state.failed || 0) > 0).length,
    retryableFailingProviderCount: circuits.filter((state) => Number(state.retryableFailed || 0) > 0).length,
    circuits,
    ...extra
  };
}

export function resetExternalProviderHealthForTests() {
  providerStates.clear();
}
