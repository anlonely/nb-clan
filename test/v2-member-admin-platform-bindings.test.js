// Frozen scope-engine unit contract: fixtures explicitly opt into the scoped identity fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/v2-member-admin/fixtures.mjs';
import { randomUUID } from 'node:crypto';
import { IdentityMemberLifecycle } from '../server/v2/management-adapters/members/lifecycle.js';

test('member detail distinguishes verified platform identities from saved profile fields', t => {
  const f = fixture({scopeContract:true});
  t.after(() => f.db.close());
  const admin = f.ir.get('accounts', 'admin');
  f.ir.put('accounts', { ...admin, roleId: 'admin', adminAssignedByOwner: true });
  const member = f.ir.get('members', 'm001');
  f.ir.put('members', { ...member, discordId: 'discord-1', discordName: 'Discord 名称',
    kookId: 'kook-1', kookName: 'KOOK 名称', wechatId: 'wechat-record' });

  const before = f.service.detail(f.actor('admin'), 'm001').platformBindings;
  assert.deepEqual(before.map(binding => binding.status), ['record_only', 'record_only', 'record_only']);
  assert.deepEqual(before.map(binding => binding.canUnlink), [true, true, true]);

  f.ir.put('wechatUsers', { id: 'wechat-record', memberId: 'm001', appId: 'wx-app',
    openid: 'wechat-openid', nickname: '微信昵称', status: 'approved' });
  const withWechatRecord = f.service.detail(f.actor('admin'), 'm001').platformBindings[2];
  assert.equal(withWechatRecord.status, 'historical');
  assert.equal(withWechatRecord.canUnlink, true);

  f.ir.put('identities', { id: 'discord-identity', accountId: 'leader', provider: 'discord',
    externalId: 'discord-1', verifiedAt: '2030-09-08T09:00:00Z' });
  f.ir.put('identities', { id: 'kook-identity', accountId: 'leader', provider: 'kook',
    externalId: 'kook-1', verifiedAt: null, source: 'legacy_alias' });
  f.ir.put('identities', { id: 'wechat-identity', accountId: 'leader', provider: 'wechat',
    externalId: 'wechat-linked', verifiedAt: '2030-09-08T09:00:00Z' });

  const bindings = f.service.detail(f.actor('admin'), 'm001').platformBindings;
  assert.deepEqual(bindings.map(binding => binding.status), ['verified', 'historical', 'verified']);
  assert.equal(bindings[0].displayName, 'Discord 名称');
  assert.equal(bindings[1].displayName, 'KOOK 名称');
  assert.equal(bindings[2].externalId, 'wechat-linked');
  assert.equal(bindings[2].displayName, '微信昵称');
  assert.equal(f.service.detail(f.actor('member'), 'm002').platformBindings, undefined);
});

test('legacy WeChat profile alias can be unlinked without an app identity', t => {
  const f = fixture({scopeContract:true});
  t.after(() => f.db.close());
  f.ir.put('accounts', { ...f.ir.get('accounts', 'admin'), roleId: 'admin', adminAssignedByOwner: true });
  const member = f.ir.get('members', 'm001');
  f.ir.put('members', { ...member, wechatId: 'legacy-wechat-id' });
  const actor = f.actor('admin');
  const lifecycle = new IdentityMemberLifecycle({ identity: f.identity,
    contexts: { assertReady: () => true, invalidate: () => {} } });
  f.service.adapters.unlinkIdentity = args => lifecycle.unlinkInTransaction(args);
  const observation = lifecycle.observeUnlink(actor, member.id, 'wechat');
  const result = f.service.unlink(actor, member.id, { ...observation, provider: 'wechat' }, randomUUID());
  assert.equal(result.data.revoked, true);
  assert.equal(f.ir.get('members', member.id).wechatId, '');
  assert.equal(f.service.detail(f.actor('admin'), member.id).platformBindings[2].status, 'unlinked');
});

test('legacy WeChat alias unlink refuses a record owned by another member', t => {
  const f = fixture({scopeContract:true});
  t.after(() => f.db.close());
  f.ir.put('accounts', { ...f.ir.get('accounts', 'admin'), roleId: 'admin', adminAssignedByOwner: true });
  const member = f.ir.get('members', 'm001');
  f.ir.put('members', { ...member, wechatId: 'other-member-wechat' });
  f.ir.put('wechatUsers', { id: 'other-member-wechat', memberId: 'm002', appId: 'other-app',
    openid: 'other-openid', status: 'approved' });
  const actor = f.actor('admin');
  const lifecycle = new IdentityMemberLifecycle({ identity: f.identity,
    contexts: { assertReady: () => true, invalidate: () => {} } });
  f.service.adapters.unlinkIdentity = args => lifecycle.unlinkInTransaction(args);
  const observation = lifecycle.observeUnlink(actor, member.id, 'wechat');
  assert.throws(() => f.service.unlink(actor, member.id, { ...observation, provider: 'wechat' }, randomUUID()),
    { errorCode: 'IDENTITY_CONFLICT' });
  assert.equal(f.ir.get('members', member.id).wechatId, 'other-member-wechat');
  assert.equal(f.ir.get('wechatUsers', 'other-member-wechat').memberId, 'm002');
});

test('legacy WeChat alias unlink refuses conflicting saved IDs', t => {
  const f = fixture({scopeContract:true});
  t.after(() => f.db.close());
  f.ir.put('accounts', { ...f.ir.get('accounts', 'admin'), roleId: 'admin', adminAssignedByOwner: true });
  const member = f.ir.get('members', 'm001');
  f.ir.put('members', { ...member, wechatId: 'first-id', wechatUserId: 'second-id' });
  const actor = f.actor('admin');
  const lifecycle = new IdentityMemberLifecycle({ identity: f.identity,
    contexts: { assertReady: () => true, invalidate: () => {} } });
  f.service.adapters.unlinkIdentity = args => lifecycle.unlinkInTransaction(args);
  const observation = lifecycle.observeUnlink(actor, member.id, 'wechat');
  assert.throws(() => f.service.unlink(actor, member.id, { ...observation, provider: 'wechat' }, randomUUID()),
    { errorCode: 'IDENTITY_CONFLICT' });
  assert.equal(f.ir.get('members', member.id).wechatId, 'first-id');
});

test('legacy user WeChat ID shown in profile can be unlinked without a WeChat record', t => {
  const f = fixture({scopeContract:true});
  t.after(() => f.db.close());
  f.ir.put('accounts', { ...f.ir.get('accounts', 'admin'), roleId: 'admin', adminAssignedByOwner: true });
  const member = f.ir.get('members', 'm001');
  f.ir.put('users', { id: 'legacy-leader', boundSteamId: member.steamId,
    wechatUserId: 'legacy-user-wechat', revision: 1 });
  f.ir.put('accounts', { ...f.ir.get('accounts', 'leader'), legacyUserId: 'legacy-leader' });
  const actor = f.actor('admin');
  const before = f.service.detail(actor, member.id).platformBindings[2];
  assert.equal(before.recordedId, 'legacy-user-wechat');
  assert.equal(before.canUnlink, true);
  const lifecycle = new IdentityMemberLifecycle({ identity: f.identity,
    contexts: { assertReady: () => true, invalidate: () => {} } });
  f.service.adapters.unlinkIdentity = args => lifecycle.unlinkInTransaction(args);
  const observation = lifecycle.observeUnlink(actor, member.id, 'wechat');
  const result = f.service.unlink(actor, member.id, { ...observation, provider: 'wechat' }, randomUUID());
  assert.equal(result.data.revoked, true);
  assert.equal(f.ir.get('users', 'legacy-leader').wechatUserId, '');
  assert.equal(f.service.detail(f.actor('admin'), member.id).platformBindings[2].status, 'unlinked');
});

test('legacy WeChat ID cannot bypass a live app identity without a matching record', t => {
  const f = fixture({scopeContract:true});
  t.after(() => f.db.close());
  f.ir.put('accounts', { ...f.ir.get('accounts', 'admin'), roleId: 'admin', adminAssignedByOwner: true });
  const member = f.ir.get('members', 'm001');
  f.ir.put('members', { ...member, wechatId: 'legacy-id' });
  f.ir.put('identities', { id: 'app-identity', accountId: 'leader', provider: 'wechat:real-app',
    externalId: 'real-openid', verifiedAt: '2030-09-08T09:00:00Z', revision: 1 });
  const actor = f.actor('admin');
  const lifecycle = new IdentityMemberLifecycle({ identity: f.identity,
    contexts: { assertReady: () => true, invalidate: () => {} } });
  f.service.adapters.unlinkIdentity = args => lifecycle.unlinkInTransaction(args);
  const observation = lifecycle.observeUnlink(actor, member.id, 'wechat');
  assert.throws(() => f.service.unlink(actor, member.id, { ...observation, provider: 'wechat' }, randomUUID()),
    { errorCode: 'WECHAT_APP_SCOPE_REQUIRED' });
  assert.equal(f.ir.get('members', member.id).wechatId, 'legacy-id');
  assert.ok(f.ir.get('identities', 'app-identity'));
});
