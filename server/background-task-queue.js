const QUEUE_NAMES = ['default', 'interaction', 'member_profile', 'sync'];
const DEFAULT_MAX_PENDING = 100;
const DEFAULT_TASK_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_TASK_DEADLINE_MS = 60 * 60 * 1000;

function createQueueMetrics() {
  return {
    completed: 0,
    failed: 0,
    rejected: 0,
    timedOut: 0,
    expired: 0,
    deduplicated: 0,
    merged: 0,
    maxObservedPending: 0,
    oldestRunningStartedAtMs: 0,
    lastStartedAt: '',
    lastFinishedAt: '',
    lastFailedAt: '',
    lastRejectedAt: '',
    lastTimedOutAt: '',
    lastExpiredAt: '',
    lastError: ''
  };
}

function createQueueState(name) {
  return {
    name,
    pending: [],
    running: null,
    keyed: new Map(),
    pumpScheduled: false,
    metrics: createQueueMetrics()
  };
}

const queueStates = Object.fromEntries(QUEUE_NAMES.map((name) => [name, createQueueState(name)]));
let acceptingBackgroundTasks = true;

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function queueNameFromOptions(options = {}) {
  return ['interaction', 'member_profile', 'sync'].includes(options?.queue) ? options.queue : 'default';
}

function queueEnvKey(queueName, suffix) {
  return `NB_BACKGROUND_TASK_${queueName.toUpperCase()}_${suffix}`;
}

function configuredQueueNumber(queueName, suffix, fallback) {
  return positiveInteger(
    process.env[queueEnvKey(queueName, suffix)] ?? process.env[`NB_BACKGROUND_TASK_${suffix}`],
    fallback
  );
}

function maxPendingFor(queueName, value) {
  return positiveInteger(
    value,
    configuredQueueNumber(queueName, 'MAX_PENDING', DEFAULT_MAX_PENDING)
  );
}

function timeoutMsFor(queueName, value) {
  return positiveInteger(
    value,
    configuredQueueNumber(queueName, 'TIMEOUT_MS', DEFAULT_TASK_TIMEOUT_MS)
  );
}

function deadlineMsFor(queueName, value) {
  return positiveInteger(
    value,
    configuredQueueNumber(queueName, 'DEADLINE_MS', DEFAULT_TASK_DEADLINE_MS)
  );
}

function normalizeKey(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, 500);
}

function normalizeErrorMessage(error) {
  return String(error?.message || error || '').trim().slice(0, 500);
}

function backgroundTaskError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function resolveDeadlineAtMs(queueName, options, enqueuedAtMs) {
  if (options?.deadlineAt !== null && options?.deadlineAt !== undefined) {
    const raw = options.deadlineAt instanceof Date
      ? options.deadlineAt.getTime()
      : Number(options.deadlineAt) || Date.parse(String(options.deadlineAt));
    if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  }
  const relativeMs = deadlineMsFor(queueName, options?.deadlineMs ?? options?.maxWaitMs);
  return enqueuedAtMs + relativeMs;
}

function createDeferredTaskPromise(name) {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  promise.catch((error) => {
    console.error(`[nb-clan] background task failed: ${name}`, error);
  });
  return { promise, resolve, reject };
}

function rejectedTaskPromise(name, error) {
  const promise = Promise.reject(error);
  promise.catch((caught) => {
    console.error(`[nb-clan] background task rejected: ${name}`, caught);
  });
  return promise;
}

function removeKeyedEntry(state, entry) {
  if (entry.key && state.keyed.get(entry.key) === entry) state.keyed.delete(entry.key);
}

function clearDeadlineTimer(entry) {
  if (!entry.deadlineTimer) return;
  clearTimeout(entry.deadlineTimer);
  entry.deadlineTimer = null;
}

function updateFailureMetrics(metrics, error) {
  metrics.failed += 1;
  metrics.lastFailedAt = nowIso();
  metrics.lastError = normalizeErrorMessage(error);
}

function scheduleQueuePump(state) {
  if (state.pumpScheduled || state.running) return;
  state.pumpScheduled = true;
  queueMicrotask(() => {
    state.pumpScheduled = false;
    pumpQueue(state);
  });
}

function expirePendingEntry(state, entry) {
  if (entry.status !== 'pending') return false;
  const index = state.pending.indexOf(entry);
  if (index < 0) return false;
  state.pending.splice(index, 1);
  entry.status = 'expired';
  clearDeadlineTimer(entry);
  removeKeyedEntry(state, entry);
  const error = backgroundTaskError(
    'BACKGROUND_TASK_DEADLINE_EXCEEDED',
    `background task deadline exceeded before start: ${entry.name}`,
    {
      queue: state.name,
      taskName: entry.name,
      key: entry.key,
      deadlineAt: new Date(entry.deadlineAtMs).toISOString()
    }
  );
  state.metrics.expired += 1;
  state.metrics.lastExpiredAt = nowIso();
  updateFailureMetrics(state.metrics, error);
  entry.reject(error);
  scheduleQueuePump(state);
  return true;
}

function schedulePendingDeadline(state, entry) {
  clearDeadlineTimer(entry);
  const remainingMs = entry.deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    queueMicrotask(() => expirePendingEntry(state, entry));
    return;
  }
  entry.deadlineTimer = setTimeout(() => expirePendingEntry(state, entry), remainingMs);
  entry.deadlineTimer.unref?.();
}

function publicEntryDescriptor(entry) {
  return {
    name: entry.name,
    key: entry.key,
    queue: entry.queueName,
    enqueuedAt: new Date(entry.enqueuedAtMs).toISOString(),
    deadlineAt: new Date(entry.deadlineAtMs).toISOString(),
    timeoutMs: entry.timeoutMs,
    delayMs: entry.delayMs,
    status: entry.status
  };
}

function mergePendingEntry(state, existing, incoming, options) {
  let mergedTask = null;
  if (options?.merge === true || ['replace', 'latest'].includes(options?.merge)) {
    mergedTask = incoming.task;
  } else if (typeof options?.merge === 'function') {
    const result = options.merge(existing.task, incoming.task, {
      existing: publicEntryDescriptor(existing),
      incoming: publicEntryDescriptor(incoming)
    });
    if (typeof result === 'function') mergedTask = result;
    else if (typeof result?.task === 'function') mergedTask = result.task;
  }
  if (!mergedTask) return false;

  existing.name = incoming.name;
  existing.task = mergedTask;
  existing.delayMs = incoming.delayMs;
  existing.timeoutMs = incoming.timeoutMs;
  existing.deadlineAtMs = incoming.deadlineAtMs;
  schedulePendingDeadline(state, existing);
  return true;
}

function timeoutPlanForEntry(entry, startedAtMs) {
  const timeoutAtMs = startedAtMs + entry.timeoutMs;
  if (entry.deadlineAtMs <= timeoutAtMs) {
    return {
      code: 'BACKGROUND_TASK_DEADLINE_EXCEEDED',
      waitMs: Math.max(0, entry.deadlineAtMs - startedAtMs),
      message: `background task deadline exceeded: ${entry.name}`
    };
  }
  return {
    code: 'BACKGROUND_TASK_TIMEOUT',
    waitMs: entry.timeoutMs,
    message: `background task timed out after ${entry.timeoutMs}ms: ${entry.name}`
  };
}

async function runEntry(state, entry) {
  const metrics = state.metrics;
  const startedAtMs = Date.now();
  const controller = new AbortController();
  const timeoutPlan = timeoutPlanForEntry(entry, startedAtMs);
  let timeoutTimer = null;

  entry.status = 'running';
  entry.startedAtMs = startedAtMs;
  state.running = entry;
  metrics.lastStartedAt = new Date(startedAtMs).toISOString();
  metrics.oldestRunningStartedAtMs = startedAtMs;

  const taskPromise = Promise.resolve().then(() => entry.task({
    signal: controller.signal,
    name: entry.name,
    key: entry.key,
    queue: state.name,
    deadlineAt: new Date(entry.deadlineAtMs).toISOString(),
    timeoutMs: entry.timeoutMs
  }));
  taskPromise.catch(() => {});

  const timeoutPromise = new Promise((_, reject) => {
    timeoutTimer = setTimeout(() => {
      const error = backgroundTaskError(timeoutPlan.code, timeoutPlan.message, {
        queue: state.name,
        taskName: entry.name,
        key: entry.key,
        timeoutMs: entry.timeoutMs,
        deadlineAt: new Date(entry.deadlineAtMs).toISOString()
      });
      controller.abort(error);
      reject(error);
    }, timeoutPlan.waitMs);
  });

  try {
    const result = await Promise.race([taskPromise, timeoutPromise]);
    clearTimeout(timeoutTimer);
    timeoutTimer = null;
    if (entry.delayMs > 0) await sleep(entry.delayMs);
    entry.status = 'completed';
    metrics.completed += 1;
    entry.resolve(result);
  } catch (error) {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    timeoutTimer = null;
    entry.status = 'failed';
    if (error?.code === 'BACKGROUND_TASK_TIMEOUT') {
      metrics.timedOut += 1;
      metrics.lastTimedOutAt = nowIso();
    } else if (error?.code === 'BACKGROUND_TASK_DEADLINE_EXCEEDED') {
      metrics.expired += 1;
      metrics.lastExpiredAt = nowIso();
    }
    updateFailureMetrics(metrics, error);
    entry.reject(error);
  } finally {
    state.running = null;
    metrics.oldestRunningStartedAtMs = 0;
    metrics.lastFinishedAt = nowIso();
    removeKeyedEntry(state, entry);
    scheduleQueuePump(state);
  }
}

function pumpQueue(state) {
  if (state.running) return;
  while (state.pending.length) {
    const entry = state.pending.shift();
    if (entry.status !== 'pending') continue;
    if (entry.deadlineAtMs <= Date.now()) {
      state.pending.unshift(entry);
      expirePendingEntry(state, entry);
      return;
    }
    clearDeadlineTimer(entry);
    runEntry(state, entry).catch((error) => {
      console.error(`[nb-clan] background queue runner failed: ${state.name}`, error);
    });
    return;
  }
}

export function queueBackgroundTask(name, task, delayMs = 0, options = {}) {
  if (!acceptingBackgroundTasks) {
    return rejectedTaskPromise(name, backgroundTaskError(
      'BACKGROUND_TASK_SHUTTING_DOWN',
      `background task queue is shutting down: ${name}`,
      { taskName: String(name || 'background-task').slice(0, 500) }
    ));
  }
  if (process.env.NB_DISABLE_BACKGROUND_JOBS === '1' && !options?.force) {
    return Promise.resolve(null);
  }
  if (typeof task !== 'function') {
    return rejectedTaskPromise(name, backgroundTaskError(
      'BACKGROUND_TASK_INVALID',
      `background task must be a function: ${name}`
    ));
  }

  const queueName = queueNameFromOptions(options);
  const state = queueStates[queueName];
  const metrics = state.metrics;
  const key = normalizeKey(options?.key ?? options?.dedupeKey);
  const enqueuedAtMs = Date.now();
  const incoming = {
    name: String(name || 'background-task').slice(0, 500),
    task,
    queueName,
    key,
    delayMs: Math.max(0, Number(delayMs) || 0),
    timeoutMs: timeoutMsFor(queueName, options?.timeoutMs),
    deadlineAtMs: resolveDeadlineAtMs(queueName, options, enqueuedAtMs),
    enqueuedAtMs,
    status: 'pending',
    deadlineTimer: null,
    startedAtMs: 0
  };

  const existing = key ? state.keyed.get(key) : null;
  if (existing) {
    metrics.deduplicated += 1;
    try {
      if (existing.status === 'pending' && mergePendingEntry(state, existing, incoming, options)) {
        metrics.merged += 1;
      }
    } catch (error) {
      metrics.rejected += 1;
      metrics.lastRejectedAt = nowIso();
      metrics.lastError = normalizeErrorMessage(error);
      return rejectedTaskPromise(incoming.name, error);
    }
    return existing.promise;
  }

  const maxPending = maxPendingFor(queueName, options?.maxPending);
  if (state.pending.length >= maxPending) {
    const error = backgroundTaskError(
      'BACKGROUND_TASK_QUEUE_FULL',
      `background task queue is full: ${queueName}`,
      { queue: queueName, taskName: incoming.name, maxPending }
    );
    metrics.rejected += 1;
    metrics.lastRejectedAt = nowIso();
    metrics.lastError = normalizeErrorMessage(error);
    return rejectedTaskPromise(incoming.name, error);
  }

  const deferred = createDeferredTaskPromise(incoming.name);
  const entry = Object.assign(incoming, deferred);
  state.pending.push(entry);
  if (key) state.keyed.set(key, entry);
  metrics.maxObservedPending = Math.max(metrics.maxObservedPending, state.pending.length);
  schedulePendingDeadline(state, entry);
  scheduleQueuePump(state);
  return entry.promise;
}

export function backgroundTaskQueueSnapshot() {
  const queues = Object.fromEntries(Object.entries(queueStates).map(([name, state]) => {
    const metrics = state.metrics;
    const nowMs = Date.now();
    const oldestPendingAtMs = state.pending.reduce((oldest, entry) => (
      !oldest || entry.enqueuedAtMs < oldest ? entry.enqueuedAtMs : oldest
    ), 0);
    const oldestRunningMs = state.running && metrics.oldestRunningStartedAtMs
      ? Math.max(0, nowMs - metrics.oldestRunningStartedAtMs)
      : 0;
    const oldestPendingMs = oldestPendingAtMs ? Math.max(0, nowMs - oldestPendingAtMs) : 0;
    return [name, {
      pending: state.pending.length,
      running: state.running ? 1 : 0,
      completed: metrics.completed,
      failed: metrics.failed,
      rejected: metrics.rejected,
      timedOut: metrics.timedOut,
      expired: metrics.expired,
      deduplicated: metrics.deduplicated,
      merged: metrics.merged,
      maxPending: maxPendingFor(name),
      maxObservedPending: metrics.maxObservedPending,
      keyedPending: state.pending.filter((entry) => Boolean(entry.key)).length,
      keyedRunning: Number(Boolean(state.running?.key)),
      oldestPendingMs,
      oldestPendingSeconds: Math.round(oldestPendingMs / 1000),
      oldestRunningMs,
      oldestRunningSeconds: Math.round(oldestRunningMs / 1000),
      defaultTimeoutMs: timeoutMsFor(name),
      defaultDeadlineMs: deadlineMsFor(name),
      lastStartedAt: metrics.lastStartedAt,
      lastFinishedAt: metrics.lastFinishedAt,
      lastFailedAt: metrics.lastFailedAt,
      lastRejectedAt: metrics.lastRejectedAt,
      lastTimedOutAt: metrics.lastTimedOutAt,
      lastExpiredAt: metrics.lastExpiredAt,
      lastError: metrics.lastError
    }];
  }));
  const totalPending = Object.values(queues).reduce((sum, item) => sum + item.pending, 0);
  const totalRunning = Object.values(queues).reduce((sum, item) => sum + item.running, 0);
  const totalRejected = Object.values(queues).reduce((sum, item) => sum + item.rejected, 0);
  const totalTimedOut = Object.values(queues).reduce((sum, item) => sum + item.timedOut, 0);
  const totalExpired = Object.values(queues).reduce((sum, item) => sum + item.expired, 0);
  return {
    accepting: acceptingBackgroundTasks,
    queues,
    totalPending,
    totalRunning,
    totalRejected,
    totalTimedOut,
    totalExpired
  };
}

export async function drainBackgroundTaskQueues({ timeoutMs = 5000, stopAccepting = false } = {}) {
  const startedAt = Date.now();
  while (true) {
    const snapshot = backgroundTaskQueueSnapshot();
    if (!snapshot.totalPending && !snapshot.totalRunning) {
      if (!stopAccepting) return snapshot;
      acceptingBackgroundTasks = false;
      return backgroundTaskQueueSnapshot();
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error('background task queues did not drain before timeout');
    }
    await sleep(5);
  }
}

export async function drainBackgroundTaskQueuesForTests(options = {}) {
  return drainBackgroundTaskQueues(options);
}

export function resumeBackgroundTaskQueuesForTests() {
  acceptingBackgroundTasks = true;
}
