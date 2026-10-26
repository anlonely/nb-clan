import test from 'node:test';
import assert from 'node:assert/strict';
import { observedMetric, statsPageSummary, requestStatsSync, statsSyncIsActive, statsSyncPollDelay, statsSyncProgressKey } from '../src/v2/stats/workspace-state.js';

test('workspace observations preserve real zero and reject missing, unsupported and invalid values', () => {
  assert.equal(observedMetric({ values: { kills: 0 } }, 'kills'), 0);
  assert.equal(observedMetric({ values: { kd: 0.33 } }, 'kd'), 0.33);
  assert.equal(observedMetric({ values: { kills: 10 }, capabilities: { kills: false } }, 'kills'), null);
  for (const value of [null, undefined, NaN, Infinity, -Infinity, -1, '10', '', true, false]) {
    assert.equal(observedMetric({ values: { kills: value } }, 'kills'), null);
  }
  assert.equal(observedMetric(null, 'kills'), null);
  assert.equal(observedMetric({ values: { providerRevision: 100 } }, 'providerRevision'), null);
});

test('page summary counts only workspace metrics and keeps server freshness independent from observation', () => {
  const items = [
    { status: 'fresh', values: { kills: 0 }, capturedAt: '2026-10-06T00:00:00Z' },
    { status: 'stale', values: { kills: 10, deaths: 2 }, capturedAt: '2026-10-05T23:00:00Z' },
    { status: 'fresh', values: { providerRevision: 100, steamTotalSeconds: 1000 }, capturedAt: 'invalid-date' },
    { status: 'unavailable', values: { kills: 100 }, capabilities: { kills: false }, capturedAt: null },
    { status: 'unsupported', values: { kills: NaN, kd: Infinity }, capturedAt: '' },
    { status: 'partial', values: { t3Kills: 2 }, capturedAt: '2026-10-06T10:00:00+08:00' }
  ];
  assert.deepEqual(statsPageSummary(items), {
    members: 6, fresh: 2, stale: 1, unobserved: 3, lastCaptured: '2026-10-06T02:00:00.000Z'
  });
});

test('page summary preserves supplied order, tied ranks and values without filling gaps or mutating rows', () => {
  const items = Object.freeze([
    Object.freeze({ id: 'first', rank: 1, status: 'stale', values: Object.freeze({ kills: 10 }) }),
    Object.freeze({ id: 'second', rank: 1, status: 'fresh', values: Object.freeze({ kills: 10 }) }),
    Object.freeze({ id: 'zero', rank: 3, status: 'fresh', values: Object.freeze({ kills: 0 }) }),
    Object.freeze({ id: 'missing', rank: null, status: 'unavailable', values: Object.freeze({ kills: null }) })
  ]);
  const before = structuredClone(items);
  assert.deepEqual(statsPageSummary(items), { members: 4, fresh: 2, stale: 1, unobserved: 1, lastCaptured: null });
  assert.deepEqual(items, before);
  assert.deepEqual(items.map(row => row.rank), [1, 1, 3, null]);
});

test('last capture compares valid timestamps across offsets and ignores invalid or absent dates', () => {
  const rows = [
    { capturedAt: '2026-10-06T04:00:00-04:00' },
    { capturedAt: '2026-10-06T17:00:00+08:00' },
    { capturedAt: '2026-10-06T08:30:00Z' },
    { capturedAt: 'invalid-date' }, { capturedAt: ' ' }, { capturedAt: null }, { capturedAt: 0 }, {}
  ];
  assert.equal(statsPageSummary(rows).lastCaptured, '2026-10-06T09:00:00.000Z');
  assert.equal(statsPageSummary([{ capturedAt: '1970-01-01T00:00:00Z' }]).lastCaptured, '1970-01-01T00:00:00.000Z');
  assert.equal(statsPageSummary([{ capturedAt: 'bad' }]).lastCaptured, null);
});

test('empty page summaries do not manufacture observed metric totals or a capture timestamp', () => {
  const empty = { members: 0, fresh: 0, stale: 0, unobserved: 0, lastCaptured: null };
  assert.deepEqual(statsPageSummary([]), empty);
  assert.deepEqual(statsPageSummary(), empty);
  assert.deepEqual(statsPageSummary(null), empty);
  const summary = statsPageSummary([{ values: { kills: null }, status: 'unavailable' }]);
  assert.deepEqual(summary, { members: 1, fresh: 0, stale: 0, unobserved: 1, lastCaptured: null });
});

test('manual task polling stops while paused or completed and respects the provider retry time', () => {
  const now = Date.parse('2026-10-26T03:00:00.000Z');
  for (const status of ['queued', 'running']) assert.equal(statsSyncPollDelay({ status }, now), 3000);
  for (const status of ['paused', 'succeeded', 'partial', 'partial_failed', 'failed', 'cancelled', 'expired', 'no_work']) {
    assert.equal(statsSyncPollDelay({ status }, now), null);
  }
  assert.equal(statsSyncPollDelay(null, now), null);
  assert.equal(statsSyncPollDelay({ status: 'retry_wait', retryAt: '2026-10-26T03:30:00.000Z' }, now), 30 * 60000);
  assert.equal(statsSyncPollDelay({ status: 'retry_wait', retryAt: now + 60000 }, now), 60000);
  for (const retryAt of [null, 'invalid', '2026-10-26T02:00:00.000Z']) {
    assert.equal(statsSyncPollDelay({ status: 'retry_wait', retryAt }, now), 15000);
  }
});

test('unchanged SSE task responses and heartbeat revisions do not count as stats progress', () => {
  const job = { id: 'job-1', status: 'running', revision: 1,
    counts: { total: 24, succeeded: 7, partial: 0, failed: 0, skipped: 0, pendingOrRunning: 17 } };
  const before = statsSyncProgressKey(job);
  assert.equal(statsSyncProgressKey(structuredClone(job)), before);
  assert.equal(statsSyncProgressKey({ ...job, revision: 2, updatedAt: '2026-10-26T03:00:00.000Z' }), before);
  assert.notEqual(statsSyncProgressKey({ ...job, counts: { ...job.counts, succeeded: 8, pendingOrRunning: 16 } }), before);
  assert.notEqual(statsSyncProgressKey({ ...job, status: 'paused' }), before);
  assert.notEqual(statsSyncProgressKey({ ...job, id: 'job-2' }), before);
  const done = { ...job, status: 'succeeded', counts: { ...job.counts, succeeded: 24, pendingOrRunning: 0 } };
  assert.equal(statsSyncProgressKey(structuredClone(done)), statsSyncProgressKey(done));
  assert.equal(statsSyncProgressKey(null), '');
});

test('explicit collection shares pending clicks while later explicit commands and account changes start new work', async () => {
  let generation = 1, serial = 0;
  const requests = [];
  const client = { getGeneration: () => generation, request: async (path, options) => {
    requests.push({ path, ...options });
    return { data: { job: { id: `job-${requests.length}`, status: 'queued' } } };
  } };
  const context = { wipeId: 'active-wipe', expectedRevision: 3, q: 'one-member', squadId: 'one-squad' };
  const options = { uuid: () => `op-${++serial}` };
  const first = requestStatsSync(client, context, options);
  assert.equal(requestStatsSync(client, context, options), first);
  assert.equal(requestStatsSync(client, context), first, 'manual clicks cannot duplicate a pending command');
  assert.equal((await first).id, 'job-1', 'read the nested production job response');
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body, { wipeId: 'active-wipe', sourceId: 'vital', expectedRevision: 3 }, 'view filters never narrow collection');
  assert.equal(requests[0].headers['Idempotency-Key'], 'op-1');
  await requestStatsSync(client, context, options);
  assert.equal(requests.length, 2, 'a later explicit collection can run again');
  assert.equal(requests[1].headers['Idempotency-Key'], 'op-2');
  generation++;
  await requestStatsSync(client, context, options);
  assert.equal(requests.length, 3, 'a new authorization generation owns a separate request');
  await requestStatsSync(client, { ...context, wipeId: 'another-wipe' }, options);
  assert.equal(requests.length, 4);
});

test('a failed collection preserves its idempotency key only for an identical explicit retry', async () => {
  const requests = [];
  let serial = 0;
  const client = { getGeneration: () => 1, request: async (_path, options) => {
    requests.push(options);
    throw Object.assign(new Error('unavailable'), { errorCode: 'SOURCE_UNAVAILABLE' });
  } };
  const context = { wipeId: 'active-wipe', expectedRevision: 3 };
  const options = { uuid: () => `op-${++serial}` };
  await assert.rejects(requestStatsSync(client, context, options));
  assert.equal(requests.length, 1);
  await assert.rejects(requestStatsSync(client, context, { uuid: options.uuid }));
  assert.equal(requests[1].headers['Idempotency-Key'], 'op-1');
  await assert.rejects(requestStatsSync(client, { ...context, expectedRevision: 4 }, { uuid: options.uuid }));
  assert.equal(requests[2].headers['Idempotency-Key'], 'op-2');
});

test('collection ignores results from an old authorization generation and rejects missing production job ids', async () => {
  let generation = 1, resolve;
  const client = { getGeneration: () => generation, request: () => new Promise(done => { resolve = done; }) };
  const promise = requestStatsSync(client, { wipeId: 'active', expectedRevision: 1 });
  await Promise.resolve();
  generation++;
  resolve({ data: { job: { id: 'old-job' } } });
  await assert.rejects(promise, { errorCode: 'REQUEST_SUPERSEDED' });
  let requests = 0;
  const changing = { getGeneration: () => generation, request: async () => { requests++; return { data: { job: { id: 'wrong-account' } } }; } };
  const queued = requestStatsSync(changing, { wipeId: 'active', expectedRevision: 1 });
  generation++;
  await assert.rejects(queued, { errorCode: 'REQUEST_SUPERSEDED' });
  assert.equal(requests, 0, 'an account switch before transport must prevent the old command from being sent');
  const malformed = { getGeneration: () => 1, request: async () => ({ data: {} }) };
  await assert.rejects(requestStatsSync(malformed, { wipeId: 'active', expectedRevision: 1 }), { errorCode: 'INVALID_RESPONSE' });
  for (const status of ['queued', 'running', 'retry_wait', 'paused']) assert.equal(statsSyncIsActive({ status }), true);
  for (const status of ['succeeded', 'partial', 'partial_failed', 'failed', 'cancelled', 'expired', 'no_work']) assert.equal(statsSyncIsActive({ status }), false);
});
