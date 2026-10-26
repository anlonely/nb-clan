import { createId, normalizeText, nowIso } from './store.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function timestampForSort(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}

export function normalizeBattlemetricsQueueMeta(input = {}) {
  const source = ['manual-query', 'manual-sync', 'hourly-sync', 'system'].includes(input.source)
    ? input.source
    : 'manual-sync';
  const defaultPriority = source === 'manual-query' ? 100 : source === 'manual-sync' ? 60 : source === 'hourly-sync' ? 10 : 40;
  const priority = Number.isFinite(Number(input.priority)) ? Number(input.priority) : defaultPriority;
  return {
    source,
    priority,
    operation: normalizeText(input.operation || 'request', 80),
    label: normalizeText(input.label || input.operation || 'BattleMetrics request', 120)
  };
}

export function battlemetricsQueueMetaForSync({ manual = false, statusKey = 'battlemetrics' } = {}) {
  if (statusKey === 'battlemetricsQuery') {
    return {
      source: 'manual-query',
      priority: 100,
      operation: 'member_query',
      label: 'Member query realtime refresh'
    };
  }
  if (manual) {
    return {
      source: 'manual-sync',
      priority: 60,
      operation: 'manual_sync',
      label: 'Manual online-time sync'
    };
  }
  return {
    source: 'hourly-sync',
    priority: 10,
    operation: 'hourly_sync',
    label: 'Hourly online-time sync'
  };
}

export function battlemetricsQueueMetaForIdentitySync() {
  return {
    source: 'system',
    priority: 40,
    operation: 'match_players',
    label: 'Match BattleMetrics player IDs'
  };
}

export function createBattlemetricsQueueRuntime({
  minIntervalMs = 250,
  requestsPerMinute = 240,
  autoRequestsPerMinute = Math.floor(Number(requestsPerMinute || 240) * 0.75),
  rateLimitWindowMs = 60_000,
  rateLimitSafetyFactor = 0.8,
  rateLimitHeadroom = 2,
  blockedBackoffMs = 3 * 60_000,
  createIdImpl = createId,
  nowIsoImpl = nowIso,
  sleepImpl = sleep
} = {}) {
  let queuedTasks = [];
  let running = false;
  let sequence = 0;
  let activeTask = null;
  let completedTasks = 0;
  let failedTasks = 0;
  let lastCompletedTask = null;
  let lastFailedTask = null;
  let lastRequestAt = 0;
  let blockedUntil = 0;
  let rateLimitedUntil = 0;
  let adaptiveMinuteLimit = Math.max(1, Number(requestsPerMinute || 240));
  let requestWindow = [];
  let autoRequestWindow = [];

  const normalizedMinIntervalMs = Math.max(0, Number(minIntervalMs || 0));
  const normalizedRequestsPerMinute = Math.max(1, Number(requestsPerMinute || 240));
  const normalizedAutoRequestsPerMinute = Math.max(
    1,
    Math.min(normalizedRequestsPerMinute, Number(autoRequestsPerMinute || Math.floor(normalizedRequestsPerMinute * 0.75)))
  );
  const normalizedRateLimitWindowMs = Math.max(1, Number(rateLimitWindowMs || 60_000));
  const normalizedSafetyFactor = Math.min(1, Math.max(0.1, Number(rateLimitSafetyFactor || 0.8)));
  const normalizedHeadroom = Math.max(0, Number(rateLimitHeadroom || 0));
  const normalizedBlockedBackoffMs = Math.max(1, Number(blockedBackoffMs || 3 * 60_000));

  function pruneRequestWindow(now = Date.now()) {
    requestWindow = requestWindow.filter((timestamp) => now - timestamp < normalizedRateLimitWindowMs);
  }

  function pruneAutoRequestWindow(now = Date.now()) {
    autoRequestWindow = autoRequestWindow.filter((timestamp) => now - timestamp < normalizedRateLimitWindowMs);
  }

  function minuteLimit() {
    const adaptiveLimit = Number.isFinite(adaptiveMinuteLimit) ? adaptiveMinuteLimit : normalizedRequestsPerMinute;
    return Math.max(1, Math.floor(Math.min(normalizedRequestsPerMinute, adaptiveLimit)));
  }

  function autoMinuteLimit() {
    return Math.max(1, Math.min(normalizedAutoRequestsPerMinute, Math.floor(minuteLimit() * 0.75)));
  }

  function minuteWindowWaitMs(now = Date.now()) {
    pruneRequestWindow(now);
    const limit = minuteLimit();
    if (requestWindow.length < limit) return 0;
    return Math.max(0, requestWindow[0] + normalizedRateLimitWindowMs + normalizedMinIntervalMs - now);
  }

  function autoMinuteWindowWaitMs(queueMeta, now = Date.now()) {
    if (queueMeta?.source !== 'hourly-sync') return 0;
    pruneAutoRequestWindow(now);
    const limit = autoMinuteLimit();
    if (autoRequestWindow.length < limit) return 0;
    return Math.max(0, autoRequestWindow[0] + normalizedRateLimitWindowMs + normalizedMinIntervalMs - now);
  }

  function taskPayload(task) {
    if (!task) return null;
    const createdMs = timestampForSort(task.createdAt);
    return {
      id: task.id,
      source: task.source,
      priority: task.priority,
      operation: task.operation,
      label: task.label,
      createdAt: task.createdAt,
      startedAt: task.startedAt || '',
      completedAt: task.completedAt || '',
      durationMs: Number(task.durationMs || 0),
      waitSeconds: createdMs ? Math.max(0, Math.ceil((Date.now() - createdMs) / 1000)) : 0,
      error: task.error || ''
    };
  }

  function snapshot() {
    const now = Date.now();
    pruneRequestWindow(now);
    pruneAutoRequestWindow(now);
    const limit = minuteLimit();
    const autoLimit = autoMinuteLimit();
    const pendingBySource = queuedTasks.reduce((counts, task) => {
      counts[task.source] = (counts[task.source] || 0) + 1;
      return counts;
    }, {});
    const nextAvailableWaitMs = Math.max(
      lastRequestAt ? normalizedMinIntervalMs - (now - lastRequestAt) : 0,
      minuteWindowWaitMs(now),
      rateLimitedUntil > now ? rateLimitedUntil - now : 0,
      blockedUntil > now ? blockedUntil - now : 0
    );
    return {
      running,
      pendingCount: queuedTasks.length,
      active: taskPayload(activeTask),
      pending: queuedTasks
        .slice()
        .sort((left, right) => right.priority - left.priority || left.sequence - right.sequence)
        .slice(0, 8)
        .map(taskPayload),
      pendingBySource: {
        manualQuery: pendingBySource['manual-query'] || 0,
        manualSync: pendingBySource['manual-sync'] || 0,
        hourlySync: pendingBySource['hourly-sync'] || 0,
        system: pendingBySource.system || 0
      },
      totals: {
        completed: completedTasks,
        failed: failedTasks
      },
      limits: {
        minIntervalMs: normalizedMinIntervalMs,
        globalPerMinute: limit,
        globalUsed: requestWindow.length,
        globalRemaining: Math.max(0, limit - requestWindow.length),
        autoPerMinute: autoLimit,
        autoUsed: autoRequestWindow.length,
        autoRemaining: Math.max(0, autoLimit - autoRequestWindow.length),
        manualReservePerMinute: Math.max(0, limit - autoLimit),
        rateLimitedUntil: rateLimitedUntil > now ? new Date(rateLimitedUntil).toISOString() : '',
        blockedUntil: blockedUntil > now ? new Date(blockedUntil).toISOString() : '',
        nextAvailableAt: nextAvailableWaitMs > 0 ? new Date(now + nextAvailableWaitMs).toISOString() : '',
        nextAvailableInSeconds: Math.max(0, Math.ceil(nextAvailableWaitMs / 1000))
      },
      lastCompleted: taskPayload(lastCompletedTask),
      lastFailed: taskPayload(lastFailedTask),
      updatedAt: nowIsoImpl()
    };
  }

  async function waitTurn(queueMeta = {}) {
    while (true) {
      const now = Date.now();
      const elapsed = now - lastRequestAt;
      const intervalWaitMs = lastRequestAt ? normalizedMinIntervalMs - elapsed : 0;
      const minuteWaitMs = minuteWindowWaitMs(now);
      const autoMinuteWaitMs = autoMinuteWindowWaitMs(queueMeta, now);
      const serverWaitMs = rateLimitedUntil > now ? rateLimitedUntil - now : 0;
      const cloudflareWaitMs = blockedUntil > now ? blockedUntil - now : 0;
      const waitMs = Math.max(intervalWaitMs, minuteWaitMs, autoMinuteWaitMs, serverWaitMs, cloudflareWaitMs);
      if (waitMs <= 0) break;
      await sleepImpl(waitMs);
    }
    const timestamp = Date.now();
    pruneRequestWindow(timestamp);
    pruneAutoRequestWindow(timestamp);
    lastRequestAt = timestamp;
    requestWindow.push(timestamp);
    if (queueMeta?.source === 'hourly-sync') {
      autoRequestWindow.push(timestamp);
    }
  }

  function observeRateLimitHeaders(headers) {
    if (!headers?.get) return;
    const headerLimitValue = headers.get('x-rate-limit-limit');
    const headerRemainingValue = headers.get('x-rate-limit-remaining');
    const headerLimit = headerLimitValue == null ? NaN : Number(headerLimitValue);
    const headerRemaining = headerRemainingValue == null ? NaN : Number(headerRemainingValue);
    if (Number.isFinite(headerLimit) && headerLimit > 0) {
      adaptiveMinuteLimit = Math.max(1, Math.floor(headerLimit * normalizedSafetyFactor));
    }
    if (Number.isFinite(headerRemaining) && headerRemaining <= normalizedHeadroom) {
      const now = Date.now();
      pruneRequestWindow(now);
      const fallbackUntil = now + normalizedRateLimitWindowMs;
      const localWindowUntil = requestWindow[0]
        ? requestWindow[0] + normalizedRateLimitWindowMs + normalizedMinIntervalMs
        : fallbackUntil;
      rateLimitedUntil = Math.max(rateLimitedUntil, localWindowUntil);
    }
  }

  function markRateLimited(delayMs = normalizedRateLimitWindowMs) {
    rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + Math.max(0, Number(delayMs || 0)));
  }

  function markBlocked(delayMs = normalizedBlockedBackoffMs) {
    blockedUntil = Math.max(blockedUntil, Date.now() + Math.max(1, Number(delayMs || normalizedBlockedBackoffMs)));
  }

  function blockedUntilMs() {
    return blockedUntil;
  }

  function startRunner() {
    if (running) return;
    running = true;
    void (async () => {
      try {
        while (queuedTasks.length) {
          let nextIndex = 0;
          for (let index = 1; index < queuedTasks.length; index += 1) {
            const candidate = queuedTasks[index];
            const current = queuedTasks[nextIndex];
            if (candidate.priority > current.priority || (candidate.priority === current.priority && candidate.sequence < current.sequence)) {
              nextIndex = index;
            }
          }
          const [task] = queuedTasks.splice(nextIndex, 1);
          activeTask = task;
          task.startedAt = nowIsoImpl();
          const startedMs = Date.now();
          try {
            const result = await task.run(task);
            task.completedAt = nowIsoImpl();
            task.durationMs = Date.now() - startedMs;
            completedTasks += 1;
            lastCompletedTask = task;
            task.resolve(result);
          } catch (error) {
            task.completedAt = nowIsoImpl();
            task.durationMs = Date.now() - startedMs;
            task.error = normalizeText(error.message || 'BattleMetrics request failed', 240);
            failedTasks += 1;
            lastFailedTask = task;
            task.reject(error);
          } finally {
            activeTask = null;
          }
        }
      } finally {
        running = false;
        if (queuedTasks.length) startRunner();
      }
    })();
  }

  function enqueue({ meta = {}, run } = {}) {
    const queueMeta = normalizeBattlemetricsQueueMeta(meta);
    return new Promise((resolve, reject) => {
      queuedTasks.push({
        id: createIdImpl('bm_task'),
        sequence: ++sequence,
        createdAt: nowIsoImpl(),
        startedAt: '',
        completedAt: '',
        durationMs: 0,
        error: '',
        ...queueMeta,
        run,
        resolve,
        reject
      });
      startRunner();
    });
  }

  function resetForTests() {
    queuedTasks = [];
    running = false;
    sequence = 0;
    activeTask = null;
    completedTasks = 0;
    failedTasks = 0;
    lastCompletedTask = null;
    lastFailedTask = null;
    lastRequestAt = 0;
    blockedUntil = 0;
    rateLimitedUntil = 0;
    adaptiveMinuteLimit = normalizedRequestsPerMinute;
    requestWindow = [];
    autoRequestWindow = [];
  }

  return {
    blockedUntilMs,
    enqueue,
    markBlocked,
    markRateLimited,
    normalizeMeta: normalizeBattlemetricsQueueMeta,
    observeRateLimitHeaders,
    resetForTests,
    snapshot,
    waitTurn
  };
}
