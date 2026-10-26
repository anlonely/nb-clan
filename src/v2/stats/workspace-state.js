import { ApiError } from '../query-client.js';

// The metrics displayed by the stats workspace. Provider metadata and unknown
// values do not establish that a row has observable workspace statistics.
const METRIC_KEYS = Object.freeze([
  'kills', 'deaths', 'assists', 'kd', 'kda', 't3Kills', 'rockets',
  'sulfur', 'metalOre', 'building', 'onlineSeconds', 'playTimeSeconds'
]);

export function observedMetric(row, key) {
  if (!METRIC_KEYS.includes(key) || row?.capabilities?.[key] === false) return null;
  const value = row?.values?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Summary of the supplied page, never the complete authorized result set.
 * Freshness is a server fact; it is independent from whether metrics were
 * observed. A recently captured row can still contain only missing values.
 */
export function statsPageSummary(items = []) {
  const rows = Array.isArray(items) ? items : [];
  const result = { members: rows.length, fresh: 0, stale: 0, unobserved: 0, lastCaptured: null };
  let latest = null;
  for (const row of rows) {
    if (row?.status === 'fresh') result.fresh++;
    if (row?.status === 'stale') result.stale++;
    if (!METRIC_KEYS.some(key => observedMetric(row, key) !== null)) result.unobserved++;
    const captured = typeof row?.capturedAt === 'string' && row.capturedAt.trim() ? Date.parse(row.capturedAt) : NaN;
    if (Number.isFinite(captured) && (latest === null || captured > latest)) latest = captured;
  }
  if (latest !== null) result.lastCaptured = new Date(latest).toISOString();
  return result;
}

export const statsSyncIsActive = job => ['queued', 'running', 'retry_wait', 'paused'].includes(job?.status);

export function statsSyncPollDelay(job, now = Date.now()) {
  if (job?.status === 'queued' || job?.status === 'running') return 3000;
  if (job?.status !== 'retry_wait') return null;
  const retryAt = typeof job.retryAt === 'number' ? job.retryAt : Date.parse(job.retryAt);
  return Math.max(15000, Number.isFinite(retryAt) ? retryAt - now : 0);
}

// Re-reading the same task through SSE must not refresh its rows again. Worker
// heartbeat revisions and diagnostic timestamps do not indicate new statistics.
export function statsSyncProgressKey(job) {
  if (!job?.id) return '';
  return JSON.stringify([job.id, job.status, ...['total', 'succeeded', 'partial', 'failed', 'skipped', 'pendingOrRunning']
    .map(key => job.counts?.[key] ?? 0)]);
}

// Only an explicit collection action calls this helper. Concurrent clicks share
// one request; an uncertain failure keeps its key for an identical manual retry.
const syncSessions = new WeakMap();
export function requestStatsSync(client, { wipeId, expectedRevision }, { uuid = () => crypto.randomUUID() } = {}) {
  const generation = client.getGeneration();
  let session = syncSessions.get(client);
  if (session?.generation !== generation) {
    session = { generation, wipes: new Map() };
    syncSessions.set(client, session);
  }
  const previous = session.wipes.get(wipeId);
  if (previous?.pending) return previous.promise;
  const signature = JSON.stringify({ wipeId, expectedRevision });
  const entry = { pending: true, signature, operationId: previous?.error && previous.signature === signature ? previous.operationId : uuid() };
  session.wipes.set(wipeId, entry);
  entry.promise = Promise.resolve().then(() => {
    if (generation !== client.getGeneration()) throw new ApiError('REQUEST_SUPERSEDED');
    return client.request('/api/v2/stats/sync', {
      method: 'POST', body: { wipeId, sourceId: 'vital', expectedRevision },
      headers: { 'Idempotency-Key': entry.operationId }
    });
  }).then(({ data }) => {
    if (generation !== client.getGeneration()) throw new ApiError('REQUEST_SUPERSEDED');
    const job = data?.job;
    if (!job?.id) throw new ApiError('INVALID_RESPONSE');
    return job;
  }).catch(error => { entry.error = error; throw error; })
    .finally(() => { entry.pending = false; });
  return entry.promise;
}
