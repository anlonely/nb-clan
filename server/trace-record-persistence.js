import { nowIso } from './store.js';

const DEFAULT_RETRY_ATTEMPTS = 1;
const DEFAULT_RETRY_DELAY_MS = 25;
const DEFAULT_FALLBACK_WINDOW_MS = 60_000;
const DEFAULT_FALLBACK_MAX_PER_WINDOW = 0;

const persistenceStats = new Map();

function envInteger(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function tracePersistenceConfig() {
  return {
    directRetryAttempts: envInteger(
      process.env.NB_TRACE_RECORD_DIRECT_RETRY_ATTEMPTS,
      DEFAULT_RETRY_ATTEMPTS,
      0,
      3
    ),
    directRetryDelayMs: envInteger(
      process.env.NB_TRACE_RECORD_DIRECT_RETRY_DELAY_MS,
      DEFAULT_RETRY_DELAY_MS,
      0,
      1000
    ),
    genericFallbackEnabled: false,
    genericFallbackMaxPerWindow: DEFAULT_FALLBACK_MAX_PER_WINDOW,
    genericFallbackWindowMs: DEFAULT_FALLBACK_WINDOW_MS
  };
}

function tracePersistenceRecord(name) {
  const key = String(name || 'trace_record');
  if (!persistenceStats.has(key)) {
    persistenceStats.set(key, {
      name: key,
      directFailures: 0,
      directRetryAttempts: 0,
      directRetrySucceeded: 0,
      directRetryFailed: 0,
      fallbackAttempts: 0,
      fallbackSucceeded: 0,
      fallbackFailed: 0,
      fallbackSuppressed: 0,
      fallbackWindowStartedAtMs: 0,
      fallbackWindowCount: 0,
      lastDirectError: '',
      lastFallbackError: '',
      lastAt: ''
    });
  }
  return persistenceStats.get(key);
}

function errorMessage(error) {
  return error?.message || String(error || '');
}

function wait(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function persistTraceRecordWithFallback({
  name,
  direct,
  fallbackValue = null,
  warn = console.warn
} = {}) {
  const record = tracePersistenceRecord(name);
  const config = tracePersistenceConfig();
  for (let attempt = 0; attempt <= config.directRetryAttempts; attempt += 1) {
    try {
      const result = await direct();
      if (attempt > 0) record.directRetrySucceeded += 1;
      return result;
    } catch (error) {
      record.lastAt = nowIso();
      record.lastDirectError = errorMessage(error);
      if (attempt === 0) record.directFailures += 1;
      else record.directRetryFailed += 1;
      if (attempt < config.directRetryAttempts) {
        record.directRetryAttempts += 1;
        await wait(config.directRetryDelayMs * (attempt + 1));
      }
    }
  }

  record.fallbackSuppressed += 1;
  record.lastAt = nowIso();
  warn?.(`[nb-clan] sqlite ${record.name} generic fallback suppressed: ${record.lastDirectError}`);
  return fallbackValue;
}

export function traceRecordPersistenceSnapshot() {
  return {
    config: tracePersistenceConfig(),
    records: [...persistenceStats.values()].map((record) => ({
      name: record.name,
      directFailures: record.directFailures,
      directRetryAttempts: record.directRetryAttempts,
      directRetrySucceeded: record.directRetrySucceeded,
      directRetryFailed: record.directRetryFailed,
      fallbackAttempts: record.fallbackAttempts,
      fallbackSucceeded: record.fallbackSucceeded,
      fallbackFailed: record.fallbackFailed,
      fallbackSuppressed: record.fallbackSuppressed,
      fallbackWindowCount: record.fallbackWindowCount,
      lastDirectError: record.lastDirectError,
      lastFallbackError: record.lastFallbackError,
      lastAt: record.lastAt
    }))
  };
}

export function resetTraceRecordPersistenceForTests() {
  persistenceStats.clear();
}
