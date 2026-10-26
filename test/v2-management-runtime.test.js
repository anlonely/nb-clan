import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/v2-stats/fixture.mjs';
import { installMemberAdminSchema } from '../server/v2/member-admin/repository.js';
import { installSyncCenterSchema } from '../server/v2/sync-center/repository.js';
import { installRealtimeSchema } from '../server/v2/realtime/repository.js';
import { installPlatformAdminSchema } from '../server/v2/platform-admin/repository.js';
import { createManagementRuntime } from '../server/v2/management-runtime/index.js';
import { AuthContexts } from '../server/v2/identity/contexts.js';
import { installSourceWindowSchema } from '../server/v2/management-adapters/source-window/index.js';
import { installSourceAdapterSchema } from '../server/v2/management-adapters/sources/index.js';

function setup(t, extra = {}) {
  const f = fixture();
  installMemberAdminSchema(f.db);
  installSyncCenterSchema(f.db);
  installSourceWindowSchema(f.db);
  installRealtimeSchema(f.db);
  installPlatformAdminSchema(f.db);
  let tail = Promise.resolve();
  const runtime = createManagementRuntime({ getIdentity: () => f.identity,
    runStoreWriteTask: fn => { const p = tail.then(fn); tail = p.catch(() => {}); return p; },
    patchStoreCache: fn => fn({}), intervalMs: 60000, ...extra });
  t.after(async () => { await runtime.stop(); f.db.close(); });
  return { ...f, runtime };
}

test('HTTP service acquisition shares identity and performs no migration, recovery or collection', async t => {
  const f = setup(t), before = f.db.prepare('SELECT total_changes() n').get().n;
  const a = f.runtime.getSystem(f.identity), b = f.runtime.getSystem(f.identity);
  assert.equal(a, b);
  assert.equal(a.members.identity, f.identity);
  assert.equal(a.stats.identity, f.identity);
  assert.equal(a.service.identity, f.identity);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, before);
  assert.equal(f.runtime.diagnostics().timerActive, false);
  await f.runtime.start();
  await f.runtime.start();
  assert.equal(f.runtime.diagnostics().instances, 1);
  await f.runtime.stop();
  assert.throws(() => f.runtime.getSystem(f.identity), { errorCode: 'MANAGEMENT_RUNTIME_STOPPED' });
});

test('explicit source and member bundles share the runtime domains without GET writes or a second member writer', t => {
  const contexts = new AuthContexts();
  const f = setup(t, { getAuthContexts: () => contexts,
    memberOptions: () => ({ invalidatePlatformSessions: () => {} }),
    sourceOptions: () => ({ readSourceConfig: () => null, readers: {} }) });
  installSourceAdapterSchema(f.db);
  const before = f.db.prepare('SELECT total_changes() n').get().n;
  const system = f.runtime.getSystem(f.identity);
  assert.equal(system.sources.authority, system.service.authority);
  assert.equal(system.memberWrite, system.memberBundle.writeDomain);
  assert.equal(system.memberBundle.identity, f.identity);
  assert.equal(system.platforms.service.adapters.members, system.memberBridges.platform.members);
  assert.equal(typeof system.realtime.members.importMember, 'function');
  assert.equal(typeof system.stats.enqueueSync, 'function');
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, before);
});

test('platform private query before first tick is recovered once and keeps its completed result', async t => {
  const f = setup(t, { sourceHostOptions: () => ({ capabilities: {}, fetchImpl: () => { throw new Error('local member query must not fetch'); } }) });
  installSourceAdapterSchema(f.db);
  const system = f.runtime.getSystem(f.identity);
  assert.equal(system.sources.statsProviders.member, undefined);
  const actor = f.identity.actorForAccount('g05_account_admin');
  const result = await system.platforms.runOperation(() => system.platforms.service.adapters.queries.query({
    actor, input: { sourceId: 'member', steamId: f.identity.repo.get('members', 'g05_alpha').steamId },
    operationId: 'platform_query_runtime_001', assertCurrent() {} }));
  assert.equal(result.items[0].status, 'succeeded');
  await f.runtime.tick();
  assert.equal(system.stats.readJob(actor, result.reference).status, 'succeeded');
  const exported = system.stats.createJob(actor, 'export', { queryJobId: result.reference, format: 'csv', language: 'zh' }, 'runtime_query_csv_001');
  await f.runtime.tick();
  const file = system.stats.readJob(actor, exported.jobId);
  assert.equal(file.status, 'succeeded');
  assert.match(file.result.mime, /^text\/csv/);
  assert.ok(Buffer.from(file.result.base64, 'base64').length > 0);
});

test('shared runtime renders real PNG and PDF and closes its binary owner before teardown', async t => {
  const f = setup(t), system = f.runtime.getSystem(f.identity), actor = f.identity.actorForAccount('g05_account_admin');
  const query = system.stats.createJob(actor, 'query', { sourceId: 'member', steamInput: f.identity.repo.get('members', 'g05_alpha').steamId }, 'binary_runtime_query');
  await f.runtime.tick();
  for (const format of ['png', 'pdf']) {
    const job = system.stats.createJob(actor, 'export', { queryJobId: query.jobId, format, language: 'zh' }, `binary_runtime_${format}`);
    await f.runtime.tick();
    const result = system.stats.readJob(actor, job.jobId);
    assert.equal(result.status, 'succeeded', JSON.stringify(result.result));
    const bytes = Buffer.from(result.result.base64, 'base64');
    assert.equal(bytes.subarray(0, format === 'png' ? 4 : 5).toString('hex'), format === 'png' ? '89504e47' : '255044462d');
  }
  await f.runtime.stop();
  const state = f.runtime.diagnostics().binaryExports;
  assert.equal(state.stopped, true); assert.equal(state.active, 0); assert.equal(state.queued, 0);
});

test('stop during pending identity startup cannot create a late worker timer', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const f = setup(t, { getIdentity: () => pending });
  const start = f.runtime.start();
  const rejection = assert.rejects(start, { errorCode: 'MANAGEMENT_RUNTIME_STOPPED' });
  const stop = f.runtime.stop();
  release(f.identity);
  await Promise.all([rejection, stop]);
  const { binaryExports, ...diagnostics } = f.runtime.diagnostics();
  assert.equal(binaryExports.stopped, true); assert.equal(binaryExports.active, 0);
  assert.deepEqual(diagnostics, { stopping: true, stopped: true, instances: 0,
    timerActive: false, tickActive: false, lastErrorCode: null });
});

test('runtime source owner aborts pending vanity network and drains before database close', async t => {
  let entered, aborted = false;
  const ready = new Promise(resolve => { entered = resolve; });
  const f = setup(t, { sourceHostOptions: () => ({ capabilities: { steam: true, vital: true },
    readCredentials: () => ({ steamApiKey: 'isolated-test-key' }),
    fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('isolated abort')); }, { once: true });
      entered();
    }) }) });
  installSourceAdapterSchema(f.db);
  const wipe = f.identity.repo.get('schedulingWipes', 'g07_active');
  f.identity.repo.put('schedulingWipes', { ...wipe,
    serverSnapshot: { kdaProvider: 'vital', vitalServerId: '12', vitalWipeId: 'isolated-period' } });
  const system = f.runtime.getSystem(f.identity);
  const source = system.sourceHost.readSourceConfig({ type: 'kda', scope: { kind: 'current_wipe', id: 'g07_active' } });
  assert.equal(source.enabled, true);
  assert.equal(source.serverId, wipe.serverProfileId);
  assert.equal(source.providerWipeId, 'isolated-period');
  const query = system.sources.statsProviders.official({ steamInput: 'https://steamcommunity.com/id/example' }, {});
  const rejection = assert.rejects(query);
  await ready;
  await f.runtime.stop();
  await rejection;
  assert.equal(aborted, true);
  assert.equal(system.sourceHost.activeIO, 0);
  assert.equal(f.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});
test('stop drains in-flight domain work before its SQLite database can close', async t => {
  const f = setup(t), system = f.runtime.getSystem(f.identity);
  let release, entered;
  const reached = new Promise(resolve => { entered = resolve; });
  system.service.tick = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const tick = f.runtime.tick();
  await reached;
  let stopped = false;
  const stop = f.runtime.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await Promise.all([tick, stop]);
  assert.equal(f.runtime.diagnostics().tickActive, false);
  assert.equal(system.worker.accepting, false);
});

test('platform adapter completion stays tracked after response disconnect until shutdown drains', async t => {
  const f = setup(t), system = f.runtime.getSystem(f.identity);
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const operation = system.platforms.runOperation(async () => {
    entered();
    await new Promise(resolve => { release = resolve; });
    return f.db.prepare('PRAGMA integrity_check').get().integrity_check;
  });
  await ready;
  let drained = false;
  const stop = f.runtime.stop().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  assert.throws(() => system.platforms.runOperation(() => {}), { errorCode: 'MANAGEMENT_RUNTIME_STOPPED' });
  release();
  assert.equal(await operation, 'ok');
  await stop;
});
