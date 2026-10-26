import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './support/v2-platform-host/fixture.mjs';
import { hash } from '../server/v2/platform-admin/model.js';

const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const error = code => e => e.errorCode === code;
async function setup(t, options) { const f = fixture({ ...options }); t.after(() => f.close()); await f.start(); return f; }
function bindMember(f) {
  const member = f.ir.get('members', 'm002');
  f.ir.put('members', { ...member, wechatUserId: 'host-wx-user', wechatId: 'host-wx-user' });
  f.ir.put('wechatUsers', { id: 'host-wx-user', memberId: member.id, appId: 'host_app', openid: 'openid-member', status: 'approved', revision: 1 });
}
const unlink = f => {
  const observation = f.memberBundle.lifecycle.observeUnlink(f.actor('admin'), 'm002', 'wechat');
  return f.memberBundle.writeDomain(() => f.members.unlink(f.actor('admin'), 'm002', { ...observation, reason: '隔离解绑验证' }, randomUUID()), { identity: f.identity });
};

test('host fails closed before start / invalidator binding / outbox replay', async t => {
  const f = fixture({}); t.after(() => f.close());
  await assert.rejects(() => f.login(), error('PLATFORM_HOST_NOT_READY'));
  f.setInvalidatorBound(false);
  await assert.rejects(() => f.host.start(), error('PLATFORM_INVALIDATOR_BINDING_REQUIRED'));
  assert.equal(f.host.diagnostics().state, 'created');
  f.setInvalidatorBound(true); await f.start();
  assert.equal(f.host.diagnostics().state, 'ready');
  await f.host.stop(); await f.host.stop();
  assert.equal(f.host.diagnostics().operations, 0);
  assert.throws(() => f.host.start(), error('PLATFORM_HOST_STOPPED'));
});

test('only server app/openid proof can issue mini sessions; code consumption enters queue once', async t => {
  const f = await setup(t), code = 'same-code'; f.proofCodes.set(code, 'member');
  const before = f.queueLog.filter(x => x === 'enqueue').length;
  const values = await Promise.allSettled([f.host.mini.login({ code }), f.host.mini.login({ code })]);
  assert.equal(values.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(values.find(x => x.status === 'rejected').reason.errorCode, 'MINI_CODE_REPLAY');
  assert.equal(f.externalCalls.filter(x => x === 'exchange').length, 1);
  assert.equal(f.queueLog.filter(x => x === 'enqueue').length - before, 3); // two claims, one issuance
  await assert.rejects(() => f.host.mini.login({ code: 'x', openid: 'openid-admin' }), error('CLIENT_ACTOR_FORBIDDEN'));
  await assert.rejects(() => f.host.mini.login({ code: 'x', accountId: 'admin' }), error('CLIENT_ACTOR_FORBIDDEN'));
  const session = values.find(x => x.status === 'fulfilled').value;
  await f.host.mini.logout({ token: session.token });
  assert.throws(() => f.host.mini.authenticate({ token: session.token }), error('MINI_SESSION_INVALID'));
});

test('real member unlink removes exact app identity, all account mini sessions; replay is idempotent', async t => {
  const f = await setup(t); bindMember(f);
  const member = await f.login(), other = await f.login('other');
  f.ir.put('identities', { id: 'other-app-identity', provider: 'wechat:other_app', externalId: 'other-openid', accountId: 'member', revision: 1 });
  f.platformService.repo.put('mini-session', hash('other-app-token'), 'wechat', 'member', f.now(), { appId: 'other_app', externalId: 'other-openid', accountId: 'member', permissionVersion: 1, expiresAt: f.now() + 3600000 });
  const binding = f.ir.get('bindings', 'binding-member');
  await unlink(f);
  assert.equal(f.ir.get('identities', 'host-wx-member'), null);
  assert.equal(f.ir.get('identities', 'other-app-identity').accountId, 'member');
  assert.equal(f.db.prepare("SELECT count(*) n FROM platform_admin_records WHERE kind='mini-session' AND actor='member'").get().n, 0);
  assert.throws(() => f.host.mini.authenticate({ token: member.token }), error('MINI_SESSION_INVALID'));
  assert.equal(f.host.mini.authenticate({ token: other.token }).actor.id, 'other');
  assert.deepEqual(f.ir.get('bindings', 'binding-member'), binding);
  const event = f.ir.all('events').find(e => e.reason === 'member_identity_unlinked');
  assert.equal(event.appId, 'host_app'); assert.equal(f.ir.get('accounts', 'member').permissionVersion, 2);
  f.ir.put('identities', { id: 'host-wx-member', provider: 'wechat:host_app', externalId: 'openid-member', accountId: 'member', revision: 2, verifiedAt: new Date(f.now()).toISOString() });
  const fresh = await f.login();
  f.host.invalidatePlatformSessions(event);
  await f.outbox.drain();
  assert.equal(f.host.mini.authenticate({ token: fresh.token }).actor.id, 'member');
});

test('observed identity fingerprint and member revision are never refreshed at submission', async t => {
  const f = await setup(t); bindMember(f);
  const observation = f.memberBundle.lifecycle.observeUnlink(f.actor('admin'), 'm002', 'wechat');
  const identity = f.ir.get('identities', 'host-wx-member');
  f.ir.put('identities', { ...identity, revision: identity.revision + 1 });
  const session = await f.login('admin');
  await assert.rejects(() => f.command(session.token, 'unbind', { ...observation, reason: '隔离过期观察' }), error('MINI_MANAGEMENT_RETIRED'));
  await assert.rejects(() => f.memberBundle.writeDomain(() => f.members.unlink(f.actor('admin'), 'm002', { ...observation, reason: '隔离过期观察' }, randomUUID()), { identity: f.identity }), error('IDENTITY_OBSERVATION_CHANGED'));
  assert.ok(f.ir.get('identities', 'host-wx-member'));
  await assert.rejects(() => f.memberBundle.writeDomain(() => f.members.unlink(f.actor('admin'), 'm002', { provider: 'wechat', expectedRevision: 1, reason: '没有观察值' }, randomUUID()), { identity: f.identity }), error('IDENTITY_OBSERVATION_REQUIRED'));
});

test('unlink during code exchange fences old proof even if the same identity is rebound', async t => {
  const started = gate(), finish = gate();
  let f;
  f = await setup(t, { options: { wechat: { appId: 'host_app', readConfig: () => f.platformService.config('wechat'),
    exchangeCode: async () => { started.resolve(); await finish.promise; return { verified: true, appId: 'host_app', openid: 'openid-member' }; } } } });
  bindMember(f);
  const attempt = f.host.mini.login({ code: 'in-flight-unlink' });
  const rejected = assert.rejects(attempt, error('AUTH_CONTEXT_EXPIRED'));
  await started.promise; await unlink(f);
  f.ir.put('identities', { id: 'host-wx-member', provider: 'wechat:host_app', externalId: 'openid-member', accountId: 'member', revision: 2, verifiedAt: new Date(f.now()).toISOString() });
  finish.resolve(); await rejected;
  assert.equal(f.db.prepare("SELECT count(*) n FROM platform_admin_records WHERE kind='mini-session'").get().n, 0);
});

test('app configuration changes during exchange cannot issue a session', async t => {
  const started = gate(), finish = gate(); let f;
  f = await setup(t, { options: { wechat: { appId: 'host_app', readConfig: () => f.platformService.config('wechat'),
    exchangeCode: async () => { started.resolve(); await finish.promise; return { verified: true, appId: 'host_app', openid: 'openid-member' }; } } } });
  const attempt = f.host.mini.login({ code: 'in-flight-config' }), rejected = assert.rejects(attempt, error('MINI_CONFIG_CHANGED'));
  await started.promise;
  await f.runStoreWriteTask(() => f.platformService.save(f.actor('admin'), 'wechat', { expectedRevision: 1, config: { minClientVersion: 2 } }, { operationId: 'isolated-config-update' }));
  finish.resolve(); await rejected;
});

test('self profile write queue rechecks mini permissionVersion before it can mutate', async t => {
  const f = await setup(t), session = await f.login(), held = gate(), entered = gate();
  const blocker = f.runStoreWriteTask(async () => { entered.resolve(); await held.promise; });
  await entered.promise;
  const call = f.command(session.token, 'profile_save', { expectedRevision: 1, displayName: 'Must not be applied', timeZone: 'Asia/Shanghai' });
  const rejected = assert.rejects(call, error('MINI_SESSION_REVOKED'));
  await new Promise(resolve => setImmediate(resolve));
  const account = f.ir.get('accounts', 'member'); f.ir.put('accounts', { ...account, permissionVersion: account.permissionVersion + 1 });
  held.resolve(); await blocker; await rejected;
  assert.equal(f.ir.get('members', 'm002').revision, 1);
  assert.notEqual(f.ir.get('members', 'm002').customName, 'Must not be applied');
});

test('stop aborts code exchange, drains promises, rejects admission and leaves shared DB open', async t => {
  const started = gate(); let f, aborted = false;
  f = await setup(t, { options: { wechat: { appId: 'host_app', readConfig: () => f.platformService.config('wechat'),
    exchangeCode: ({ signal }) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => { aborted = true; reject(new Error('isolated abort')); }, { once: true }); started.resolve(); }) } } });
  const attempt = f.host.mini.login({ code: 'stop-exchange' }), rejected = assert.rejects(attempt);
  await started.promise; await f.host.stop(); await rejected;
  assert.equal(aborted, true); assert.deepEqual(f.host.diagnostics(), { state: 'stopped', operations: 0, externalCalls: 0, timerActive: false });
  assert.equal(f.db.prepare('SELECT 1 n').get().n, 1);
  await assert.rejects(() => f.login(), error('PLATFORM_HOST_NOT_READY'));
});

test('external proof for another app is rejected without creating accounts/bindings', async t => {
  let f;
  f = await setup(t, { options: { wechat: { appId: 'host_app', readConfig: () => f.platformService.config('wechat'),
    exchangeCode: async () => ({ verified: true, appId: 'wrong_app', openid: 'openid-admin' }) } } });
  const accounts = f.ir.all('accounts'), bindings = f.ir.all('bindings');
  await assert.rejects(() => f.host.mini.login({ code: 'wrong-app-proof' }), error('MINI_AUTH_INVALID'));
  assert.deepEqual(f.ir.all('accounts'), accounts); assert.deepEqual(f.ir.all('bindings'), bindings);
});
