import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/v2-stats/fixture.mjs';
import { installMemberAdminSchema } from '../server/v2/member-admin/repository.js';
import { installSyncCenterSchema } from '../server/v2/sync-center/repository.js';
import { installRealtimeSchema } from '../server/v2/realtime/repository.js';
import { installPlatformAdminSchema } from '../server/v2/platform-admin/repository.js';
import { createManagementRuntime } from '../server/v2/management-runtime/index.js';
import { SchedulingService } from '../server/v2/scheduling/service.js';

function setup(t, { makeScheduling, runStoreWriteTask }) {
  const f = fixture();
  installMemberAdminSchema(f.db);
  installSyncCenterSchema(f.db);
  installRealtimeSchema(f.db);
  installPlatformAdminSchema(f.db);
  const scheduling = makeScheduling(f);
  const runtime = createManagementRuntime({
    getIdentity: () => f.identity,
    getScheduling: () => scheduling,
    runStoreWriteTask,
    patchStoreCache: fn => fn({}),
    intervalMs: 60_000
  });
  t.after(async () => { await runtime.stop(); f.db.close(); });
  return { ...f, runtime };
}

function serializedWrites(observed) {
  let tail = Promise.resolve(), active = 0;
  const run = fn => {
    const work = tail.then(async () => {
      active++;
      observed.maxActive = Math.max(observed.maxActive, active);
      try { return await fn(); }
      finally { active--; }
    });
    tail = work.catch(() => {});
    return work;
  };
  return { run, drained: () => tail, active: () => active };
}

test('management tick advances due wipes first and at most once per 15 seconds', async t => {
  let now = 1_000, calls = 0;
  t.mock.method(Date, 'now', () => now);
  const events = [], observed = { maxActive: 0 };
  const queue = serializedWrites(observed);
  const makeScheduling = f => Object.assign(new SchedulingService(f.sr, f.identity), { advanceDueWipes() {
    assert.equal(queue.active(), 1);
    calls++;
    events.push('scheduling');
  } });
  const f = setup(t, { makeScheduling, runStoreWriteTask: queue.run });
  const system = f.runtime.getSystem(f.identity);
  system.service.tick = async () => { events.push('provider'); throw new Error('provider failed'); };

  await assert.rejects(f.runtime.tick(), /provider failed/);
  assert.deepEqual(events, ['scheduling', 'provider']);
  now += 14_999;
  await assert.rejects(f.runtime.tick(), /provider failed/);
  assert.equal(calls, 1);
  now += 1;
  await assert.rejects(f.runtime.tick(), /provider failed/);
  assert.equal(calls, 2);
  assert.equal(observed.maxActive, 1);
});

test('stop drains a due-wipe advancement queued behind the shared write owner', async t => {
  const observed = { maxActive: 0 };
  const queue = serializedWrites(observed);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let blockerEntered;
  const blockerReady = new Promise(resolve => { blockerEntered = resolve; });
  const blocker = queue.run(async () => { blockerEntered(); await gate; });
  let calls = 0;
  const makeScheduling = f => Object.assign(new SchedulingService(f.sr, f.identity), { advanceDueWipes() {
    assert.equal(queue.active(), 1);
    calls++;
  } });
  const f = setup(t, { makeScheduling, runStoreWriteTask: queue.run });
  f.runtime.getSystem(f.identity);
  await blockerReady;

  const tick = f.runtime.tick();
  let stopped = false;
  const stop = f.runtime.stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.equal(calls, 0);

  release();
  await Promise.all([blocker, tick, stop]);
  await queue.drained();
  assert.equal(calls, 1);
  assert.equal(observed.maxActive, 1);
  assert.equal(f.runtime.diagnostics().tickActive, false);
});
