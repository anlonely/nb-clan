import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './support/v2-sync-center/fixture.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const request = f => f.service.request(f.actor(), {
  type: 'kda', scope: { kind: 'members', memberIds: ['g05_alpha'] }
}, { operationId: randomUUID() });

test('a saturated source checks a full queue without repeatedly loading all job payloads', async t => {
  const f = fixture();
  t.after(() => f.close());
  const { job } = await request(f);
  const queued = f.service.job(job.id);
  const now = f.service.now();
  // Model a source occupied by a different live worker and the maximum backlog.
  f.service.repo.put('job', { ...queued, status: 'running', owner: 'other-worker', leaseUntil: now + 60_000 });
  for (let i = 1; i < 500; i++) f.service.repo.put('job', {
    ...queued, id: `queued-${i}`, scopeKey: `scope-${i}`, createdAt: now + i
  });
  const original = f.service.repo.activeJobs.bind(f.service.repo);
  let fullQueueReads = 0;
  f.service.repo.activeJobs = () => { fullQueueReads++; return original(); };
  assert.equal(await f.worker.step(), null);
  assert.equal(f.calls.length, 0);
  assert.ok(fullQueueReads <= 2, `A saturated poll reloaded the entire queue ${fullQueueReads} times`);
});

test('stop after claim commit prevents dispatch and leaves that job resumable', async t => {
  const f = fixture();
  t.after(() => f.close());
  const { job } = await request(f);
  const claimed = deferred(), release = deferred();
  const serializeWrite = f.authority.serializeWrite;
  let holdClaim = true;
  f.authority.serializeWrite = fn => serializeWrite(fn).then(async result => {
    if (holdClaim && result?.job?.id === job.id && result?.generation) {
      holdClaim = false;
      claimed.resolve();
      await release.promise;
    }
    return result;
  });
  const step = f.worker.step();
  await claimed.promise;
  const stopped = f.worker.stop();
  release.resolve();
  await Promise.all([step, stopped]);
  assert.equal(f.calls.length, 0, 'Shutdown must not start a new external provider request');
  assert.equal(f.commits.length, 0);
  const stored = f.service.job(job.id);
  assert.equal(stored.status, 'queued');
  assert.equal(stored.items[0].status, 'pending');
  assert.equal(stored.items[0].reason, 'WORKER_STOPPED');
  assert.equal(stored.owner, null);
  assert.equal(stored.leaseUntil, 0);
});
