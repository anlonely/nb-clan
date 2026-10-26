import { createId, normalizeText, nowIso } from './store.js';

export const SYNC_JOB_HISTORY_LIMIT = 100;
export const SYNC_JOB_TYPES = new Set([
  'battlemetrics_identity',
  'battlemetrics_playtime',
  'kda',
  'hexaytron_profile',
  'member_profile',
  'steam_profile_backfill',
  'local_consistency'
]);
export const SYNC_JOB_SOURCES = new Set(['manual', 'auto', 'compensation']);
export const SYNC_JOB_SCOPES = new Set(['global', 'battlemetrics', 'kda', 'hexaytron', 'member_profile']);
export const SYNC_JOB_ACTIVE_STATUSES = new Set(['queued', 'running']);
export const SYNC_JOB_TERMINAL_STATUSES = new Set(['completed', 'partial_failed', 'failed', 'cancelled']);
export const SERIAL_SYNC_JOB_TYPES = new Set(['battlemetrics_identity', 'battlemetrics_playtime', 'kda', 'hexaytron_profile', 'member_profile']);
export const SYNC_JOB_STALE_MS_RAW = Number(process.env.NB_SYNC_JOB_STALE_MS || 45 * 60 * 1000);
export const SYNC_JOB_STALE_MS = Number.isFinite(SYNC_JOB_STALE_MS_RAW)
  ? Math.max(5 * 60 * 1000, SYNC_JOB_STALE_MS_RAW)
  : 45 * 60 * 1000;
export const SYNC_JOB_INTERRUPTED_ERROR = '服务重启，中断同步任务已取消';
export const SYNC_JOB_STALE_ERROR = '同步任务长时间未更新，已自动结束';
export const SYNC_JOB_CANCELLED_ERROR = '同步任务已停止';
export const SYNC_JOB_RUNNER_METADATA_KEY = 'sync_center';
const SYNC_JOB_FAILURE_DETAIL_LIMIT = 80;
const SYNC_JOB_STATUS_TRANSITIONS = new Map([
  ['queued', new Set(['queued', 'running', ...SYNC_JOB_TERMINAL_STATUSES])],
  ['running', new Set(['running', ...SYNC_JOB_TERMINAL_STATUSES])]
]);

function timestampForSort(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}

export function syncStatePercent(completed, requested) {
  const total = Math.max(0, Number(requested || 0));
  if (!total) return 100;
  return Math.max(0, Math.min(100, Math.round((Number(completed || 0) / total) * 100)));
}

export function syncStateEtaSeconds(startedAt, completed, requested, fallbackSeconds) {
  const total = Math.max(0, Number(requested || 0));
  const done = Math.max(0, Number(completed || 0));
  if (!total || done >= total) return 0;
  const startedMs = timestampForSort(startedAt);
  if (startedMs && done > 0) {
    const elapsedSeconds = Math.max(1, (Date.now() - startedMs) / 1000);
    const perItemSeconds = elapsedSeconds / done;
    return Math.max(1, Math.ceil((total - done) * perItemSeconds));
  }
  return Math.max(1, Math.ceil(Number(fallbackSeconds || 0)));
}

export function normalizeSyncJobType(value) {
  const type = normalizeText(value, 80);
  return SYNC_JOB_TYPES.has(type) ? type : 'local_consistency';
}

export function normalizeSyncJobSource(value) {
  const source = normalizeText(value, 40);
  return SYNC_JOB_SOURCES.has(source) ? source : 'manual';
}

export function normalizeSyncJobScope(value) {
  const scope = normalizeText(value, 40);
  return SYNC_JOB_SCOPES.has(scope) ? scope : 'global';
}

export function syncJobTypeForKind(kind) {
  if (kind === 'battlemetrics' || kind === 'battlemetricsQuery' || kind === 'battlemetricsNewMember') return 'battlemetrics_playtime';
  if (kind === 'battlemetricsIdentity') return 'battlemetrics_identity';
  if (kind === 'hexaytronProfiles') return 'hexaytron_profile';
  if (kind === 'memberProfiles') return 'member_profile';
  if (kind === 'kda') return 'kda';
  return 'local_consistency';
}

export function syncJobScopeForType(type) {
  if (type === 'battlemetrics_identity' || type === 'battlemetrics_playtime') return 'battlemetrics';
  if (type === 'kda') return 'kda';
  if (type === 'hexaytron_profile') return 'hexaytron';
  if (type === 'member_profile') return 'member_profile';
  return 'global';
}

export function syncJobStatusFromSyncState(state = {}) {
  const status = normalizeText(state.status, 40);
  const failed = Math.max(0, Number(state.failed || 0));
  const skipped = Math.max(0, Number(state.skipped ?? state.ignored ?? 0));
  if (status === 'running') return 'running';
  if (status === 'queued') return 'queued';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'complete' || status === 'completed') return failed || skipped ? 'partial_failed' : 'completed';
  return status || 'queued';
}

export function mergeSyncStateForJob(previous = {}, patch = {}, updatedAt = nowIso()) {
  const previousState = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {};
  const statePatch = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const previousJobId = normalizeText(previousState.syncJobId, 120);
  const nextJobId = normalizeText(statePatch.syncJobId, 120);
  const status = normalizeText(statePatch.status, 40);
  const startsNewRun = Boolean(
    (nextJobId && nextJobId !== previousJobId) ||
    (
      (status === 'queued' || status === 'running') &&
      Object.hasOwn(statePatch, 'startedAt') &&
      String(statePatch.startedAt || '') !== String(previousState.startedAt || '') &&
      Math.max(0, Number(statePatch.completed ?? statePatch.doneCount ?? 0)) === 0
    )
  );
  const nextState = {
    ...(startsNewRun ? {} : previousState),
    ...statePatch,
    updatedAt
  };
  if (Object.hasOwn(statePatch, 'syncJobId')) nextState.syncJobId = nextJobId;
  if (Object.hasOwn(statePatch, 'syncJobType')) nextState.syncJobType = normalizeText(statePatch.syncJobType, 80);
  if (Object.hasOwn(statePatch, 'syncJobSource')) nextState.syncJobSource = normalizeText(statePatch.syncJobSource, 40);
  if (Object.hasOwn(statePatch, 'syncJobScope')) nextState.syncJobScope = normalizeText(statePatch.syncJobScope, 40);
  return nextState;
}

export function syncJobIsActive(status) {
  return SYNC_JOB_ACTIVE_STATUSES.has(normalizeText(status, 40));
}

function canonicalSyncJobStatus(status) {
  const normalized = normalizeText(status, 40);
  return normalized === 'complete' ? 'completed' : normalized;
}

export function syncJobStatusTransitionAllowed(previousStatus, nextStatus) {
  const previous = canonicalSyncJobStatus(previousStatus);
  const next = canonicalSyncJobStatus(nextStatus || previousStatus);
  if (!previous || !next) return true;
  if (SYNC_JOB_TERMINAL_STATUSES.has(previous)) return false;
  const allowed = SYNC_JOB_STATUS_TRANSITIONS.get(previous);
  return allowed ? allowed.has(next) : true;
}

export function syncJobMetadata(job = {}) {
  return job?.metadata && typeof job.metadata === 'object' && !Array.isArray(job.metadata)
    ? job.metadata
    : {};
}

export function syncJobUsesSerialRunner(job = {}) {
  return SERIAL_SYNC_JOB_TYPES.has(normalizeSyncJobType(job.type)) &&
    syncJobMetadata(job).runner === SYNC_JOB_RUNNER_METADATA_KEY;
}

export function staleSyncJob(job = {}, nowMs = Date.now()) {
  if (!syncJobIsActive(job.status)) return false;
  if (normalizeText(job.status, 40) === 'queued' && syncJobUsesSerialRunner(job)) return false;
  const referenceMs = timestampForSort(job.updatedAt || job.startedAt || job.createdAt);
  return Boolean(referenceMs && nowMs - referenceMs >= SYNC_JOB_STALE_MS);
}

export function syncJobShouldCountAsActive(job = {}, nowMs = Date.now()) {
  return syncJobIsActive(job.status) && !staleSyncJob(job, nowMs);
}

export function finishActiveSyncJob(job, reason, finishedAt = nowIso(), status = 'failed') {
  if (SYNC_JOB_TERMINAL_STATUSES.has(canonicalSyncJobStatus(job?.status))) return job;
  const cancelled = status === 'cancelled';
  const total = Math.max(0, Number(job.totalCount || 0));
  const done = Math.max(0, Number(job.doneCount || 0));
  const failed = Math.max(0, Number(job.failedCount || 0));
  const skipped = Math.max(0, Number(job.skippedCount || 0));
  const remaining = Math.max(0, total - done - failed - skipped);
  job.status = cancelled ? 'cancelled' : 'failed';
  if (cancelled) job.skippedCount = skipped + remaining;
  else job.failedCount = failed + remaining;
  job.percent = 100;
  job.etaSeconds = 0;
  job.finishedAt = job.finishedAt || finishedAt;
  job.updatedAt = finishedAt;
  job.errorSummary = job.errorSummary || reason;
  return job;
}

export function failActiveSyncJob(job, reason, finishedAt = nowIso()) {
  return finishActiveSyncJob(job, reason, finishedAt, 'failed');
}

export function publicSyncJobForRead(job = {}, nowMs = Date.now()) {
  const copy = { ...job };
  if (staleSyncJob(copy, nowMs)) {
    failActiveSyncJob(copy, SYNC_JOB_STALE_ERROR, new Date(nowMs).toISOString());
  }
  return publicSyncJob(copy);
}

export function activeSyncStateIsStale(state = {}, nowMs = Date.now(), force = false) {
  const status = normalizeText(state.status, 40);
  if (status !== 'running' && status !== 'queued') return false;
  if (force) return true;
  const referenceMs = timestampForSort(state.updatedAt || state.startedAt || state.syncedAt);
  return Boolean(referenceMs && nowMs - referenceMs >= SYNC_JOB_STALE_MS);
}

export function syncStateLinkedQueuedSerialJob(state = {}, jobsById = new Map()) {
  const syncJobId = normalizeText(state.syncJobId, 120);
  if (!syncJobId) return false;
  const job = jobsById.get(syncJobId);
  return Boolean(job && normalizeText(job.status, 40) === 'queued' && syncJobUsesSerialRunner(job));
}

export function syncStateShouldCountAsActive(state = {}, nowMs = Date.now()) {
  return syncJobIsActive(state.status) && !activeSyncStateIsStale(state, nowMs);
}

export function finishActiveSyncState(state = {}, reason, finishedAt = nowIso(), status = 'failed') {
  const cancelled = status === 'cancelled';
  const requested = Math.max(0, Number(state.requested || 0));
  const completed = Math.max(0, Number(state.completed || 0));
  const failed = Math.max(0, Number(state.failed || 0));
  const skipped = Math.max(0, Number(state.skipped ?? state.ignored ?? 0));
  const remaining = Math.max(0, requested - completed - failed - skipped);
  state.status = cancelled ? 'cancelled' : 'failed';
  if (cancelled) state.ignored = skipped + remaining;
  else state.failed = failed + remaining;
  state.percent = 100;
  state.etaSeconds = 0;
  state.syncedAt = state.syncedAt || finishedAt;
  state.updatedAt = finishedAt;
  state.error = state.error || reason;
  return state;
}

export function failActiveSyncState(state = {}, reason, finishedAt = nowIso()) {
  return finishActiveSyncState(state, reason, finishedAt, 'failed');
}

export function reconcileActiveSyncWork(store, { force = false, reason = SYNC_JOB_STALE_ERROR, nowMs = Date.now(), status = 'failed' } = {}) {
  const finishedAt = new Date(nowMs).toISOString();
  const normalizedStatus = status === 'cancelled' ? 'cancelled' : 'failed';
  let changed = 0;
  const jobs = ensureSyncJobs(store);
  const jobsById = new Map(jobs.map((job) => [normalizeText(job.id, 120), job]).filter(([id]) => Boolean(id)));
  for (const job of jobs) {
    if (!syncJobIsActive(job.status)) continue;
    if (!force && !staleSyncJob(job, nowMs)) continue;
    finishActiveSyncJob(job, reason, finishedAt, normalizedStatus);
    changed += 1;
  }
  store.syncState ||= {};
  for (const state of Object.values(store.syncState)) {
    if (!state || typeof state !== 'object') continue;
    if (!force && syncStateLinkedQueuedSerialJob(state, jobsById)) continue;
    if (!activeSyncStateIsStale(state, nowMs, force)) continue;
    finishActiveSyncState(state, reason, finishedAt, normalizedStatus);
    changed += 1;
  }
  return changed;
}

export function ensureSyncJobs(store) {
  store.syncJobs ||= [];
  if (store.syncJobs.length > SYNC_JOB_HISTORY_LIMIT) {
    store.syncJobs = store.syncJobs
      .toSorted((left, right) => timestampForSort(right.updatedAt || right.createdAt) - timestampForSort(left.updatedAt || left.createdAt))
      .slice(0, SYNC_JOB_HISTORY_LIMIT);
  }
  return store.syncJobs;
}

export function isEmptyCompletedSyncJob(job = {}) {
  const status = normalizeText(job.status, 40);
  return (
    (status === 'completed' || status === 'complete') &&
    Math.max(0, Number(job.totalCount || job.requested || 0)) === 0 &&
    Math.max(0, Number(job.doneCount || job.completed || 0)) === 0 &&
    Math.max(0, Number(job.failedCount || job.failed || 0)) === 0 &&
    Math.max(0, Number(job.skippedCount ?? job.skipped ?? job.ignored ?? 0)) === 0
  );
}

export function sanitizeSyncJobMetadata(value, depth = 0) {
  if (value === null || value === undefined) return {};
  if (depth > 2) return {};
  if (Array.isArray(value)) {
    return value.slice(0, 300).map((item) => (
      item && typeof item === 'object'
        ? sanitizeSyncJobMetadata(item, depth + 1)
        : normalizeText(item, 240)
    ));
  }
  if (typeof value !== 'object') return normalizeText(value, 500);
  const blocked = /token|secret|password|openid|unionid|authorization|cookie/i;
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 80)) {
    const safeKey = normalizeText(key, 80);
    if (!safeKey || blocked.test(safeKey)) continue;
    result[safeKey] = item && typeof item === 'object'
      ? sanitizeSyncJobMetadata(item, depth + 1)
      : normalizeText(item, 500);
  }
  return result;
}

export function syncJobProgressPatchFromState(kind, patch = {}) {
  const type = normalizeSyncJobType(patch.syncJobType || syncJobTypeForKind(kind));
  const requested = Math.max(0, Number(patch.requested || patch.totalCount || 0));
  const completed = Math.max(0, Number(patch.completed || patch.doneCount || 0));
  const failed = Math.max(0, Number(patch.failed || patch.failedCount || 0));
  const skipped = Math.max(0, Number(patch.skipped ?? patch.ignored ?? patch.skippedCount ?? 0));
  const status = syncJobStatusFromSyncState(patch);
  const updatedAt = nowIso();
  return {
    type,
    scope: normalizeSyncJobScope(patch.syncJobScope || syncJobScopeForType(type)),
    source: normalizeSyncJobSource(patch.syncJobSource || patch.source),
    status,
    totalCount: requested,
    doneCount: completed,
    failedCount: failed,
    skippedCount: skipped,
    percent: Number.isFinite(Number(patch.percent)) ? Number(patch.percent) : syncStatePercent(completed, requested),
    etaSeconds: Number.isFinite(Number(patch.etaSeconds)) ? Number(patch.etaSeconds) : syncStateEtaSeconds(patch.startedAt, completed, requested, patch.estimatedSeconds),
    targetWipeId: normalizeText(patch.wipeId || patch.targetWipeId, 120),
    targetServerId: normalizeText(patch.serverId || patch.battlemetricsServerId || patch.targetServerId, 120),
    targetServerName: normalizeText(patch.serverName || patch.targetServerName, 200),
    startedAt: patch.startedAt || '',
    finishedAt: SYNC_JOB_TERMINAL_STATUSES.has(status) ? (patch.syncedAt || updatedAt) : '',
    errorSummary: normalizeText(patch.error || patch.errorSummary, 240),
    ...(patch.details && typeof patch.details === 'object' ? { details: patch.details } : {}),
    updatedAt
  };
}

export function updateSyncJobInStore(store, syncJobId, patch = {}) {
  if (!syncJobId) return null;
  const jobs = ensureSyncJobs(store);
  const index = jobs.findIndex((job) => job.id === syncJobId);
  if (index < 0) return null;
  const previous = jobs[index];
  const status = patch.status ? normalizeText(patch.status, 40) : previous.status;
  if (!syncJobStatusTransitionAllowed(previous.status, status)) return previous;
  const updatedAt = patch.updatedAt || nowIso();
  const metadata = patch.metadata
    ? sanitizeSyncJobMetadata({ ...(previous.metadata || {}), ...patch.metadata })
    : (previous.metadata || {});
  const next = {
    ...previous,
    ...patch,
    status,
    metadata,
    updatedAt,
    finishedAt: SYNC_JOB_TERMINAL_STATUSES.has(status)
      ? (patch.finishedAt || previous.finishedAt || updatedAt)
      : (patch.finishedAt ?? previous.finishedAt ?? '')
  };
  jobs[index] = next;
  return next;
}

export function findActiveSyncJob(store, input = {}) {
  const type = normalizeSyncJobType(input.type);
  const scope = input.scope ? normalizeSyncJobScope(input.scope) : '';
  const targetWipeId = normalizeText(input.targetWipeId, 120);
  const targetVitalWipeId = normalizeText(input.targetVitalWipeId, 120);
  const targetServerId = normalizeText(input.targetServerId, 120);
  const nowMs = Number.isFinite(Number(input.nowMs)) ? Number(input.nowMs) : Date.now();
  return ensureSyncJobs(store).find((job) => {
    if (!syncJobShouldCountAsActive(job, nowMs)) return false;
    if (type && normalizeSyncJobType(job.type) !== type) return false;
    if (scope && normalizeSyncJobScope(job.scope) !== scope) return false;
    if (targetWipeId && normalizeText(job.targetWipeId, 120) !== targetWipeId) return false;
    if (targetVitalWipeId && normalizeText(job.targetVitalWipeId, 120) !== targetVitalWipeId) return false;
    if (targetServerId && normalizeText(job.targetServerId, 120) !== targetServerId) return false;
    return true;
  }) || null;
}

export function createSyncJobInStore(store, input = {}) {
  const now = nowIso();
  const type = normalizeSyncJobType(input.type);
  const job = {
    id: createId('sync_job'),
    type,
    source: normalizeSyncJobSource(input.source),
    scope: normalizeSyncJobScope(input.scope || syncJobScopeForType(type)),
    status: normalizeText(input.status, 40) || 'queued',
    targetWipeId: normalizeText(input.targetWipeId, 120),
    targetVitalWipeId: normalizeText(input.targetVitalWipeId, 120),
    targetServerId: normalizeText(input.targetServerId, 120),
    targetServerName: normalizeText(input.targetServerName, 200),
    totalCount: Math.max(0, Number(input.totalCount || 0)),
    doneCount: Math.max(0, Number(input.doneCount || 0)),
    failedCount: Math.max(0, Number(input.failedCount || 0)),
    skippedCount: Math.max(0, Number(input.skippedCount || 0)),
    percent: Number.isFinite(Number(input.percent)) ? Number(input.percent) : 0,
    etaSeconds: Math.max(0, Number(input.etaSeconds || 0)),
    startedAt: input.startedAt || '',
    finishedAt: input.finishedAt || '',
    createdBy: normalizeText(input.createdBy, 80),
    errorSummary: normalizeText(input.errorSummary, 240),
    details: input.details && typeof input.details === 'object' ? input.details : {},
    metadata: sanitizeSyncJobMetadata(input.metadata || {}),
    createdAt: now,
    updatedAt: now
  };
  if (!isEmptyCompletedSyncJob(job)) {
    ensureSyncJobs(store).unshift(job);
    ensureSyncJobs(store);
  }
  return job;
}

export function createSyncJobUnlessActiveInStore(store, input = {}, activeInput = {}) {
  const activeJob = findActiveSyncJob(store, activeInput);
  if (activeJob) return { job: activeJob, reused: true };
  return { job: createSyncJobInStore(store, input), reused: false };
}

export function normalizeBattlemetricsReviewCandidates(candidates = []) {
  const seen = new Set();
  return (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => ({
      battlemetricsId: normalizeText(candidate?.battlemetricsId || candidate?.playerId || candidate?.id, 80),
      displayName: normalizeText(candidate?.displayName || candidate?.name, 120),
      alias: normalizeText(candidate?.alias, 120),
      confidence: normalizeText(candidate?.confidence, 80),
      firstSeenAt: normalizeText(candidate?.firstSeenAt, 80),
      lastSeenAt: normalizeText(candidate?.lastSeenAt, 80),
      serverTimePlayedSeconds: Math.max(0, Number(candidate?.serverTimePlayedSeconds || candidate?.timePlayed || 0)),
      online: Boolean(candidate?.online)
    }))
    .filter((candidate) => {
      if (!candidate.battlemetricsId || seen.has(candidate.battlemetricsId)) return false;
      seen.add(candidate.battlemetricsId);
      return true;
    })
    .slice(0, 8);
}

function syncJobFailureDisplayName(member = {}, extra = {}) {
  return member.displayName ||
    member.customName ||
    member.steamNickname ||
    extra.displayName ||
    (member.steamId || extra.steamId ? `Steam ${String(member.steamId || extra.steamId).slice(-6)}` : '');
}

export function syncJobFailureItem(member = {}, message = '', extra = {}) {
  return {
    memberId: normalizeText(member.id || extra.memberId, 80),
    steamId: normalizeText(member.steamId || extra.steamId, 80),
    displayName: normalizeText(syncJobFailureDisplayName(member, extra), 120),
    message: normalizeText(message || extra.message || '同步失败', 240),
    battlemetricsCandidates: normalizeBattlemetricsReviewCandidates(extra.battlemetricsCandidates),
    occurredAt: extra.occurredAt || nowIso()
  };
}

export function syncJobFailureDetails(items = []) {
  const failedItems = (Array.isArray(items) ? items : [])
    .filter(Boolean)
    .map((item) => ({
      memberId: normalizeText(item.memberId, 80),
      steamId: normalizeText(item.steamId, 80),
      displayName: normalizeText(item.displayName, 120),
      message: normalizeText(item.message, 240),
      battlemetricsCandidates: normalizeBattlemetricsReviewCandidates(item.battlemetricsCandidates),
      occurredAt: item.occurredAt || ''
    }))
    .slice(-SYNC_JOB_FAILURE_DETAIL_LIMIT);
  return { failedItems };
}

export function publicSyncJob(job = {}) {
  const totalCount = Math.max(0, Number(job.totalCount || 0));
  const doneCount = Math.max(0, Number(job.doneCount || 0));
  const failedCount = Math.max(0, Number(job.failedCount || 0));
  const skippedCount = Math.max(0, Number(job.skippedCount || 0));
  const percent = Number.isFinite(Number(job.percent))
    ? Math.max(0, Math.min(100, Number(job.percent)))
    : syncStatePercent(doneCount, totalCount);
  return {
    id: job.id || '',
    type: normalizeSyncJobType(job.type),
    source: normalizeSyncJobSource(job.source),
    scope: normalizeSyncJobScope(job.scope),
    status: normalizeText(job.status, 40) || 'queued',
    targetWipeId: job.targetWipeId || '',
    targetVitalWipeId: job.targetVitalWipeId || '',
    targetServerId: job.targetServerId || '',
    targetServerName: job.targetServerName || '',
    totalCount,
    doneCount,
    failedCount,
    skippedCount,
    percent,
    etaSeconds: Math.max(0, Number(job.etaSeconds || 0)),
    startedAt: job.startedAt || '',
    finishedAt: job.finishedAt || '',
    createdBy: job.createdBy || '',
    errorSummary: job.errorSummary || '',
    details: job.details || {},
    createdAt: job.createdAt || '',
    updatedAt: job.updatedAt || ''
  };
}

function syncJobDuplicateGroupKey(job = {}) {
  return [
    normalizeSyncJobType(job.type),
    normalizeSyncJobScope(job.scope),
    normalizeText(job.targetWipeId, 120) || '-',
    normalizeText(job.targetVitalWipeId, 120) || '-',
    normalizeText(job.targetServerId, 120) || '-'
  ].join('|');
}

export function syncJobsActiveDuplicateSummary(store) {
  const nowMs = Date.now();
  const groups = new Map();
  for (const job of ensureSyncJobs(store)) {
    if (!syncJobShouldCountAsActive(job, nowMs)) continue;
    const key = syncJobDuplicateGroupKey(job);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        type: normalizeSyncJobType(job.type),
        scope: normalizeSyncJobScope(job.scope),
        targetWipeId: normalizeText(job.targetWipeId, 120),
        targetServerId: normalizeText(job.targetServerId, 120),
        count: 0,
        jobIds: []
      });
    }
    const group = groups.get(key);
    group.count += 1;
    group.jobIds.push(job.id || '');
  }
  const duplicates = [...groups.values()]
    .filter((group) => group.count > 1)
    .map((group) => ({
      ...group,
      duplicateCount: Math.max(0, group.count - 1),
      jobIds: group.jobIds.filter(Boolean).slice(0, 20)
    }));
  return {
    groups: duplicates,
    groupCount: duplicates.length,
    duplicateJobCount: duplicates.reduce((total, group) => total + group.duplicateCount, 0)
  };
}

function syncJobPendingItems(job = {}) {
  const total = Math.max(0, Number(job.totalCount || 0));
  const done = Math.max(0, Number(job.doneCount || 0));
  const failed = Math.max(0, Number(job.failedCount || 0));
  const skipped = Math.max(0, Number(job.skippedCount || 0));
  return Math.max(0, total - done - failed - skipped);
}

function createSyncJobSummary() {
  return {
    total: 0,
    current: 0,
    queued: 0,
    running: 0,
    completed: 0,
    partialFailed: 0,
    failed: 0,
    cancelled: 0,
    terminal: 0,
    pendingItems: 0,
    latestAt: ''
  };
}

function addSyncJobToSummary(summary, job = {}) {
  const status = normalizeText(job.status, 40) || 'queued';
  summary.total += 1;
  if (syncJobIsActive(status)) {
    summary.current += 1;
    summary.pendingItems += syncJobPendingItems(job);
  }
  if (status === 'queued') summary.queued += 1;
  else if (status === 'running') summary.running += 1;
  else if (status === 'completed') summary.completed += 1;
  else if (status === 'partial_failed') summary.partialFailed += 1;
  else if (status === 'failed') summary.failed += 1;
  else if (status === 'cancelled') summary.cancelled += 1;
  if (SYNC_JOB_TERMINAL_STATUSES.has(status)) summary.terminal += 1;
  const latestAt = job.updatedAt || job.finishedAt || job.startedAt || job.createdAt || '';
  if (timestampForSort(latestAt) > timestampForSort(summary.latestAt)) summary.latestAt = latestAt;
  return summary;
}

function finalizeSyncJobSummary(summary) {
  const problem = summary.failed + summary.partialFailed;
  return {
    ...summary,
    problem,
    failureRate: summary.total ? Number((summary.failed / summary.total).toFixed(4)) : 0,
    problemRate: summary.total ? Number((problem / summary.total).toFixed(4)) : 0,
    terminalFailureRate: summary.terminal ? Number((summary.failed / summary.terminal).toFixed(4)) : 0,
    terminalProblemRate: summary.terminal ? Number((problem / summary.terminal).toFixed(4)) : 0
  };
}

function syncJobSummaryBy(jobs = [], keyFn) {
  const summary = {};
  for (const job of jobs) {
    const key = keyFn(job);
    if (!key) continue;
    summary[key] ||= createSyncJobSummary();
    addSyncJobToSummary(summary[key], job);
  }
  for (const [key, item] of Object.entries(summary)) {
    summary[key] = finalizeSyncJobSummary(item);
  }
  return summary;
}

function syncJobFailureRates(jobs = []) {
  const totals = createSyncJobSummary();
  for (const job of jobs) addSyncJobToSummary(totals, job);
  return finalizeSyncJobSummary(totals);
}

export function syncJobsPayload(store, { limit = 20 } = {}) {
  const nowMs = Date.now();
  const jobs = ensureSyncJobs(store)
    .slice()
    .map((job) => publicSyncJobForRead(job, nowMs))
    .filter((job) => !isEmptyCompletedSyncJob(job))
    .toSorted((left, right) => timestampForSort(right.updatedAt || right.createdAt) - timestampForSort(left.updatedAt || left.createdAt));
  const current = jobs.filter((job) => syncJobIsActive(job.status));
  const recent = jobs.slice(0, Math.max(1, Math.min(100, Number(limit) || 20)));
  const queueDepth = finalizeSyncJobSummary(current.reduce((summary, job) => addSyncJobToSummary(summary, job), createSyncJobSummary()));
  const partial = Boolean(store.syncJobsPartial);
  const readError = normalizeText(store.syncJobsReadError, 500);
  return {
    current,
    recent,
    byType: syncJobSummaryBy(jobs, (job) => normalizeSyncJobType(job.type)),
    byScope: syncJobSummaryBy(jobs, (job) => normalizeSyncJobScope(job.scope)),
    byStatus: syncJobSummaryBy(jobs, (job) => normalizeText(job.status, 40) || 'queued'),
    failureRates: syncJobFailureRates(jobs),
    queueDepth,
    partial,
    readError,
    updatedAt: nowIso()
  };
}
