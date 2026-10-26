import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/v2-source-adapters/fixture.mjs';
import { createSourceConfiguration } from '../server/v2/management-adapters/source-host/config.js';
import { createManagementSourceAdapters, createStatsSyncBridge } from '../server/v2/management-adapters/sources/index.js';
import { selectVitalWipeForStats } from '../server/v2/management-adapters/sources/vital-wipe-binding.js';
import { SyncCenterService } from '../server/v2/sync-center/service.js';
import { createSyncCenterWorker } from '../server/v2/sync-center/worker.js';

const fixedNow = Date.parse('2026-10-15T18:00:00Z');
const scheduled = '2026-10-15T16:00:00.000Z';
const actual = '2026-10-15T15:59:09.000Z';
const providerWipeId = '48635a1b-71c2-42ce-8532-a401bb550096';
const remote = { id: providerWipeId, gameServerId: 19, startTime: actual };

test('Vital binding matches only the selected server and period, rejecting old, future and ambiguous periods', () => {
  const wipe = { serverScheduledWipeAt: scheduled };
  const select = rows => selectVitalWipeForStats(wipe, '19', rows, fixedNow);
  assert.deepEqual(select([remote, { ...remote }]), { providerServerId: '19', providerWipeId, startTime: actual });
  for (const rows of [[], [{ ...remote, gameServerId: 16 }], [{ ...remote, startTime: '2026-10-08T16:00:00Z' }],
    [{ ...remote, startTime: '2026-10-15T18:00:01Z' }], [{ ...remote, startTime: 'invalid' }]])
    assert.throws(() => select(rows), { errorCode: 'VITAL_WIPE_NOT_FOUND' });
  assert.throws(() => select([remote, { ...remote, id: 'second' }]), { errorCode: 'VITAL_WIPE_AMBIGUOUS' });
  assert.throws(() => select({ data: [remote] }), { errorCode: 'VITAL_WIPE_INVALID_DATA' });
  assert.throws(() => selectVitalWipeForStats({}, '19', [remote], fixedNow), { errorCode: 'VITAL_WIPE_START_REQUIRED' });
  assert.throws(() => selectVitalWipeForStats({ serverScheduledWipeAt: '2026-10-16T16:00:00Z' }, '19', [remote], fixedNow), { errorCode: 'VITAL_WIPE_NOT_STARTED' });
});

async function setup(t, { catalog = async () => [remote], patchCache } = {}) {
  const f = await fixture();
  await f.worker.stop();
  const wipe = { ...f.repo.get('schedulingWipes', 'fixture-wipe'), revision: 2, contentRevision: 7,
    serverProfileId: '19', serverScheduledWipeAt: scheduled, musterAt: scheduled,
    serverSnapshot: { provider: 'vital', kdaProvider: 'vital', vitalServerId: '19' },
    audience: { allMembers: true, memberIds: [], squadIds: [], includeUnassigned: true } };
  f.put('v2Wipes', wipe);
  const source = createSourceConfiguration({ readSettings: () => ({}),
    readWipe: id => f.repo.get('schedulingWipes', id), capabilities: { vital: true } });
  const options = { ...f.options, readSourceConfig: source.readSourceConfig,
    ...(patchCache ? { patchCache: rows => patchCache(rows, f.options.patchCache) } : {}) };
  const adapters = createManagementSourceAdapters(options);
  const service = new SyncCenterService({ db: f.db, identity: f.identity, authority: adapters.authority });
  const worker = createSyncCenterWorker(service, { providers: adapters.providers });
  let reads = 0;
  const bridge = createStatsSyncBridge({ identity: f.identity, syncService: service,
    readSourceConfig: source.readSourceConfig, bindVitalWipe: adapters.bindVitalWipe,
    readVitalWipes: async (...args) => { reads++; return catalog(...args); } });
  const request = { actor: f.actor(), kind: 'kda', wipeId: wipe.id, sourceId: 'vital', expectedRevision: 2, operationId: 'vital-bind-operation' };
  t.after(async () => { await worker.stop(); await f.close(); });
  return { ...f, adapters, service, worker, bridge, request, wipe, reads: () => reads };
}

test('missing Vital ID binds atomically then collects every member without requiring signups; receipt replay never fetches', async t => {
  const f = await setup(t);
  assert.equal(f.db.prepare("SELECT count(*) n FROM json_records WHERE collection='v2Signups'").get().n, 0);
  const first = await f.bridge.enqueueSync(f.request);
  const wipe = f.repo.get('schedulingWipes', f.wipe.id);
  assert.equal(wipe.revision, 3); assert.equal(wipe.contentRevision, 7);
  assert.equal(wipe.serverSnapshot.vitalWipeId, providerWipeId);
  assert.equal(wipe.serverSnapshot.vitalWipeStartedAt, actual);
  assert.deepEqual(f.cache.get(`v2Wipes:${wipe.id}`), wipe);
  const job = f.service.job(first.job.id), members = f.repo.all('members');
  assert.equal(job.items.length, members.length);
  for (const member of members) assert.equal(job.scope.sourceContexts[member.id].providerWipeId, providerWipeId);
  assert.deepEqual(await f.bridge.enqueueSync(f.request), first);
  assert.equal(f.reads(), 1);
  for (let i = 0; i < members.length; i++) await f.worker.step();
  const result = f.service.detail(f.actor(), job.id);
  assert.equal(result.status, 'succeeded', JSON.stringify(result.items));
  assert.equal(result.counts.succeeded, members.length);
  for (const member of members) {
    const row = f.adapters.store.statsRow(wipe.id, member.id);
    assert.equal(row.providerWipeId, providerWipeId); assert.equal(row.kills, 0);
  }
});

test('permission and revision failures are rejected before the catalog request', async t => {
  const f = await setup(t);
  await assert.rejects(f.bridge.enqueueSync({ ...f.request, actor: f.actor('alpha') }), { status: 403 });
  await assert.rejects(f.bridge.enqueueSync({ ...f.request, expectedRevision: 1 }), { errorCode: 'REVISION_CONFLICT' });
  assert.equal(f.reads(), 0);
});

test('two concurrent requests for the same missing binding deduplicate and increase revision once', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const f = await setup(t, { catalog: async () => { await held; return [remote]; } });
  const a = f.bridge.enqueueSync(f.request);
  const b = f.bridge.enqueueSync({ ...f.request, operationId: 'vital-bind-parallel' });
  release();
  const [first, second] = await Promise.all([a, b]);
  assert.equal(first.job.id, second.job.id); assert.equal(second.deduplicated, true);
  assert.equal(f.repo.get('schedulingWipes', f.wipe.id).revision, 3);
  assert.equal(f.service.list(f.actor()).items.length, 1);
});

test('a schedule edit during catalog I/O cannot bind or enqueue the old period', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const f = await setup(t, { catalog: async () => { await held; return [remote]; } });
  const pending = f.bridge.enqueueSync(f.request);
  f.put('v2Wipes', { ...f.wipe, revision: 3, serverScheduledWipeAt: '2026-10-22T16:00:00Z' });
  release();
  await assert.rejects(pending, { errorCode: 'VITAL_WIPE_CONTEXT_CHANGED' });
  assert.equal(f.repo.get('schedulingWipes', f.wipe.id).serverSnapshot.vitalWipeId, undefined);
  assert.equal(f.service.list(f.actor()).items.length, 0);
});

test('failed job insertion rolls back the binding, durable cache record and operation receipt', async t => {
  const f = await setup(t);
  f.service.insert = () => { throw new Error('injected insertion failure'); };
  await assert.rejects(f.bridge.enqueueSync(f.request), /injected insertion failure/);
  assert.deepEqual(f.repo.get('schedulingWipes', f.wipe.id), f.wipe);
  assert.equal(f.db.prepare('SELECT count(*) n FROM v2_source_adapter_cache').get().n, 0);
  assert.equal(f.service.repo.get('receipt', `${f.actor().id}:${f.request.operationId}`), null);
});

test('a cache patch failure preserves the committed binding and replay repairs the cache without another catalog request', async t => {
  let fail = true;
  const f = await setup(t, { patchCache: (rows, apply) => { if (fail && rows.some(r => r.collection === 'v2Wipes')) { fail = false; throw new Error('cache unavailable'); } return apply(rows); } });
  await assert.rejects(f.bridge.enqueueSync(f.request), /cache unavailable/);
  assert.equal(f.repo.get('schedulingWipes', f.wipe.id).revision, 3);
  assert.equal(f.db.prepare('SELECT count(*) n FROM v2_source_adapter_cache').get().n, 1);
  const replay = await f.bridge.enqueueSync(f.request);
  assert.equal(f.reads(), 1); assert.ok(replay.job.id);
  assert.equal(f.cache.get(`v2Wipes:${f.wipe.id}`).serverSnapshot.vitalWipeId, providerWipeId);
  assert.equal(f.db.prepare('SELECT count(*) n FROM v2_source_adapter_cache').get().n, 0);
});

test('a queued job keeps the bound period and refuses a later provider-period change', async t => {
  const f = await setup(t);
  const { job } = await f.bridge.enqueueSync(f.request);
  const wipe = f.repo.get('schedulingWipes', f.wipe.id);
  f.put('v2Wipes', { ...wipe, revision: 4, serverSnapshot: { ...wipe.serverSnapshot, vitalWipeId: 'other-period' } });
  await f.worker.step();
  const saved = f.service.job(job.id);
  assert.equal(saved.scope.sourceContexts[saved.items[0].memberId].providerWipeId, providerWipeId);
  assert.equal(f.db.prepare("SELECT count(*) n FROM json_records WHERE collection='kdaRows'").get().n, 0);
  assert.equal(f.calls.filter(c => c.path === '/vital').length, 0);
});
