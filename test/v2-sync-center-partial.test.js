import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './support/v2-sync-center/fixture.mjs';
import { createSyncCenterWorker } from '../server/v2/sync-center/worker.js';

const op = () => ({ operationId: randomUUID() });
const both = ['g05_alpha', 'g05_beta'];
const sourceResults = [
  { source: 'profile', status: 'observed', error: null, required: false, observedCount: 4 },
  { source: 'restriction', status: 'partial', error: 'SOURCE_MISSING_FIELDS', required: true, observedCount: 3 }
];
async function setup(t) {
  let now = Date.now();
  const f = fixture({ now: () => now });
  f.advance = ms => { now += ms; };
  t.after(() => f.close());
  await f.service.saveSource(f.actor(), 'steam', { expectedRevision: 1, minIntervalMs: 0 }, op());
  const apply = f.authority.applyResult;
  f.qualities = new Map();
  f.authority.applyResult = args => {
    apply(args);
    return { quality: f.qualities.get(args.memberId) || 'complete', sourceResults };
  };
  f.request = (ids = both) => f.service.request(f.actor(), { type: 'member_profile', scope: { kind: 'members', memberIds: ids } }, op());
  return f;
}
function invariant(j) {
  assert.equal(j.counts.total, j.counts.succeeded + j.counts.partial + j.counts.failed + j.counts.skipped + j.counts.pendingOrRunning);
}

test('partial source evidence is saved once and completes the job without claiming complete success', async t => {
  const f = await setup(t); f.qualities.set('g05_alpha', 'partial');
  const { job } = await f.request(); await f.drain();
  const detail = f.service.detail(f.actor(), job.id);
  assert.equal(detail.status, 'partial');
  assert.deepEqual(detail.counts, { total: 2, succeeded: 1, partial: 1, failed: 0, skipped: 0, pendingOrRunning: 0 });
  invariant(detail);
  assert.equal(detail.items[0].status, 'partial'); assert.equal(detail.items[0].quality, 'partial');
  assert.equal(detail.items[0].reason, 'RISK_SCAN_INCOMPLETE');
  assert.deepEqual(detail.items[0].sourceResults, sourceResults);
  assert.equal(detail.items[0].attempts, 1); assert.equal(f.commits.length, 2);
  assert.equal(await f.worker.step(), null);
  assert.equal(f.service.list(f.actor(), { status: 'incomplete' }).items[0].id, job.id);
  assert.throws(() => f.service.detail(f.actor('alpha'), job.id), { status: 404 });
});

test('unknown risk evidence remains failed and mixed partial/failed work is partial_failed', async t => {
  const f = await setup(t); f.qualities.set('g05_alpha', 'unknown'); f.qualities.set('g05_beta', 'partial');
  const unknown = await f.request(['g05_alpha']); await f.drain();
  const d = f.service.detail(f.actor(), unknown.job.id);
  assert.equal(d.status, 'failed'); assert.equal(d.items[0].quality, 'unknown');
  assert.equal(d.counts.succeeded, 0); assert.equal(d.counts.partial, 0); assert.equal(d.counts.failed, 1);
  const mixed = await f.request(); await f.drain();
  const m = f.service.detail(f.actor(), mixed.job.id);
  assert.equal(m.status, 'partial_failed'); assert.equal(m.counts.partial, 1); assert.equal(m.counts.failed, 1); invariant(m);
});

test('manual retry includes partial and failed members while preserving already complete members', async t => {
  const f = await setup(t); f.qualities.set('g05_alpha', 'partial'); f.qualities.set('g05_beta', 'unknown');
  const { job } = await f.request([...both, 'g05_foreign']); await f.drain();
  const before = f.service.detail(f.actor(), job.id);
  const failedPage = f.service.detail(f.actor(), job.id, { failure: true, limit: 1 });
  assert.equal(failedPage.items[0].memberId, 'g05_alpha'); assert.equal(failedPage.nextOffset, 1);
  assert.equal(f.service.detail(f.actor(), job.id, { failure: true, offset: 1, limit: 1 }).nextOffset, null);
  f.qualities.clear();
  const retry = await f.service.action(f.actor(), job.id, 'retry', { expectedRevision: before.revision }, op());
  await f.drain();
  const done = f.service.detail(f.actor(), retry.job.id);
  assert.deepEqual(done.items.map(i => i.memberId), both); assert.equal(done.status, 'succeeded');
  assert.equal(f.calls.filter(c => c.memberId === 'g05_foreign').length, 1);
  assert.equal(f.service.detail(f.actor(), job.id).status, 'partial_failed');
});

for (const mode of ['cancelled', 'expired']) test(`${mode} jobs retain completed partial evidence`, async t => {
  const f = await setup(t); f.qualities.set('g05_alpha', 'partial');
  const { job } = await f.request(); await f.worker.step();
  if (mode === 'cancelled') {
    const d = f.service.detail(f.actor(), job.id);
    await f.service.action(f.actor(), job.id, 'cancel', { expectedRevision: d.revision }, op());
  } else { f.advance(3600001); await f.worker.step(); }
  const d = f.service.detail(f.actor(), job.id);
  assert.equal(d.status, mode); assert.equal(d.items[0].status, 'partial'); assert.equal(d.items[1].status, 'skipped');
  assert.equal(d.counts.partial, 1); invariant(d);
});

test('a fresh worker resumes only the remaining target after a partial checkpoint', async t => {
  const f = await setup(t); f.qualities.set('g05_alpha', 'partial');
  const { job } = await f.request(); await f.worker.step(); await f.worker.stop();
  const worker = createSyncCenterWorker(f.service, { providers: f.providers });
  try { await worker.step(); } finally { await worker.stop(); }
  const detail = f.service.detail(f.actor(), job.id);
  assert.equal(detail.status, 'partial'); assert.equal(detail.counts.pendingOrRunning, 0);
  assert.equal(f.calls.filter(c => c.memberId === 'g05_alpha').length, 1);
});
