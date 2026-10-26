import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './support/v2-source-adapters/fixture.mjs';
import { createManagementSourceAdapters, createStatsSyncBridge } from '../server/v2/management-adapters/sources/index.js';
import { StatsService } from '../server/v2/stats/service.js';
const scope = { kind: 'members', memberIds: ['g05_alpha'], wipeId: 'fixture-wipe' };
const op = () => ({ operationId: randomUUID() });
async function setup(t) { const f = await fixture(); t.after(() => f.close()); return f; }
async function run(f, type, selected = scope) { const { job } = await f.service.request(f.actor(), { type, scope: selected }, op()); await f.worker.step(); return f.service.detail(f.actor(), job.id); }
const profile = f => f.adapters.store.profile(f.repo.get('members', 'g05_alpha'));

test('active collectors: actual HTTP, same SQLite domain fields and stable authority receipts', async t => {
  const f = await setup(t);
  for (const type of ['steam_profile_backfill', 'member_profile', 'battlemetrics_identity', 'battlemetrics_playtime', 'kda']) {
    const result = await run(f, type); assert.equal(result.status, 'succeeded', `${type}: ${JSON.stringify(result.items)}`);
  }
  const p = profile(f);
  assert.equal(f.repo.get('members', 'g05_alpha').steamNickname, 'HTTP nickname');
  assert.equal(p.playTimeMinutes, 0); assert.equal(p.battlemetricsServerPlayTimeSeconds, 3600);
  assert.equal(p.hexaytron, undefined);
  const row = f.adapters.store.statsRow('fixture-wipe', 'g05_alpha'); assert.equal(row.kills, 0); assert.equal(row.assists, null);
  assert.equal(f.db.prepare("SELECT count(*) n FROM json_records WHERE collection='kdaSnapshots'").get().n, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM v2_source_adapter_receipts').get().n, 5);
  assert.equal(f.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.ok(f.calls.some(c => c.method === 'POST' && c.path === '/players/match'));
  assert.equal(f.queue.snapshot().limits.globalUsed, 2);
  assert.equal(f.cache.get('members:g05_alpha').steamNickname, 'HTTP nickname');
});
test('unknown coverage remains missing; real zero matches; GET projection never collects or writes', async t => {
  const f = await setup(t);
  let coverage = f.service.coverage(f.actor(), { type: 'battlemetrics_playtime', scope: 'current_wipe', id: 'fixture-wipe' });
  assert.equal(coverage.observedAt, null); assert.equal(coverage.coverage.matched, 0);
  await run(f, 'battlemetrics_identity');
  f.behaviors.set('/players/501/relationships/sessions', (_q, r) => r.end(JSON.stringify({ data: [] })));
  await run(f, 'battlemetrics_playtime');
  const before = f.db.prepare('SELECT total_changes() n').get().n, calls = f.calls.length;
  coverage = f.service.coverage(f.actor(), { type: 'battlemetrics_playtime', scope: 'current_wipe', id: 'fixture-wipe' });
  assert.equal(coverage.coverage.matched, 1); assert.equal(profile(f).battlemetricsServerPlayTimeSeconds, 0);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, before); assert.equal(f.calls.length, calls);
  assert.equal(f.adapters.authority.isMissing({ type: 'battlemetrics_playtime', scope, member: f.repo.get('members', 'g05_alpha') }), false);
});
test('alias candidate confirmation is versioned, unique, idempotent and never creates Steam bindings', async t => {
  const f = await setup(t);
  f.behaviors.set('/players/match', (_q, r) => r.end(JSON.stringify({ data: [] })));
  f.behaviors.set('/players', (_q, r) => r.end(JSON.stringify({ data: [{ type: 'player', id: '777', attributes: { name: 'alias' } }] })));
  const d = await run(f, 'battlemetrics_identity'); assert.equal(d.status, 'failed'); assert.equal(d.items[0].candidates[0].confidence, 'alias');
  const beforeBindings = JSON.stringify(f.repo.all('bindings'));
  const body = { expectedRevision: d.revision, memberId: 'g05_alpha', battlemetricsId: '777', expectedMemberRevision: f.repo.get('members', 'g05_alpha').revision };
  await assert.rejects(f.service.confirmCandidate(f.actor(), d.id, { ...body, expectedMemberRevision: 0 }, op()), { errorCode: 'REVISION_CONFLICT' });
  const foreign = f.repo.get('members', 'g05_beta'); f.repo.put('members', { ...foreign, battlemetricsId: '777' });
  await assert.rejects(f.service.confirmCandidate(f.actor(), d.id, body, op()), { errorCode: 'IDENTITY_CONFLICT' });
  f.repo.put('members', foreign);
  const options = op(), first = await f.service.confirmCandidate(f.actor(), d.id, body, options);
  assert.deepEqual(await f.service.confirmCandidate(f.actor(), d.id, body, options), first);
  assert.equal(profile(f).battlemetricsMatchConfidence, 'manual'); assert.equal(JSON.stringify(f.repo.all('bindings')), beforeBindings);
});
test('429 retries with real queue quota; credentials pause source; partial/malformed sessions preserve saved facts', async t => {
  const f = await setup(t); await run(f, 'battlemetrics_identity'); await run(f, 'battlemetrics_playtime'); const old = profile(f);
  f.behaviors.set('/players/501/relationships/sessions', (_q, r) => { r.statusCode = 429; r.setHeader('retry-after', '2'); r.end('{}'); });
  let d = await run(f, 'battlemetrics_playtime'); assert.equal(d.status, 'retry_wait'); assert.equal(d.items[0].reason, 'RATE_LIMITED');
  assert.ok(f.queue.snapshot().limits.rateLimitedUntil); assert.deepEqual(profile(f), old);
  // Close the paused retry job and clear only the isolated queue's test windows.
  await f.service.action(f.actor(), d.id, 'cancel', { expectedRevision: d.revision }, op()); f.queue.resetForTests();
  f.behaviors.set('/players/501/relationships/sessions', (_q, r) => r.end(JSON.stringify({ data: [{}] })));
  d = await run(f, 'battlemetrics_playtime'); assert.equal(d.status, 'failed'); assert.deepEqual(profile(f), old);
  f.behaviors.set('/players/501/relationships/sessions', (_q, r) => { r.statusCode = 401; r.end('secret'); });
  d = await run(f, 'battlemetrics_playtime'); assert.equal(d.status, 'paused'); assert.equal(d.items[0].reason, 'CREDENTIALS_INVALID'); assert.ok(!JSON.stringify(d).includes('secret'));
});
test('atomic rollback includes member, profile, Stats ingest, receipts and cache invalidation', async t => {
  const f = await setup(t), original = f.adapters.authority.applyResult;
  f.adapters.authority.applyResult = args => { original(args); throw new Error('injected checkpoint crash'); };
  const before = f.repo.get('members', 'g05_alpha');
  assert.equal((await run(f, 'kda')).status, 'retry_wait');
  assert.deepEqual(f.repo.get('members', 'g05_alpha'), before); assert.equal(profile(f), null);
  assert.equal(f.adapters.store.statsRow('fixture-wipe', 'g05_alpha'), null);
  for (const table of ['v2_stats_operations', 'v2_source_adapter_receipts', 'v2_source_adapter_cache']) assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  assert.equal(f.cache.size, 0);
});
test('late profile result cannot overwrite a concurrent member change; revoked scope cannot commit', async t => {
  for (const mode of ['revision', 'permission']) {
    const f = await setup(t); let release;
    f.behaviors.set('/steam', (_q, r, _b, url) => { release = () => r.end(JSON.stringify({ steamId: url.searchParams.get('steamId'), nickname: 'late' })); });
    const { job } = await f.service.request(f.actor(), { type: 'member_profile', scope }, op());
    const pending = f.worker.step(); while (!release) await new Promise(r => setImmediate(r));
    if (mode === 'revision') f.repo.put('members', { ...f.repo.get('members', 'g05_alpha'), revision: 7 });
    else f.repo.put('accounts', { ...f.repo.get('accounts', f.actor().id), roleId: 'member', adminAssignedByOwner: false, grants: [] });
    release(); await pending; assert.equal(profile(f), null);
    if (mode === 'revision') assert.equal(f.service.detail(f.actor(), job.id).status, 'retry_wait');
  }
});
test('stop aborts actual HTTP request; no late result or authoritative receipt', async t => {
  const f = await setup(t); let started = false;
  f.behaviors.set('/steam', () => { started = true; });
  await f.service.request(f.actor(), { type: 'member_profile', scope }, op()); const pending = f.worker.step();
  while (!started) await new Promise(r => setImmediate(r));
  await f.worker.stop(); await pending;
  assert.equal(profile(f), null); assert.equal(f.db.prepare('SELECT count(*) n FROM v2_source_adapter_receipts').get().n, 0);
});
test('same-connection sync Stats bridge and independent query stay separate', async t => {
  const f = await setup(t), bridge = createStatsSyncBridge({ identity: f.identity, syncService: f.service, readSourceConfig: f.options.readSourceConfig });
  const stats = new StatsService(f.identity, { authorizeWrite: () => true, providers: f.adapters.statsProviders, ...bridge });
  const request = { actor: f.actor(), kind: 'kda', wipeId: 'fixture-wipe', sourceId: 'vital', operationId: 'stats-sync-bridge-1', expectedRevision: 1 };
  const first = await bridge.enqueueSync(request); assert.deepEqual(await bridge.enqueueSync(request), first);
  await f.worker.step(); assert.equal(bridge.readSync({ actor: f.actor(), jobId: first.job.id }).counts.succeeded, 1);
  const before = f.db.prepare("SELECT group_concat(hash) hash FROM json_records").get().hash;
  const raw = await f.adapters.statsProviders.official({ steamInput: f.repo.get('members', 'g05_alpha').steamId }, { signal: new AbortController().signal });
  assert.equal(raw.rows[0].kills, 0); assert.equal(f.db.prepare("SELECT group_concat(hash) hash FROM json_records").get().hash, before);
  assert.ok(stats);
});

test('authority receipt replay is stable; async/outside-transaction calls fail closed', async t => {
  const f = await setup(t);
  const { job } = await f.service.request(f.actor(), { type: 'member_profile', scope }, op());
  const args = { type: 'member_profile', scope: f.service.job(job.id).scope, memberId: 'g05_alpha', operationId: `sync-item:${job.id}:g05_alpha`, signal: new AbortController().signal };
  const response = await f.adapters.collectors.member_profile(args);
  const apply = { ...args, actor: f.actor(), result: response.data, generation: 1, assertCurrent() {} };
  assert.throws(() => f.adapters.authority.applyResult(apply), { errorCode: 'SOURCE_TRANSACTION_REQUIRED' });
  const first = await f.service.atomic(() => f.adapters.authority.applyResult(apply));
  const revision = f.repo.get('members', 'g05_alpha').revision;
  const replay = await f.service.atomic(() => f.adapters.authority.applyResult(apply));
  assert.equal(replay.replayed, true); assert.deepEqual(replay.operationReceipt, first.operationReceipt);
  assert.equal(f.repo.get('members', 'g05_alpha').revision, revision);
  await assert.rejects(f.service.atomic(() => f.adapters.authority.applyResult({ ...apply, result: { ...apply.result, profile: { displayName: 'different' } } })), { errorCode: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(f.service.atomic(async () => {}), /Synchronous transaction required/);
});
test('post-commit cache failure retains durable invalidation and replay repairs cache exactly once', async t => {
  const f = await setup(t); let fail = true, patched = 0;
  const adapters = createManagementSourceAdapters({ ...f.options, patchCache: records => { if (fail) throw new Error('cache failed'); patched += records.length; } });
  const { SyncCenterService } = await import('../server/v2/sync-center/service.js');
  const service = new SyncCenterService({ db: f.db, identity: f.identity, authority: adapters.authority });
  const result = await adapters.collectors.member_profile({ type: 'member_profile', memberId: 'g05_alpha', scope, operationId: 'profile-cache-repair', signal: new AbortController().signal });
  const args = { actor: f.actor(), type: 'member_profile', scope, memberId: 'g05_alpha', result: result.data, operationId: 'profile-cache-repair', assertCurrent() {} };
  await assert.rejects(service.atomic(() => adapters.authority.applyResult(args)), /cache failed/);
  assert.equal(f.repo.get('members', 'g05_alpha').steamNickname, 'HTTP nickname');
  assert.equal(f.db.prepare('SELECT count(*) n FROM v2_source_adapter_cache').get().n, 2);
  fail = false; const replay = await service.atomic(() => adapters.authority.applyResult(args));
  assert.equal(replay.replayed, true); assert.equal(patched, 2);
  assert.equal(f.db.prepare('SELECT count(*) n FROM v2_source_adapter_cache').get().n, 0);
});
test('frozen source context cannot silently switch a queued job; saved source mismatch is missing', async t => {
  const f = await setup(t);
  const { job } = await f.service.request(f.actor(), { type: 'kda', scope }, op());
  f.config.providerWipeId = 'period-changed'; await f.worker.step();
  assert.equal(f.service.detail(f.actor(), job.id).status, 'failed'); assert.equal(f.calls.length, 0);
  f.config.providerWipeId = 'period-1'; await run(f, 'kda');
  assert.equal(f.adapters.authority.isMissing({ type: 'kda', scope, member: f.repo.get('members', 'g05_alpha') }), false);
  f.config.providerWipeId = 'period-2';
  assert.equal(f.adapters.authority.isMissing({ type: 'kda', scope, member: f.repo.get('members', 'g05_alpha') }), true);
});
test('backfill preserves known zero and false; missing source pauses without pretending no_work', async t => {
  const f = await setup(t); await run(f, 'member_profile');
  const p = profile(f); f.put('memberProfiles', { ...p, profilePublic: false, playTimeMinutes: 0, playTimeKnown: true });
  assert.equal((await run(f, 'steam_profile_backfill')).status, 'no_work');
  assert.equal(profile(f).profilePublic, false); assert.equal(profile(f).playTimeMinutes, 0);
  f.config.enabled = false;
  const d = await run(f, 'member_profile'); assert.equal(d.status, 'paused'); assert.equal(d.items[0].reason, 'SOURCE_NOT_CONFIGURED');
});
test('BM pagination origin/path fencing and explicit truncation never save a false zero', async t => {
  const f = await setup(t); await run(f, 'battlemetrics_identity');
  for (const next of ['https://other.invalid/steal', 'https://api.battlemetrics.com/players/other/relationships/sessions', 'https://api.battlemetrics.com/players/501/relationships/sessions?cursor=repeat']) {
    f.behaviors.set('/players/501/relationships/sessions', (_q, r) => r.end(JSON.stringify({ data: [], links: { next } })));
    assert.equal((await run(f, 'battlemetrics_playtime')).status, 'failed');
    assert.equal(profile(f).battlemetricsServerPlayTimeSeconds, undefined);
  }
});
test('same-source partial stats retain saved zero and numbers with explicit coverage/evidence', async t => {
  const f = await setup(t); await run(f, 'kda');
  const old = f.adapters.store.statsRow('fixture-wipe', 'g05_alpha');
  f.put('kdaRows', { ...old, rockets: 99, building: 0 });
  f.behaviors.set('/vital', (_q, r, _body, url) => r.end(JSON.stringify([{ context: { userId: url.searchParams.get('steamId') }, statistics: { combat: { kills: 4, deaths: 0 } } }])));
  assert.equal((await run(f, 'kda')).status, 'succeeded');
  const next = f.adapters.store.statsRow('fixture-wipe', 'g05_alpha');
  assert.equal(next.kills, 4); assert.equal(next.rockets, 99); assert.equal(next.building, 0); assert.equal(next.assists, null);
  assert.equal(next.coverage, 'partial_retained'); assert.equal(profile(f).sourceObservations.kda.retainedFields.rockets, old.capturedAt);
});
