import crypto from 'node:crypto';
import nodeFetch from 'node-fetch';
import { normalizeText, nowIso } from './store.js';
import { getSqliteCollection, getSqliteRecord, getSqliteRecordsByJsonField, writeSqliteStorePatch } from './storage/repository.js';
import { sqlitePrimaryMode } from './storage/sqlite.js';

const MESSAGE_DELETION_TASK_ACTIVE_STATUSES = ['pending'];
const MESSAGE_DELETION_TASK_RUNTIME_STATUSES = ['pending', 'running', 'deleted', 'not_found', 'failed'];

function defaultRetryAfterMs(response, attempt = 1) {
  if (response?.status === 429) {
    const retryAfter = Number(response.headers?.get?.('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.max(1000, retryAfter * 1000);
  }
  return Math.min(5000, 1000 * attempt);
}

export function messageDeletionTaskId({ platform = 'discord', messageType = 'interaction', applicationId = '', token = '', channelId = '', messageId = '' } = {}) {
  const hash = crypto.createHash('sha1')
    .update([platform, messageType, applicationId, token, channelId, messageId].join(':'))
    .digest('hex')
    .slice(0, 18);
  return `message_deletion_${platform}_${hash}`;
}

export function messageDeletionTaskTerminal(status = '') {
  return ['deleted', 'not_found', 'failed'].includes(status);
}

export function messageDeletionRetryDelayMs(response, attempt = 1) {
  if (response?.status === 429) {
    const retryAfter = Number(response.headers?.get?.('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.max(1000, retryAfter * 1000);
  }
  return Math.min(60_000, Math.max(1000, 1000 * 2 ** Math.max(0, attempt - 1)));
}

export function createMessageDeletionTaskRuntime({
  discordApiBaseUrl,
  discordIdMaxLength = 32,
  defaultDeleteDelayMs = 30_000,
  interactionDeleteMaxAttempts = 3,
  taskMaxAttempts = 6,
  scanLimit = 100,
  retryAfterMs = defaultRetryAfterMs,
  fetchImpl = nodeFetch,
  sqlitePrimaryModeImpl = sqlitePrimaryMode,
  getRecord = getSqliteRecord,
  getCollection = getSqliteCollection,
  getRecordsByJsonField = getSqliteRecordsByJsonField,
  writePatch = writeSqliteStorePatch,
  now = nowIso,
  recordPersistenceFailure = async () => null
} = {}) {
  const scheduledMessageDeletionTimers = new Map();
  const apiBaseUrl = normalizeText(discordApiBaseUrl, 300) || 'https://discord.com/api/v10';
  const idMaxLength = Math.max(1, Number(discordIdMaxLength || 32));
  const fallbackDeleteDelayMs = Math.max(1, Number(defaultDeleteDelayMs || 30_000));
  const deleteMaxAttempts = Math.max(1, Number(interactionDeleteMaxAttempts || 3));
  const persistedMaxAttempts = Math.max(1, Number(taskMaxAttempts || 6));
  const dueScanLimit = Math.max(1, Number(scanLimit || 100));

  function sqlitePrimary() {
    try {
      return Boolean(sqlitePrimaryModeImpl());
    } catch {
      return false;
    }
  }

  function messageDeletionTaskTrackingPayload(task = {}) {
    return {
      id: normalizeText(task.id, 160),
      platform: normalizeText(task.platform, 40),
      messageType: normalizeText(task.messageType, 80),
      applicationId: normalizeText(task.applicationId, idMaxLength),
      channelId: normalizeText(task.channelId, idMaxLength),
      messageId: normalizeText(task.messageId, 120),
      deleteAt: normalizeText(task.deleteAt, 80),
      attempts: Number(task.attempts || 0),
      status: normalizeText(task.status, 40)
    };
  }

  async function recordMessageDeletionTaskPersistenceFailure(task = {}, error, options = {}) {
    const errorMessage = normalizeText(error?.message || error || 'Message deletion task persistence failed', 500);
    try {
      return await recordPersistenceFailure({
        task: messageDeletionTaskTrackingPayload(task),
        stage: normalizeText(options.stage, 80),
        fallbackDeleteScheduled: Boolean(options.fallbackDeleteScheduled),
        error: {
          message: errorMessage,
          code: normalizeText(error?.code, 80),
          reason: normalizeText(error?.reason, 120)
        }
      });
    } catch (reportError) {
      console.warn('[nb-clan] failed to record message deletion persistence failure:', reportError?.message || reportError);
      return null;
    }
  }

  async function persistMessageDeletionTask(task) {
    if (!sqlitePrimary()) return null;
    const timestamp = now();
    const current = await getRecord('messageDeletionTasks', task.id);
    const nextTask = {
      ...(current || {}),
      ...task,
      status: messageDeletionTaskTerminal(current?.status) ? current.status : (task.status || current?.status || 'pending'),
      attempts: Number(current?.attempts || task.attempts || 0),
      createdAt: current?.createdAt || task.createdAt || timestamp,
      updatedAt: timestamp
    };
    await writePatch({
      reason: 'message_deletion_task_upsert',
      upserts: { messageDeletionTasks: [nextTask] }
    });
    return nextTask;
  }

  function scheduleMessageDeletionTask(task = {}) {
    if (!task?.id || messageDeletionTaskTerminal(task.status)) return;
    if (scheduledMessageDeletionTimers.has(task.id)) return;
    const delayMs = Math.max(0, Date.parse(task.deleteAt || '') - Date.now());
    const timer = setTimeout(() => {
      scheduledMessageDeletionTimers.delete(task.id);
      runMessageDeletionTask(task.id).catch((error) => {
        console.warn('[nb-clan] message deletion task failed:', error?.message || error);
      });
    }, delayMs);
    timer.unref?.();
    scheduledMessageDeletionTimers.set(task.id, timer);
  }

  async function deleteDiscordOriginalInteractionOnce(applicationId, token) {
    return fetchImpl(`${apiBaseUrl}/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(token)}/messages/@original`, {
      method: 'DELETE'
    }).catch((error) => ({ ok: false, status: 0, error }));
  }

  async function deleteDiscordOriginalInteraction(applicationId, token, attempt = 1) {
    const response = await deleteDiscordOriginalInteractionOnce(applicationId, token);
    if (response.ok || response.status === 404) return;
    if (attempt < deleteMaxAttempts) {
      const retryAfter = response.status === 429
        ? Math.max(1000, retryAfterMs(response, attempt))
        : Math.min(5000, 1000 * attempt);
      const retryTimer = setTimeout(() => {
        deleteDiscordOriginalInteraction(applicationId, token, attempt + 1).catch(() => {});
      }, retryAfter);
      retryTimer.unref?.();
      return;
    }
    const detail = response.error?.message || `HTTP ${response.status || 0}`;
    console.warn('[nb-clan] Discord interaction auto-delete failed:', detail);
  }

  async function queueDiscordOriginalInteractionDelete(payload, delayMs = fallbackDeleteDelayMs, messageType = 'discord_original_interaction') {
    const applicationId = normalizeText(payload?.application_id, idMaxLength);
    const token = normalizeText(payload?.token, 240);
    if (!applicationId || !token) return;
    const safeDelayMs = Math.max(1, Number(delayMs || fallbackDeleteDelayMs));
    const task = {
      id: messageDeletionTaskId({ platform: 'discord', messageType, applicationId, token }),
      platform: 'discord',
      messageType,
      applicationId,
      interactionToken: token,
      channelId: normalizeText(payload?.channel_id, idMaxLength),
      messageId: '',
      deleteAt: new Date(Date.now() + safeDelayMs).toISOString(),
      attempts: 0,
      status: 'pending',
      lastError: ''
    };
    if (sqlitePrimary()) {
      persistMessageDeletionTask(task)
        .then((storedTask) => scheduleMessageDeletionTask(storedTask || task))
        .catch((error) => {
          console.warn('[nb-clan] failed to persist Discord interaction delete task:', error?.message || error);
          const timer = setTimeout(() => deleteDiscordOriginalInteraction(applicationId, token).catch(() => {}), safeDelayMs);
          timer.unref?.();
          recordMessageDeletionTaskPersistenceFailure(task, error, {
            stage: 'upsert',
            fallbackDeleteScheduled: true
          }).catch(() => {});
        });
      return;
    }
    const timer = setTimeout(() => deleteDiscordOriginalInteraction(applicationId, token).catch(() => {}), safeDelayMs);
    timer.unref?.();
  }

  async function updateMessageDeletionTask(task, patch = {}) {
    if (!sqlitePrimary() || !task?.id) return null;
    const nextTask = {
      ...task,
      ...patch,
      updatedAt: now()
    };
    await writePatch({
      reason: 'message_deletion_task_update',
      upserts: { messageDeletionTasks: [nextTask] }
    });
    return nextTask;
  }

  async function executeMessageDeletionTask(task = {}) {
    if (!task?.id || messageDeletionTaskTerminal(task.status)) return task;
    if (task.platform !== 'discord') {
      return updateMessageDeletionTask(task, {
        status: 'failed',
        lastError: `Unsupported platform: ${task.platform || ''}`
      });
    }
    const applicationId = normalizeText(task.applicationId, idMaxLength);
    const token = normalizeText(task.interactionToken, 240);
    if (!applicationId || !token) {
      return updateMessageDeletionTask(task, {
        status: 'failed',
        lastError: 'Missing Discord application id or interaction token'
      });
    }
    const attempt = Number(task.attempts || 0) + 1;
    const runningTask = await updateMessageDeletionTask(task, { status: 'running', attempts: attempt });
    const response = await deleteDiscordOriginalInteractionOnce(applicationId, token);
    if (response.ok) {
      return updateMessageDeletionTask(runningTask, { status: 'deleted', lastError: '' });
    }
    if (response.status === 404) {
      return updateMessageDeletionTask(runningTask, { status: 'not_found', lastError: '' });
    }
    const detail = response.error?.message || `HTTP ${response.status || 0}`;
    if (attempt >= persistedMaxAttempts) {
      console.warn('[nb-clan] Discord interaction auto-delete failed:', detail);
      return updateMessageDeletionTask(runningTask, { status: 'failed', lastError: detail });
    }
    const retryTask = await updateMessageDeletionTask(runningTask, {
      status: 'pending',
      deleteAt: new Date(Date.now() + messageDeletionRetryDelayMs(response, attempt)).toISOString(),
      lastError: detail
    });
    scheduleMessageDeletionTask(retryTask);
    return retryTask;
  }

  async function runMessageDeletionTask(taskId) {
    if (!sqlitePrimary()) return null;
    const task = await getRecord('messageDeletionTasks', taskId).catch(() => null);
    if (!task || messageDeletionTaskTerminal(task.status)) return task;
    return executeMessageDeletionTask(task);
  }

  async function listMessageDeletionTasksByStatus(statuses, fallbackMessage) {
    if (typeof getRecordsByJsonField === 'function') {
      return getRecordsByJsonField('messageDeletionTasks', 'status', statuses, { limit: 0 }).catch((error) => {
        console.warn(fallbackMessage, error?.message || error);
        return { partial: true, readError: normalizeText(error?.message || error, 500), tasks: null };
      });
    }
    return null;
  }

  async function runDueMessageDeletionTasks() {
    if (!sqlitePrimary()) return { enabled: false, scanned: 0, due: 0 };
    const statusRead = await listMessageDeletionTasksByStatus(
      MESSAGE_DELETION_TASK_ACTIVE_STATUSES,
      '[nb-clan] message deletion task status scan failed:'
    );
    let partial = Boolean(statusRead?.partial);
    let readError = normalizeText(statusRead?.readError, 500);
    const tasks = (Array.isArray(statusRead) ? statusRead : statusRead?.tasks) || await getCollection('messageDeletionTasks', { limit: 0 }).catch((error) => {
      console.warn('[nb-clan] message deletion task scan failed:', error?.message || error);
      partial = true;
      readError = normalizeText(error?.message || error, 500);
      return [];
    });
    const nowMs = Date.now();
    const dueTasks = tasks
      .filter((task) => !messageDeletionTaskTerminal(task.status))
      .filter((task) => task.status !== 'running')
      .filter((task) => Date.parse(task.deleteAt || '') <= nowMs)
      .slice(0, dueScanLimit);
    for (const task of dueTasks) {
      await executeMessageDeletionTask(task);
    }
    return { enabled: true, scanned: tasks.length, due: dueTasks.length, partial, readError };
  }

  async function messageDeletionTaskRuntimeStatus() {
    if (!sqlitePrimary()) return { enabled: false };
    const statusRead = await listMessageDeletionTasksByStatus(
      MESSAGE_DELETION_TASK_RUNTIME_STATUSES,
      '[nb-clan] message deletion task status summary failed:'
    );
    let partial = Boolean(statusRead?.partial);
    let readError = normalizeText(statusRead?.readError, 500);
    const tasks = (Array.isArray(statusRead) ? statusRead : statusRead?.tasks) || await getCollection('messageDeletionTasks', { limit: 0 }).catch((error) => {
      partial = true;
      readError = normalizeText(error?.message || error, 500);
      return [];
    });
    const counts = {};
    for (const task of tasks) {
      const status = task.status || 'pending';
      counts[status] = (counts[status] || 0) + 1;
    }
    const nowMs = Date.now();
    return {
      enabled: true,
      total: tasks.length,
      pending: counts.pending || 0,
      running: counts.running || 0,
      failed: counts.failed || 0,
      due: tasks.filter((task) => !messageDeletionTaskTerminal(task.status) && Date.parse(task.deleteAt || '') <= nowMs).length,
      counts,
      partial,
      readError
    };
  }

  function clearScheduledMessageDeletionTasksForTests() {
    for (const timer of scheduledMessageDeletionTimers.values()) {
      clearTimeout(timer);
    }
    scheduledMessageDeletionTimers.clear();
  }

  return {
    clearScheduledMessageDeletionTasksForTests,
    executeMessageDeletionTask,
    messageDeletionTaskRuntimeStatus,
    queueDiscordOriginalInteractionDelete,
    runDueMessageDeletionTasks,
    runMessageDeletionTask
  };
}
