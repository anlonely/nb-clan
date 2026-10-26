import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture, catalog } from './support/v2-platform-admin-extras/fixture.mjs';
import { createPlatformAdminExtras, createPlatformAdminExtrasRouter, installPlatformAdminExtrasSchema } from '../server/v2/platform-admin-extras/index.js';
import { installIdentitySchema, IdentityRepository } from '../server/v2/identity/repository.js';
import { IdentityService } from '../server/v2/identity/service.js';
import { grant } from '../server/v2/identity/permissions.js';
import { legacyFingerprint } from '../server/v2/identity/migration.js';
import { createMiniProgramAdapter } from '../server/v2/platform-admin/mini-program.js';
import { installPlatformAdminSchema } from '../server/v2/platform-admin/repository.js';
import { patch } from '../server/v2/platform-admin-extras/model.js';
const input = (extra = {}) => ({ serverProfileId: 'profile-eu', expectedRevision: 0, name: 'Changed', ...extra });
const error = code => e => e.errorCode === code;
const setup = t => { const f = fixture(); t.after(() => f.close()); return f; };
function account(f, id, grants, legacyRole) {
  let legacy = {};
  if (legacyRole) { const u = { id: `legacy-${id}`, role: legacyRole, username: id }; f.ir.put('users', u); legacy = { legacyUserId: u.id, legacyFingerprint: legacyFingerprint(u, []) }; }
  f.ir.put('accounts', { id, status: 'active', roleId: 'admin', grants, permissionVersion: 1, revision: 1, ...legacy });
  return f.identity.actorForAccount(id);
}
test('summary reuses real scoped member/stats reads, no foreign counts or records', async t => {
  const f = setup(t), a = f.member();
  const originalAll = f.ir.all.bind(f.ir);
  f.ir.all = name => { assert.notEqual(name, 'members', 'must not scan member roster'); return originalAll(name); };
  const s = f.extras.service.summary(a, { wipeId: 'g07_active' });
  assert.equal(s.members.total, 1); assert.equal(s.squads.total, 1); assert.equal(s.stats.total, 1);
  assert.equal(s.wipe.countKnown, false); assert.equal(s.counts.wipe, null);
  for (const key of ['logs','review','export']) assert.equal(Object.hasOwn(s, key), false);
  assert.equal(s.scope.permissionVersion, a.permissionVersion); assert.equal(s.scope.wipeId, 'g07_active');
  assert.equal(s.observedAt, '2026-09-08T04:00:00.000Z'); assert.ok(s.stats.version);
  assert.equal(JSON.stringify(s).includes('g05_foreign'), false);
});
test('summary requires explicit wipe, reports unknown old pending/export/today totals', t => {
  const f = setup(t);
  assert.throws(() => f.extras.service.summary(f.admin(), {}), error('EXPLICIT_WIPE_REQUIRED'));
  const s = f.extras.service.summary(f.admin(), { wipeId: 'g07_active' });
  assert.equal(s.members.total, 5); assert.equal(s.review, undefined); assert.equal(Object.hasOwn(s.counts, 'review'), false);
  assert.equal(s.logs.total, null); assert.equal(s.logs.partial, true);
  assert.equal(s.logs.range.from, '2026-09-07T16:00:00.000Z'); assert.equal(s.export.countKnown, false);
  assert.equal(JSON.stringify(s).includes('never-return'), false);
});
test('retired review counts stay absent and stored grants cannot redefine fixed member authority', t => {
  const f = setup(t), a = f.ir.get('accounts', f.member().id);
  f.ir.put('accounts', { ...a, grants: [...a.grants, grant('members.review', { type: 'squads', ids: ['g05_squad'] }), grant('stats.read', { type: 'all' }, { effect: 'deny' })] });
  const s = f.extras.service.summary(f.member(), { wipeId: 'g07_active' });
  assert.equal(s.review, undefined); assert.equal(s.stats.total, 1);
});
test('constructor/GET require explicit migration and perform no writes', async t => {
  const f = setup(t), before = f.db.prepare('SELECT total_changes() n').get().n;
  f.extras.service.servers(f.admin()); f.extras.service.summary(f.admin(), { wipeId: 'g07_active' });
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, before);
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); installIdentitySchema(db);
  assert.throws(() => createPlatformAdminExtras({ ...f.args, identity: new IdentityService(new IdentityRepository(db)), members: undefined, scheduling: undefined, stats: undefined, system: undefined }), error('ADMIN_EXTRAS_MIGRATION_REQUIRED'));
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='v2_platform_admin_extras_meta'").get(), undefined);
});
test('canonical update, field clears, stable profile mapping, audit/cache/event and wipe snapshot unchanged', async t => {
  const f = setup(t), before = f.sr.get('wipes', 'g07_active');
  const r = await f.extras.service.saveServer(f.admin(), input({ name: '', vipUrl: '', status: 'maintenance', notes: ' note ' }), 'save-one');
  assert.equal(r.current.name, 'EU Monthly'); assert.equal(r.current.vipUrl, ''); assert.equal(r.current.statusLabel, '维护');
  assert.equal(r.current.notes, 'note'); assert.equal(r.revision, 1); assert.equal(r.effects, 'complete');
  assert.deepEqual(f.sr.get('wipes', 'g07_active'), before);
  const settings = f.ir.scalar('settings'); assert.equal(settings.system.brand, 'keep-me'); assert.equal(settings.vitalServers.extra, 'preserve');
  assert.equal(settings.vitalServers.overrides[0].vitalServerId, 'vital-101'); assert.equal(settings.vitalServers.overrides.length, 1);
  assert.equal(f.events.length, 1); assert.equal(f.patches.length, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM v2_platform_admin_extras_audits').get().n, 1);
  assert.equal(JSON.stringify(r).includes('private-not-for-dto'), false);
});
test('global writes reject per-wipe/per-squad grants, arbitrary system capabilities and related denies', async t => {
  const f = setup(t);
  for (const [key, grants] of [
    ['wipe', [grant('wipes.edit', { type: 'wipes', ids: ['g07_active'] })]],
    ['squad', [grant('wipes.edit', { type: 'squads', ids: ['g05_squad'] })]],
    ['system', [grant('system.brand', { type: 'all' })]],
    ['deny', [grant('wipes.edit', { type: 'all' }), grant('wipes.edit', { type: 'wipes', ids: ['g07_active'] }, { effect: 'deny' })]]
  ]) await assert.rejects(f.extras.service.saveServer(account(f, key, grants, 'admin'), input(), key), error('GLOBAL_WIPES_EDIT_REQUIRED'));
  assert.equal(f.extras.service.repo.meta().revision, 0);
});
test('role labels alone cannot grant global writes; current admin assignment and explicit authority are required', async t => {
  const f = setup(t), grants = [grant('wipes.edit', { type: 'all' })];
  for (const [key, legacy] of [['impostor', undefined], ['viewer', 'viewer'], ['custom', 'member_manager']])
    await assert.rejects(f.extras.service.saveServer(account(f, key, grants, legacy), input(), key), error('GLOBAL_WIPES_EDIT_REQUIRED'));
  account(f, 'trusted', grants);
  f.ir.put('accounts', { ...f.ir.get('accounts', 'trusted'), roleId: 'admin', adminAssignedByOwner: true });
  const a = f.identity.actorForAccount('trusted');
  const trusted = createPlatformAdminExtras({ ...f.args, isTrustedRoot: actor => actor.id === a.id });
  assert.equal((await trusted.service.saveServer(a, input(), 'root-decision')).committed, true);
});
test('concurrent writes with same observed revision serialize and exactly one commits', async t => {
  const f = setup(t), second = createPlatformAdminExtras(f.args);
  const results = await Promise.allSettled([
    f.extras.service.saveServer(f.admin(), input(), 'concurrent-a'),
    second.service.saveServer(f.admin(), input({ serverProfileId: 'profile-us' }), 'concurrent-b')
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.errorCode, 'REVISION_CONFLICT');
  assert.equal(f.events.length, 1);
});
test('idempotent replay after a later update returns durable receipt and current state; changed payload conflicts', async t => {
  const f = setup(t), service = f.extras.service;
  await service.saveServer(f.admin(), input(), 'idem');
  await service.saveServer(f.admin(), input({ expectedRevision: 1, name: 'Later' }), 'later');
  const replay = await service.saveServer(f.admin(), input(), 'idem');
  assert.equal(replay.replayed, true); assert.equal(replay.operationReceipt.revision, 1); assert.equal(replay.revision, 2); assert.equal(replay.current.name, 'Later');
  await assert.rejects(service.saveServer(f.admin(), input({ name: 'Other' }), 'idem'), error('IDEMPOTENCY_CONFLICT'));
  assert.equal(f.events.length, 2); assert.equal(f.patches.length, 2);
});
test('cache failure leaves committed durable receipt; recreated service recovers before replay', async t => {
  const f = setup(t); let fail = true;
  const one = createPlatformAdminExtras({ ...f.args, patchCache: async change => { if (fail) throw Error('cache offline'); f.patches.push(change); } });
  const r = await one.service.saveServer(f.admin(), input(), 'cache-fail');
  assert.equal(r.committed, true); assert.equal(r.effects, 'pending'); assert.equal(f.events.length, 0);
  assert.equal(one.service.repo.pending().length, 1); fail = false;
  const two = createPlatformAdminExtras({ ...f.args });
  const replay = await two.service.saveServer(f.admin(), input(), 'cache-fail');
  assert.equal(replay.replayed, true); assert.equal(replay.effects, 'complete'); assert.equal(f.patches.length, 1); assert.equal(f.events.length, 1);
  assert.equal(two.service.repo.pending().length, 0);
});
test('event failure recovers durable event ID without duplicate cache and blocks new writes until repaired', async t => {
  const f = setup(t); let fail = true, attempts = [];
  const x = createPlatformAdminExtras({ ...f.args, publishEvents: async events => { attempts.push(events[0].id); if (fail) throw Error('SSE offline'); } });
  assert.equal((await x.service.saveServer(f.admin(), input(), 'event-fail')).effects, 'pending');
  await assert.rejects(x.service.saveServer(f.admin(), input({ expectedRevision: 1 }), 'blocked-new'), error('EFFECTS_RECOVERY_REQUIRED'));
  assert.equal(x.service.repo.meta().revision, 1); fail = false; await x.service.recover();
  assert.equal(new Set(attempts).size, 1); assert.equal(f.patches.length, 1); assert.equal(x.service.repo.pending().length, 0);
});
test('SQLite rollback covers settings/revision/receipt/audit atomically', async t => {
  const f = setup(t), before = f.ir.scalar('settings');
  f.db.exec("CREATE TEMP TRIGGER reject_audit BEFORE INSERT ON v2_platform_admin_extras_audits BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  await assert.rejects(f.extras.service.saveServer(f.admin(), input(), 'rollback'), /fixture failure/);
  assert.deepEqual(f.ir.scalar('settings'), before); assert.equal(f.extras.service.repo.meta().revision, 0);
  assert.equal(f.extras.service.repo.operation(f.admin().id, 'rollback'), undefined); assert.equal(f.events.length, 0);
});
test('changed authoritative settings/catalog fail closed; unrelated settings remain composable', async t => {
  const f = setup(t), s = f.ir.scalar('settings');
  f.ir.setScalar('settings', { ...s, system: { brand: 'new-brand' } });
  await f.extras.service.saveServer(f.admin(), input(), 'unrelated'); assert.equal(f.ir.scalar('settings').system.brand, 'new-brand');
  const next = f.ir.scalar('settings'); next.vitalServers.overrides[0].notes = 'external'; f.ir.setScalar('settings', next);
  assert.equal(f.extras.service.servers(f.admin()).sourceChanged, true);
  await assert.rejects(f.extras.service.saveServer(f.admin(), input({ expectedRevision: 1 }), 'external'), error('CATALOG_SOURCE_CHANGED'));
  assert.throws(() => createPlatformAdminExtras({ ...f.args, readCatalog: () => catalog.map(r => ({ ...r, name: 'Changed base' })) }), error('CATALOG_MAPPING_CHANGED'));
});
test('queued permission/session revocation prevents commit', async t => {
  const f = setup(t); let unlock; const gate = new Promise(resolve => { unlock = resolve; });
  const held = f.runStoreWriteTask(() => gate);
  const pending = f.extras.service.saveServer(f.admin(), input(), 'revoke');
  const a = f.ir.get('accounts', f.admin().id); f.ir.put('accounts', { ...a, permissionVersion: 2, grants: [] });
  unlock(); await held; await assert.rejects(pending, error('PERMISSIONS_CHANGED'));
  assert.equal(f.extras.service.repo.meta().revision, 0);
});
test('URL and direct-connect compatibility, unknown fields and required observations', async t => {
  const f = setup(t);
  for (const directConnect of ['client.connect eu.example.invalid:28014','connect 192.0.2.1:28014','192.0.2.1:28014','steam://connect/192.0.2.1:28014','[::1]:28014']) assert.equal(patch({ directConnect }).directConnect, directConnect);
  for (const directConnect of ['javascript:alert(1)','steam://connect/user:secret@host:1234','host:70000','host:1234;quit']) assert.throws(() => patch({ directConnect }), error('INVALID_DIRECT_CONNECT'));
  for (const vipUrl of ['javascript:alert(1)','https://user:password@example.invalid/','file:///etc/passwd']) assert.throws(() => patch({ vipUrl }), error('INVALID_SERVER_URL'));
  await assert.rejects(f.extras.service.saveServer(f.admin(), input({ actor: { role: 'admin' } }), 'spoof'), error('UNKNOWN_FIELD'));
  await assert.rejects(f.extras.service.saveServer(f.admin(), input({ expectedRevision: undefined }), 'missing'), error('EXPECTED_REVISION_REQUIRED'));
  await assert.rejects(f.extras.service.saveServer(f.admin(), input(), ''), error('IDEMPOTENCY_KEY_REQUIRED'));
  await assert.rejects(f.extras.service.saveServer(f.admin(), input({ serverId: 'vital-us' }), 'map'), error('SERVER_PROFILE_MISMATCH'));
});
test('server router uses real fixed-role fixture actors, revision and idempotency headers', async t => {
  const f = fixture(), app = express(); t.after(() => f.close());
  assert.equal(typeof f.extras.miniAdapters.admin.summary, 'function'); assert.equal(typeof f.extras.miniAdapters.scheduling.saveServer, 'function');
  app.use('/extras', createPlatformAdminExtrasRouter({ service: f.extras.service, authenticate: req => req.get('Authorization') === 'fixture-admin' ? f.admin() : f.member() }));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ errorCode: err.errorCode || err.message }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}/extras`;
  const get = await fetch(`${origin}/summary?wipeId=g07_active`); assert.equal(get.status, 200); assert.equal((await get.json()).members.total, 1);
  const send = (body, auth = 'fixture-admin', key = 'http-save') => fetch(`${origin}/servers/profile-eu`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: auth, 'Idempotency-Key': key }, body: JSON.stringify(body) });
  assert.equal((await send(input(), 'member')).status, 403);
  const saved = await send(input()); assert.equal(saved.status, 200); assert.equal((await saved.json()).revision, 1);
  assert.equal((await (await send(input())).json()).replayed, true);
  assert.equal((await send(input({ expectedRevision: 0 }), 'fixture-admin', 'stale')).status, 409);
  assert.equal((await send(input({ accountId: 'g05_account_admin' }), 'fixture-admin', 'spoof')).status, 422);
});
test('summary rejects nonexistent/unauthorized wipe and unknown export scope; empty daily logs are known zero', t => {
  const f = setup(t);
  assert.throws(() => f.extras.service.summary(f.member(), { wipeId: 'not-a-wipe' }), error('RESOURCE_NOT_FOUND'));
  f.sr.put('wipes', { id: 'private-wipe', lifecycle: 'active', revision: 1, audience: { squadIds: ['g05_foreign_squad'], memberIds: [], includeUnassigned: false } });
  assert.throws(() => f.extras.service.summary(f.member(), { wipeId: 'private-wipe' }), error('RESOURCE_NOT_FOUND'));
  const a = f.ir.get('accounts', f.member().id); f.ir.put('accounts', { ...a, grants: [...a.grants, grant('stats.export', { type: 'wipes', ids: ['private-wipe'] })] });
  assert.equal(f.extras.service.summary(f.member(), { wipeId: 'g07_active' }).export, undefined);
  f.db.prepare("DELETE FROM json_records WHERE collection='logs'").run();
  const s = f.extras.service.summary(f.admin(), { wipeId: 'g07_active' });
  assert.equal(s.logs.countKnown, true); assert.equal(s.logs.total, 0);
});
test('real verified mini session cannot invoke retired summary or server management', async t => {
  const f = fixture(); t.after(() => f.close()); installPlatformAdminSchema(f.db);
  f.ir.put('identities', { id: 'wx-admin', provider: 'wechat:fixture-app', externalId: 'openid-admin', accountId: f.admin().id, verifiedAt: new Date(f.identity.now()).toISOString() });
  const mini = createMiniProgramAdapter({ identity: f.identity, scheduling: f.scheduling, appId: 'fixture-app',
    readConfig: () => ({ enabled: true, appId: 'fixture-app' }),
    exchangeCode: async () => ({ appId: 'fixture-app', verified: true, openid: 'openid-admin' }), adapters: f.extras.miniAdapters });
  const login = await mini.login({ code: 'controlled-code' }), envelope = { token: login.token, operationId: 'mini-extra' };
  assert.equal(mini.authenticate(envelope).actor.id, f.admin().id);
  const before = f.ir.scalar('settings');
  await assert.rejects(mini.command(envelope, 'summary', { wipeId: 'g07_active' }), error('MINI_MANAGEMENT_RETIRED'));
  await assert.rejects(mini.command(envelope, 'server_save', { serverId: 'vital-eu', expectedRevision: 0, notes: 'mini' }), error('MINI_MANAGEMENT_RETIRED'));
  assert.deepEqual(f.ir.scalar('settings'), before); assert.equal(f.extras.service.repo.meta().revision, 0);
  const a = f.ir.get('accounts', f.admin().id); f.ir.put('accounts', { ...a, permissionVersion: 2 });
  assert.throws(() => mini.authenticate(envelope), error('MINI_SESSION_REVOKED'));
});

test('disk SQLite reopen recovers committed receipt/cache/event after service loss', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'admin-extras-recovery-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'isolated.sqlite'), f = fixture({ file, patchCache: async () => { throw Error('interrupted cache'); } });
  const saved = await f.extras.service.saveServer(f.admin(), input(), 'disk-recovery'); assert.equal(saved.effects, 'pending');
  await f.close();
  const db = new DatabaseSync(file); t.after(() => db.close());
  const identity = new IdentityService(new IdentityRepository(db)); const effects = [];
  let tail = Promise.resolve();
  const x = createPlatformAdminExtras({ identity, readCatalog: () => catalog, runStoreWriteTask: fn => { const p = tail.then(fn); tail = p.catch(() => {}); return p; },
    patchCache: value => { effects.push(['cache', value.revision]); }, publishEvents: events => { effects.push(['event', events[0].id]); } });
  const replay = await x.service.saveServer(identity.actorForAccount('g05_account_admin'), input(), 'disk-recovery');
  assert.equal(replay.replayed, true); assert.equal(replay.current.name, 'Changed'); assert.equal(replay.revision, 1);
  assert.deepEqual(effects, [['cache', 1], ['event', 'admin-extras:1']]); assert.equal(x.service.repo.pending().length, 0);
});
test('catalog mapping ambiguity and async authority fail closed before write', async t => {
  const f = setup(t);
  assert.throws(() => createPlatformAdminExtras({ ...f.args, readCatalog: () => [catalog[0], { ...catalog[1], id: catalog[0].serverProfileId }] }), error('AMBIGUOUS_CATALOG_MAPPING'));
  const x = createPlatformAdminExtras({ ...f.args, authorizeLegacyServerManagement: async () => true });
  await assert.rejects(x.service.saveServer(f.admin(), input(), 'async'), error('SYNCHRONOUS_AUTHORITY_REQUIRED'));
  assert.equal(f.extras.service.repo.meta().revision, 0);
});
