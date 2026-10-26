import './support/v2-baseline/loopback-only.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './support/v2-source-admin/fixture.mjs';
import { createSourceAdmin, installSourceAdminSchema } from '../server/v2/source-admin/index.js';
import { grant } from '../server/v2/identity/permissions.js';
import { runStoreWriteTask } from '../server/store.js';
const setup = async t => { const f = await fixture(); t.after(() => f.close()); return f; };
const err = code => e => e.errorCode === code;
const call = (f, action, input = {}, id = randomUUID(), actor = 'root') => f.service.command(f.actor(actor), action, { expectedRevision: f.revision(action.split('.')[0]), ...input }, id);
const bm = 'synthetic-bm-secret-at-least-24';
const steam = 'synthetic-steam-secret-32';

test('explicit schema install and repeated projections are read-only with no credential copy', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); const before = db.prepare('SELECT total_changes() n').get().n;
  assert.equal(installSourceAdminSchema(db).required, true); assert.equal(db.prepare('SELECT total_changes() n').get().n, before);
  assert.throws(() => createSourceAdmin({ identity: { repo: { db } } }), err('SOURCE_ADMIN_MIGRATION_REQUIRED'));
  const f = await setup(t), snapshot = f.repo.scalar('settings'), total = f.db.prepare('SELECT total_changes() n').get().n;
  for (let i = 0; i < 4; i++) f.service.read(f.actor('root'));
  assert.deepEqual(f.repo.scalar('settings'), snapshot); assert.equal(f.db.prepare('SELECT total_changes() n').get().n, total); assert.equal(f.patches(), 0);
  const key = f.service.repo.signatureKey; installSourceAdminSchema(f.db, { apply: true }); assert.equal(f.service.repo.signatureKey, key);
  assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM v2_source_admin_meta').all()).includes(snapshot.battlemetrics.apiKey));
});
test('BM dedup, stable IDs, labels, primary selection and removal use canonical settings', async t => {
  const f = await setup(t), original = f.repo.scalar('settings');
  const a = await call(f, 'battlemetrics.save', { apiKey: bm, label: '备用' });
  const b = await call(f, 'battlemetrics.save', { apiKey: bm, label: '重命名' }); assert.equal(a.keyId, b.keyId);
  let state = f.service.read(f.actor('root'), 'battlemetrics'); assert.equal(state.keys.length, 2); assert.equal(state.keys[1].label, '重命名');
  await call(f, 'battlemetrics.primary', { id: a.keyId }); assert.equal(f.repo.scalar('settings').battlemetrics.apiKey, bm);
  await call(f, 'battlemetrics.save', { id: a.keyId, label: '主密钥' });
  const rotated = bm + '-rotated'; await call(f, 'battlemetrics.save', { id: a.keyId, apiKey: rotated });
  assert.equal(f.repo.scalar('settings').battlemetrics.apiKeys[0].id, a.keyId); assert.equal(f.repo.scalar('settings').battlemetrics.apiKey, rotated);
  await call(f, 'battlemetrics.delete', { id: a.keyId }); assert.equal(f.repo.scalar('settings').battlemetrics.apiKey, original.battlemetrics.apiKey);
  const settings = f.repo.scalar('settings'); assert.deepEqual(settings.discord, original.discord); assert.deepEqual(settings.system, original.system); assert.deepEqual(f.cache.settings, settings);
  await call(f, 'battlemetrics.clear'); assert.equal(f.repo.scalar('settings').battlemetrics.apiKey, ''); assert.deepEqual(f.repo.scalar('settings').battlemetrics.apiKeys, []);
});
test('legacy missing IDs normalize only on explicit write with deterministic projection', async t => {
  const f = await setup(t), settings = f.repo.scalar('settings'); settings.battlemetrics = { apiKey: bm, extra: 'keep', apiKeys: [{ apiKey: bm, label: 'A', custom: 1 }, { apiKey: bm, label: 'duplicate' }, { apiKey: bm + '2', id: 'same' }, { apiKey: bm + '3', id: 'same' }] }; f.repo.setScalar('settings', settings);
  const a = f.service.read(f.actor('root'), 'battlemetrics'), b = f.service.read(f.actor('root'), 'battlemetrics'); assert.deepEqual(a, b); assert.equal(new Set(a.keys.map(k => k.id)).size, 3);
  await call(f, 'battlemetrics.save', { id: a.keys[0].id, label: 'B' });
  const saved = f.repo.scalar('settings').battlemetrics; assert.equal(saved.apiKeys.length, 3); assert.equal(saved.extra, 'keep'); assert.equal(saved.apiKeys[0].custom, 1); assert.equal(saved.apiKeys[0].id, a.keys[0].id);
});
test('editing into another saved BM secret is explicit conflict without deleting either ID', async t => {
  const f = await setup(t), a = await call(f, 'battlemetrics.save', { apiKey: bm });
  const settings = f.repo.scalar('settings'); await assert.rejects(call(f, 'battlemetrics.save', { id: a.keyId, apiKey: settings.battlemetrics.apiKeys[0].apiKey }), err('DUPLICATE_KEY'));
  assert.deepEqual(f.repo.scalar('settings'), settings);
});
test('Steam length validation rejects truncation and clearing keeps unrelated fields', async t => {
  const f = await setup(t); for (const apiKey of ['a'.repeat(15), 'a'.repeat(129), 'a'.repeat(18) + '\nBAD']) await assert.rejects(call(f, 'steam.save', { apiKey }), err('INVALID_SECRET_LENGTH'));
  for (const apiKey of ['a'.repeat(16), 'a'.repeat(128), steam]) { await call(f, 'steam.save', { apiKey }); assert.equal(f.repo.scalar('settings').steamWebApi.apiKey, apiKey); }
  await call(f, 'steam.clear'); assert.equal(f.repo.scalar('settings').steamWebApi.apiKey, ''); assert.equal(f.service.read(f.actor('root'), 'steam').storeConfigured, false);
});
test('verified owner alone writes; explicit admin reads and custom grants cannot establish ownership', async t => {
  const f = await setup(t);
  assert.equal(f.service.read(f.actor('admin'), 'steam').canWrite, false);
  for (const action of ['steam.save', 'steam.clear', 'battlemetrics.save', 'battlemetrics.clear']) await assert.rejects(call(f, action, { apiKey: bm }, randomUUID(), 'admin'), err('ROOT_REQUIRED'));
  assert.throws(() => f.service.read(f.actor('impostor'), 'steam'), err('ACCESS_DENIED'));
  const root = f.repo.get('accounts', 'root');
  f.repo.put('accounts', { ...root, grants: [grant('system.api_keys', { type: 'all' }, { effect: 'deny' })] });
  assert.equal(f.service.read(f.actor('root'), 'steam').canWrite, true);
  const binding = f.repo.all('bindings').find(row => row.accountId === 'root');
  f.repo.put('bindings', { ...binding, status: 'legacy_unverified' });
  assert.throws(() => f.service.read(f.actor('root')), err('ACCESS_DENIED'));
  await assert.rejects(f.service.command(f.actor('root'), 'steam.clear', {}, randomUUID()), err('ACCESS_DENIED'));
});
test('same operation replay is stable, actor/action/body conflicts fail, concurrent same key commits once', async t => {
  const f = await setup(t), id = randomUUID(), input = { expectedRevision: f.revision('steam'), apiKey: steam };
  const [a, b] = await Promise.all([f.service.command(f.actor('root'), 'steam.save', input, id), f.service.command(f.actor('root'), 'steam.save', input, id)]);
  assert.equal(a.operationId, b.operationId); assert.equal(b.replayed, true); assert.equal(f.db.prepare('SELECT count(*) n FROM v2_source_admin_audits').get().n, 1);
  await assert.rejects(f.service.command(f.actor('root'), 'steam.save', { ...input, apiKey: steam + '-other' }, id), err('OPERATION_CONFLICT'));
  await assert.rejects(f.service.command(f.actor('root'), 'steam.clear', { expectedRevision: input.expectedRevision }, id), err('OPERATION_CONFLICT'));
  assert.throws(() => f.service.getOperation(f.actor('impostor'), id), err('ACCESS_DENIED'));
});
test('observed revision fences concurrent writes and out-of-band legacy writes', async t => {
  const f = await setup(t), expectedRevision = f.revision('steam');
  const results = await Promise.allSettled([f.service.command(f.actor('root'), 'steam.save', { expectedRevision, apiKey: steam }, randomUUID()), f.service.command(f.actor('root'), 'steam.save', { expectedRevision, apiKey: steam + '-other' }, randomUUID())]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(results.find(r => r.status === 'rejected').reason.errorCode, 'REVISION_CONFLICT');
  const old = f.revision(); await runStoreWriteTask(() => { const s = f.repo.scalar('settings'); s.battlemetrics.apiKey = bm; f.repo.setScalar('settings', s); });
  await assert.rejects(call(f, 'battlemetrics.clear', { expectedRevision: old }), err('REVISION_CONFLICT'));
});
test('original global write queue gates settings mutation and preserves concurrent unrelated writes', async t => {
  const f = await setup(t); let release, entered; const gate = new Promise(r => release = r), inQueue = new Promise(r => entered = r);
  const blocker = runStoreWriteTask(async () => { entered(); await gate; const s = f.repo.scalar('settings'); s.unrelated = { retained: true }; f.repo.setScalar('settings', s); });
  await inQueue; const p = call(f, 'steam.save', { apiKey: steam }); await new Promise(r => setImmediate(r)); assert.equal(f.repo.scalar('settings').steamWebApi, undefined);
  release(); await blocker; await p; assert.deepEqual(f.repo.scalar('settings').unrelated, { retained: true });
});
test('transaction failure rolls back credentials, receipt and audit; sanitized failure can retry same key', async t => {
  const f = await setup(t), before = f.repo.scalar('settings'), id = randomUUID(), input = { expectedRevision: f.revision('steam'), apiKey: steam };
  f.db.exec("CREATE TEMP TRIGGER source_audit_failure BEFORE INSERT ON v2_source_admin_audits BEGIN SELECT RAISE(ABORT,'synthetic-secret-error'); END");
  await assert.rejects(f.service.command(f.actor('root'), 'steam.save', input, id), err('SOURCE_ADMIN_UNAVAILABLE'));
  assert.deepEqual(f.repo.scalar('settings'), before); assert.equal(f.service.repo.operation(id), undefined); assert.equal(f.patches(), 0);
  f.db.exec('DROP TRIGGER source_audit_failure'); await f.service.command(f.actor('root'), 'steam.save', input, id); assert.equal(f.repo.scalar('settings').steamWebApi.apiKey, steam);
});
test('post-commit cache failure is repaired by same operation without reapplying old settings', async t => {
  const f = await setup(t), id = randomUUID(), input = { expectedRevision: f.revision('steam'), apiKey: steam }; let fail = true;
  f.hooks.beforeCache = () => { if (fail) throw Error(steam); };
  await assert.rejects(f.service.command(f.actor('root'), 'steam.save', input, id), err('CACHE_REFRESH_REQUIRED'));
  assert.equal(f.repo.scalar('settings').steamWebApi.apiKey, steam); assert.equal(f.service.getOperation(f.actor('root'), id).cacheState, 'not_checked');
  fail = false; await call(f, 'steam.save', { apiKey: steam + '-newer' });
  const replay = await f.service.command(f.actor('root'), 'steam.save', input, id); assert.equal(replay.replayed, true); assert.equal(f.cache.settings.steamWebApi.apiKey, steam + '-newer');
  await f.service.recover(f.actor('root'), id); assert.equal(f.db.prepare('SELECT count(*) n FROM v2_source_admin_audits').get().n, 2);
});
test('cache recovery after a new factory uses durable receipt without retaining plaintext command', async t => {
  const f = await setup(t), id = randomUUID(); f.hooks.beforeCache = () => { throw Error('cache down'); };
  await assert.rejects(call(f, 'steam.save', { apiKey: steam }, id), err('CACHE_REFRESH_REQUIRED')); await f.service.stop();
  const cache = {}, next = createSourceAdmin({ identity: f.identity, patchStoreCache: fn => fn(cache) }); next.start(); t.after(() => next.stop());
  const r = await next.recover(f.actor('root'), id); assert.equal(r.cacheState, 'refreshed'); assert.equal(cache.settings.steamWebApi.apiKey, steam);
});
test('configuration, receipt and audit never echo secrets including secret pasted into BM label', async t => {
  const f = await setup(t), a = await call(f, 'battlemetrics.save', { apiKey: bm, label: bm }); const b = await call(f, 'steam.save', { apiKey: steam });
  const json = JSON.stringify([f.service.read(f.actor('root')), a, b, f.service.getOperation(f.actor('root'), a.operationId), f.db.prepare('SELECT * FROM v2_source_admin_operations').all(), f.db.prepare('SELECT * FROM v2_source_admin_audits').all()]);
  for (const key of [bm, steam, 'fixture-source-key-not-for-browser', 'fixture-bot-secret-not-for-browser']) assert.ok(!json.includes(key));
  assert.ok(json.includes('[已隐藏]')); assert.ok(!json.includes('signatureKey'));
});
test('pending writes recheck authority; stop rejects queued work and drains cache without closing shared DB', async t => {
  const f = await setup(t); let release, entered; const gate = new Promise(r => release = r), inQueue = new Promise(r => entered = r);
  const blocker = runStoreWriteTask(async () => { entered(); await gate; }); await inQueue;
  const p = call(f, 'steam.save', { apiKey: steam }); const rejected = assert.rejects(p, err('SOURCE_ADMIN_STOPPED')); const stopped = f.service.stop(); release(); await blocker; await rejected; await stopped;
  assert.equal(f.repo.scalar('settings').steamWebApi, undefined); assert.equal(f.db.prepare('SELECT 1 n').get().n, 1);
});
test('revocation while waiting on global queue rejects command before transaction', async t => {
  const f = await setup(t); let release; const gate = new Promise(r => release = r); const blocker = runStoreWriteTask(() => gate);
  const p = call(f, 'steam.save', { apiKey: steam }); const check = assert.rejects(p, err('ACCESS_DENIED'));
  const binding = f.repo.all('bindings').find(row => row.accountId === 'root'); f.repo.put('bindings', { ...binding, status: 'legacy_unverified' }); release(); await blocker; await check; assert.equal(f.repo.scalar('settings').steamWebApi, undefined);
});
test('runtime status reports effective precedence only as booleans and never declares a verified connection', async t => {
  const f = await fixture({ readRuntimeStatus: () => ({ providerAvailable: true, injectedCredentialConfigured: true, secret: bm }) }); t.after(() => f.close());
  await call(f, 'steam.save', { apiKey: steam }); assert.equal(f.service.read(f.actor('root'), 'steam').effectiveSource, 'settings');
  const b = f.service.read(f.actor('root'), 'battlemetrics'); assert.equal(b.effectiveSource, 'injected'); assert.equal(b.connectionVerified, false); assert.ok(!JSON.stringify(b).includes(bm));
  await call(f, 'steam.clear'); assert.equal(f.service.read(f.actor('root'), 'steam').effectiveSource, 'injected');
});
test('rotating or deleting old key never unmasks that secret from a saved label',async t=>{
  const f=await setup(t);const a=await call(f,'battlemetrics.save',{apiKey:bm,label:bm});
  await call(f,'battlemetrics.save',{id:a.keyId,apiKey:bm+'-rotated'});assert.ok(!JSON.stringify(f.service.read(f.actor('root'))).includes(bm));
  const settings=f.repo.scalar('settings');assert.ok(!settings.battlemetrics.apiKeys.find(k=>k.id===a.keyId).label.includes(bm));
});
test('unknown host injection state does not misreport saved BM credentials as effective',async t=>{
  const f=await setup(t);const r=f.service.read(f.actor('root'),'battlemetrics');assert.equal(r.storeConfigured,true);assert.equal(r.effectiveSource,'unknown');assert.equal(r.runtimeStatusKnown,false);assert.equal(r.connectionVerified,false);
});
test('stop waits for post-commit cache completion and permanent lifecycle blocks premature restart',async t=>{
  const f=await setup(t);let entered,release;const arrived=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  f.hooks.beforeCache=()=>{entered();return gate;};const saving=call(f,'steam.save',{apiKey:steam});await arrived;let stopped=false;const stop=f.service.stop().then(()=>stopped=true);
  await new Promise(r=>setImmediate(r));assert.equal(stopped,false);assert.throws(()=>f.service.start(),err('SOURCE_ADMIN_ALREADY_STARTED'));
  release();await saving;await stop;assert.equal(f.cache.settings.steamWebApi.apiKey,steam);assert.equal(f.db.prepare('SELECT 1 n').get().n,1);
});
