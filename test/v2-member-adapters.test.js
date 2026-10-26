// Frozen scope-engine unit contract: this file explicitly opts into the scoped identity fake.
import './support/owner-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './support/v2-member-adapters/fixture.mjs';
import { defaultRules } from '../server/v2/member-admin/risk.js';
import { grant } from '../server/v2/identity/permissions.js';
import { OWNER_STEAM_ID } from '../server/v2/identity/permissions.js';
import { createMemberSyncAdapter } from '../server/v2/management-adapters/members/index.js';
const op = () => randomUUID();
const setup = t => { const x = fixture({scopeContract:true}); t.after(() => x.db.close()); return x; };
const rejected = (p, code) => assert.rejects(p, e => e.errorCode === code);
const edit = (x, key = op()) => x.write(() => x.service.edit(x.actor('admin'), 'm003', { expectedRevision: 1, fields: { customName: 'updated' } }, key));
function discord(x) {
  x.ir.put('members', { ...x.ir.get('members', 'm002'), discordId: 'discord-member' });
  x.ir.put('identities', { id: 'discord-identity', accountId: 'member', provider: 'discord', externalId: 'discord-member', revision: 1, verifiedAt: '2030-09-08T09:00:00Z' });
  return x.identity.issueSession(x.ir.get('accounts', 'member'));
}
const unlink = (x, key = op()) => {
  x.observations ||= new Map();
  if (!x.observations.has(key)) x.observations.set(key, x.runtime.lifecycle.observeUnlink(x.actor('admin'), 'm002', 'discord').expectedIdentityFingerprint);
  const expectedIdentityFingerprint = x.observations.get(key);
  return x.runtime.writeDomain(() => x.service.unlink(x.actor('admin'), 'm002',
    { expectedRevision: 1, provider: 'discord', reason: '隔离审核解绑', expectedIdentityFingerprint }, key), { expectedIdentityFingerprint });
};

test('unlink revokes persistent sessions/identity and contexts after commit; Steam retained; replay safe', async t => {
  const x = setup(t), session = discord(x), key = op();
  const token = x.contexts.issue({ browser: 'b', purpose: 'onboarding', provider: 'discord', profile: { id: 'discord-member' } });
  const generation = x.contextInvalidator.capture();
  await unlink(x, key);
  assert.throws(() => x.identity.session(session.token), e => e.errorCode === 'AUTH_REQUIRED');
  assert.equal(x.ir.get('identities', 'discord-identity'), null);
  assert.equal(x.ir.get('bindings', 'binding-member').status, 'verified');
  assert.equal(x.ir.get('accounts', 'member').permissionVersion, 2);
  assert.throws(() => x.contexts.read(token, { purpose: 'onboarding' }), e => e.errorCode === 'AUTH_CONTEXT_EXPIRED');
  assert.throws(() => x.contextInvalidator.assertCurrent(generation), e => e.errorCode === 'AUTH_CONTEXT_EXPIRED');
  const newToken = x.contexts.issue({ browser: 'b', purpose: 'onboarding', provider: 'discord' });
  assert.equal((await unlink(x, key)).replayed, true);
  assert.ok(x.contexts.read(newToken, { purpose: 'onboarding' }));
  assert.equal(x.ir.get('members', 'm002').revision, 2);
});

test('owner may unlink only their own Discord, KOOK or WeChat identity while Steam remains bound', async t => {
  for (const provider of ['discord', 'kook', 'wechat']) {
    const x = setup(t), member = x.ir.get('members', 'm003');
    x.ir.put('members', { ...member, steamId: OWNER_STEAM_ID,
      ...(provider === 'wechat' ? { wechatUserId: 'wx-owner', wechatId: 'wx-owner' } : { [`${provider}Id`]: `${provider}-owner` }) });
    x.ir.put('accounts', { ...x.ir.get('accounts', 'root'), memberId: 'm003' });
    x.ir.put('bindings', { id: 'binding-root', accountId: 'root', memberId: 'm003', steamId: OWNER_STEAM_ID, status: 'verified' });
    if (provider === 'wechat') x.ir.put('wechatUsers', { id: 'wx-owner', memberId: 'm003', appId: 'app-owner', openid: 'openid-owner', status: 'approved', revision: 1 });
    const identityProvider = provider === 'wechat' ? 'wechat:app-owner' : provider;
    x.ir.put('identities', { id: `${provider}-identity`, accountId: 'root', provider: identityProvider,
      externalId: provider === 'wechat' ? 'openid-owner' : `${provider}-owner`, revision: 1 });
    const actor = x.actor('root'), session = x.identity.issueSession(x.ir.get('accounts', 'root'));
    const observation = x.runtime.lifecycle.observeUnlink(actor, 'm003', provider);
    const result = await x.write(() => x.service.unlink(actor, 'm003', { ...observation, reason: '本人解绑' }, op()));
    assert.equal(result.data.revoked, true, provider);
    assert.equal(x.ir.get('identities', `${provider}-identity`), null, provider);
    assert.equal(x.ir.get('bindings', 'binding-root').status, 'verified', provider);
    assert.throws(() => x.identity.session(session.token), e => e.errorCode === 'AUTH_REQUIRED', provider);
  }
});
test('unlink rollback preserves sessions, bindings and unconsumed contexts; no events published', async t => {
  const x = setup(t), session = discord(x), original = x.runtime.adapters.unlinkIdentity;
  const token = x.contexts.issue({ browser: 'b', purpose: 'onboarding', provider: 'discord' });
  const published = []; x.identity.subscribe(e => published.push(e));
  x.runtime.adapters.unlinkIdentity = p => { original(p); throw new Error('after-revoke-failure'); };
  await assert.rejects(unlink(x));
  assert.ok(x.identity.session(session.token)); assert.ok(x.contexts.read(token, { purpose: 'onboarding' }));
  assert.equal(x.ir.get('accounts', 'member').permissionVersion, 1);
  assert.equal(x.ir.get('members', 'm002').discordId, 'discord-member');
  assert.equal(published.length, 0); assert.equal(x.events.length, 0);
});
test('unlink rejects ambiguous legacy aliases and rechecks current target revisions', async t => {
  const x = setup(t); discord(x);
  x.ir.put('members', { ...x.ir.get('members', 'm003'), discordUserId: 'discord-member' });
  await rejected(unlink(x), 'IDENTITY_CONFLICT');
  x.ir.put('members', { ...x.ir.get('members', 'm003'), discordUserId: '' });
  await unlink(x); await rejected(unlink(x), 'REVISION_CONFLICT');
});
test('same DB/transaction enforced before lifecycle writes', t => {
  const x = setup(t);
  assert.throws(() => x.runtime.lifecycle.unlinkInTransaction({ db: x.db, actor: x.actor('admin'),
    member: x.ir.get('members', 'm002'), tx: { actor: x.actor('admin') } }), e => e.errorCode === 'IDENTITY_SAME_TRANSACTION_REQUIRED');
  assert.throws(() => createMemberSyncAdapter({ identity: x.identity, syncService: { identity: {}, repo: { db: x.db } } }), e => e.errorCode === 'SYNC_IDENTITY_MISMATCH');
});
test('risk settings preserve unrelated settings and trusted root is independent of grants', async t => {
  const x = setup(t); x.ir.setScalar('settings', { brand: { name: '保留' } });
  const body = { expectedRevision: 1, rules: defaultRules(), squadFilter: '' };
  await rejected(x.write(() => x.service.saveRules(x.actor('admin'), body, op())), 'TRUSTED_ROOT_REQUIRED');
  const key = op(); await x.write(() => x.service.saveRules(x.actor('root'), body, key));
  assert.equal(x.ir.scalar('settings').brand.name, '保留'); assert.equal(x.cache.settings.accountRisk.revision, 2);
  assert.equal((await x.write(() => x.service.saveRules(x.actor('root'), body, key))).replayed, true);
});
test('queue-time permission changes reject member mutation', async t => {
  const x = setup(t), actor = x.actor('admin');
  x.queue(() => x.ir.put('accounts', { ...x.ir.get('accounts', actor.id), permissionVersion: 2, grants: [] }));
  await rejected(x.write(() => x.service.edit(actor, 'm003', { expectedRevision: 1, fields: { customName: 'updated' } }, op())), 'PERMISSIONS_CHANGED');
});
test('cache failure after commit recovers exact latest records with same operation', async t => {
  const x = setup(t), key = op(); x.cacheFailure = true;
  await assert.rejects(edit(x, key));
  const memberId = 'm003';
  x.ir.put('members', { ...x.ir.get('members', memberId), customName: '后来修改', revision: 2 });
  x.cacheFailure = false; const r = await edit(x, key);
  assert.equal(r.replayed, true); assert.equal(x.cache.members.find(m => m.id === memberId).customName, '后来修改');
});
test('supported self VIP dates preserve expiry and retired Rustinity writes stay rejected', async t => {
  const x = setup(t); discord(x); const actor = x.actor('member');
  const vip = (provider, type, version) => x.bridges.community.members.updateVip({ actor, source: 'discord', assertCurrent() {}, operationId: op(),
    input: { memberId: 'm002', provider, type, purchasedAt: '2030-09-08', expectedRevision: version } });
  await vip('vital','优先队列',1); await rejected(vip('rustintiy','免排队',2),'FIELD_NOT_WRITABLE'); await vip('atlas','queue_skip',2);
  assert.equal(x.ir.get('members', 'm002').atlasVipExpiresAt, '2030-10-06');
  await rejected(vip('rustinity','priority',3),'FIELD_NOT_WRITABLE');
  await assert.rejects(x.bridges.community.members.updateVip({ actor, source: 'discord', assertCurrent() {}, operationId: op(),
    input: { memberId: 'm001', provider: 'vital', type: 'none', expectedRevision: 1 } }), e => e.errorCode === 'ACCESS_DENIED');
  assert.throws(() => x.service.edit(actor, 'm002', { expectedRevision: 3, fields: { notes: 'not allowed' } }, op()));
});
test('realtime import uses observed revision 7, preserves source name, returns current member revision and stable replay', async t => {
  const x = setup(t), key = op(), actor = x.actor('admin'), input = { steamId: '76561198999999888', squadId: 's1', expectedRevision: 7 };
  const r = await x.realtime.command(actor, 'scope-one', 'import-member', input, key);
  assert.equal(r.memberRevision, 1); assert.equal(r.observationRevision, 7); assert.equal(r.current.displayName, '来源中的玩家');
  x.db.prepare('UPDATE v2_realtime_scopes SET revision=8 WHERE id=?').run('scope-one');
  x.advance(180000);
  assert.equal((await x.realtime.command(actor, 'scope-one', 'import-member', input, key)).replayed, true);
  await rejected(x.realtime.command(actor, 'scope-one', 'import-member', { ...input, squadId: 's2' }, key), 'IDEMPOTENCY_CONFLICT');
  assert.equal(x.queueCalls, 3);
});
test('realtime rejects stale/wrong observation, source rebinding and current permissions', async t => {
  const x = setup(t), actor = x.actor('admin'), input = { steamId: '76561198999999888', squadId: 's1', expectedRevision: 1 };
  await rejected(x.realtime.command(actor, 'scope-one', 'import-member', input, op()), 'REVISION_CONFLICT');
  input.expectedRevision = 7; x.advance(180000);
  await rejected(x.realtime.command(actor, 'scope-one', 'import-member', input, op()), 'REALTIME_OBSERVATION_EXPIRED');
  await rejected(x.realtime.members.importMember({ actor, operationId: op(), ...input,
    source: { scopeId: 'scope-one', sourceId: 'evil', serverKey: 'server-one' } }), 'REALTIME_SCOPE_CHANGED');
  assert.equal(x.ir.all('members').some(m => m.steamId === input.steamId), false);
});
test('realtime transaction rollback removes receipt, roster change and member', async t => {
  const x = setup(t), original = x.service.assign.bind(x.service);
  x.service.assign = (...args) => { original(...args); throw new Error('after-assignment-failure'); };
  await assert.rejects(x.realtime.command(x.actor('admin'), 'scope-one', 'import-member',
    { steamId: '76561198999999888', squadId: 's1', expectedRevision: 7 }, op()));
  assert.equal(x.ir.all('members').length, 65);
  assert.equal(x.db.prepare('SELECT count(*) n FROM v2_member_admin_operations').get().n, 0);
});
test('sync request/status/versioned cancel share actual SyncCenterService with exactly one queue', async t => {
  const x = setup(t), actor = x.actor('admin'), key = op(), body = { kind: 'steam', memberIds: ['m001', 'm002'] };
  const r = await x.service.sync(actor, body, key); assert.equal(r.job.status, 'queued'); assert.equal(x.queueCalls, 1);
  assert.equal((await x.service.sync(actor, body, key)).job.id, r.job.id);
  const status = await x.service.sync(actor, { ...body, jobId: r.job.id }, op(), 'status'); assert.equal(status.items.length, 2);
  await rejected(x.service.sync(actor, { ...body, jobId: r.job.id }, op(), 'cancel'), 'SYNC_EXPECTED_REVISION_REQUIRED');
  const args = { actor, scope: { accountId: actor.id, permissionVersion: 1, memberIds: body.memberIds }, db: x.db,
    kind: 'steam', jobId: r.job.id, operationId: op(), expectedRevision: status.revision };
  assert.equal((await x.runtime.adapters.sync.cancel(args)).job.status, 'cancelled');
  await rejected(Promise.resolve().then(() => x.runtime.adapters.sync.cancel({ ...args, operationId: op() })), 'REVISION_CONFLICT');
  const audit = await x.service.sync(actor, { kind: 'discordMembershipAudit', memberIds: ['m001'] }, op());
  assert.equal(audit.job.type, 'discord_membership_audit');
  assert.equal(audit.job.status, 'queued');
});
test('sync job cannot be queried/cancelled through narrower member selection; queued revoked run permission rejects', async t => {
  const x = setup(t), actor = x.actor('admin');
  const r = await x.service.sync(actor, { kind: 'steam', memberIds: ['m001', 'm002'] }, op());
  await rejected(x.service.sync(actor, { kind: 'steam', memberIds: ['m001'], jobId: r.job.id }, op(), 'status'), 'SYNC_SCOPE_MISMATCH');
  x.queue(() => x.ir.put('accounts', { ...x.ir.get('accounts', actor.id), grants: [grant('members.read', { type: 'all' })], permissionVersion: 2 }));
  await assert.rejects(x.service.sync(actor, { kind: 'steam', memberIds: ['m003'] }, op()));
});

test('WeChat unlink preserves identities of another app and sessions of another account', async t => {
  const x = setup(t), actor = x.actor('admin');
  x.ir.put('members', { ...x.ir.get('members', 'm002'), wechatUserId: 'wx-app-a', wechatId: 'wx-app-a' });
  x.ir.put('wechatUsers', { id: 'wx-app-a', memberId: 'm002', status: 'approved', appId: 'app-a', openid: 'shared-openid', revision: 1 });
  for (const [id, appId, accountId] of [['wx-a', 'app-a', 'member'], ['wx-b', 'app-b', 'member'], ['wx-c', 'app-c', 'other']]) {
    x.ir.put('identities', { id, provider: `wechat:${appId}`, externalId: 'shared-openid', accountId, revision: 1 });
  }
  const otherSession = x.identity.issueSession(x.ir.get('accounts', 'other'));
  const observation = x.runtime.lifecycle.observeUnlink(actor, 'm002', 'wechat');
  await x.bridges.mini.members.unbind({ actor, source: 'wechat', operationId: op(), assertCurrent() {},
    input: { ...observation, reason: '解绑A应用' } });
  assert.equal(x.ir.get('identities', 'wx-a'), null);
  assert.equal(x.ir.get('identities', 'wx-b').provider, 'wechat:app-b');
  assert.equal(x.ir.get('identities', 'wx-c').provider, 'wechat:app-c');
  assert.ok(x.identity.session(otherSession.token));
});
test('identity-only revision change invalidates confirmation even when member revision remains 1', async t => {
  const x = setup(t); discord(x); const actor = x.actor('admin');
  const observation = x.runtime.lifecycle.observeUnlink(actor, 'm002', 'discord');
  x.ir.put('identities', { ...x.ir.get('identities', 'discord-identity'), revision: 2 });
  await rejected(x.bridges.mini.members.unbind({ actor, source: 'wechat', operationId: op(), assertCurrent() {},
    input: { ...observation, reason: '过期确认' } }), 'IDENTITY_OBSERVATION_CHANGED');
  assert.equal(x.ir.get('members', 'm002').revision, 1);
});
test('realtime duplicate verified Steam and queue-time source/permission changes leave facts untouched', async t => {
  const x = setup(t), actor = x.actor('admin'), input = { steamId: '76561198999999888', squadId: 's1', expectedRevision: 7 };
  const member = x.ir.get('members', 'm002');
  x.db.prepare('UPDATE v2_realtime_scopes SET snapshot=?').run(JSON.stringify({ members: [{ steamId: member.steamId, displayName: '不能覆盖' }] }));
  await rejected(x.realtime.command(actor, 'scope-one', 'import-member', { ...input, steamId: member.steamId }, op()), 'MEMBER_EXISTS');
  assert.equal(x.ir.get('members', 'm002').customName, member.customName);
  assert.equal(x.ir.get('bindings', 'binding-member').status, 'verified');
  x.queue(() => x.db.prepare('UPDATE v2_realtime_scopes SET revision=8').run());
  await rejected(x.realtime.members.importMember({ actor, operationId: op(), ...input,
    source: { scopeId: 'scope-one', sourceId: 'relay-one', serverKey: 'server-one', observedAt: new Date(x.identity.now()).toISOString() } }), 'REVISION_CONFLICT');
  x.queue(() => x.ir.put('accounts', { ...x.ir.get('accounts', actor.id), grants: [], permissionVersion: 2 }));
  await rejected(x.realtime.members.importMember({ actor, operationId: op(), ...input,
    source: { scopeId: 'scope-one', sourceId: 'relay-one', serverKey: 'server-one' } }), 'PERMISSIONS_CHANGED');
  assert.equal(x.service.changes().length, 0);
});
test('durable unlink outbox replays publish failures without repeating revocation or clearing new contexts', async t => {
  const x = setup(t); discord(x); const key = op();
  x.identity.notify = () => { throw new Error('event delivery interrupted'); };
  await assert.rejects(unlink(x, key));
  assert.equal(x.ir.get('accounts', 'member').permissionVersion, 2);
  const token = x.contexts.issue({ provider: 'kook', purpose: 'oauth', browser: 'b' });
  const delivered = []; x.identity.notify = e => delivered.push(e);
  await x.runtime.replayOutbox(x.service.changes()[0]);
  assert.equal(delivered[0].reason, 'member_identity_unlinked');
  assert.equal(x.ir.get('accounts', 'member').permissionVersion, 2);
  assert.ok(x.contexts.read(token, { purpose: 'oauth' }));
});
test('VIP self exception honors explicit deny and forbids arbitrary fields', async t => {
  const x = setup(t); discord(x);
  x.ir.put('accounts', { ...x.ir.get('accounts', 'member'), grants: [{ ...grant('members.basic_edit', { type: 'self' }), effect: 'deny' }] });
  const args = { actor: x.actor('member'), source: 'discord', operationId: op(), assertCurrent() {},
    input: { memberId: 'm002', provider: 'vital', type: 'none', expectedRevision: 1 } };
  await rejected(x.bridges.community.members.updateVip(args), 'ACCESS_DENIED');
  await rejected(x.bridges.community.members.updateVip({ ...args, input: { ...args.input, notes: 'forbidden' } }), 'FIELD_NOT_WRITABLE');
  assert.equal(x.ir.get('members', 'm002').revision, 1);
});
