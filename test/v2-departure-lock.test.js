// Frozen scope-engine unit contract: this file explicitly opts into the scoped identity fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/v2-member-admin/fixtures.mjs';
import { installPlatformAdminSchema } from '../server/v2/platform-admin/repository.js';
import { createMiniProgramAdapter } from '../server/v2/platform-admin/mini-program.js';
import { reconcileMemberRoleDeparture } from '../server/v2/identity/departure-lock.js';
import { accountDTO } from '../server/v2/system-admin/identity-adapter.js';
import { errorCopy } from '../src/v2/format.js';
import { getUiLocale, setUiLocale } from '../src/v2/i18n.js';
import { PUBLIC_COPY, localizePublicError } from '../src/i18n/public-copy.js';

test('confirmed loss across all linked platforms locks web and mini access; valid role restores access', async t => {
  const f = fixture({scopeContract:true});
  t.after(() => f.db.close());
  installPlatformAdminSchema(f.db);
  const memberId = 'm002', accountId = 'member';
  for (const provider of ['kook', 'discord']) {
    f.ir.put('policies', { id: `policy_${provider}`, provider, enabled: true,
      guildId: `${provider}_guild`, allowedRoleIds: [`${provider}_role`], matchMode: 'any', policyRevision: 1 });
    f.ir.put('identities', { id: `identity_${provider}`, accountId, provider,
      externalId: `${provider}_user`, revision: 1 });
  }
  f.ir.put('identities', { id: 'identity_wechat', accountId, provider: 'wechat:fixture-app',
    externalId: 'fixture-openid', verifiedAt: '2030-09-01T00:00:00Z', revision: 1 });
  f.ir.put('wechatUsers', { id: 'wechat_member', appId: 'fixture-app', openid: 'fixture-openid',
    memberId, status: 'approved' });
  const mini = createMiniProgramAdapter({ identity: f.identity, appId: 'fixture-app',
    readConfig: () => ({ enabled: true, appId: 'fixture-app' }),
    exchangeCode: async () => ({ appId: 'fixture-app', openid: 'fixture-openid', verified: true }) });
  const initialMini = await mini.login({ code: 'initial' });
  assert.equal(initialMini.memberId, memberId);
  const initialWeb = f.identity.issueSession(f.ir.get('accounts', accountId));

  const audit = (provider, status) => f.db.prepare(`INSERT INTO json_records(collection,id,payload_json,hash,position,updated_at)
    VALUES('v2CommunityRoleAudits',?,?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET payload_json=excluded.payload_json`).run(
    `${memberId}:${provider}`, JSON.stringify({ id: `${memberId}:${provider}`, memberId, provider,
      externalId: `${provider}_user`, guildId: `${provider}_guild`, policyRevision: 1,
      matchMode: 'any', expectedRoleIds: [`${provider}_role`], actualRoleIds: [], status,
      checkedAt: '2030-09-08T10:00:00Z' }), 'fixture', 0, '2030-09-08T10:00:00Z');
  audit('kook', 'missing_role');
  f.ir.transaction(() => assert.equal(reconcileMemberRoleDeparture(f.identity, memberId).state, 'unknown'));
  audit('discord', 'check_failed');
  f.ir.transaction(() => assert.equal(reconcileMemberRoleDeparture(f.identity, memberId).state, 'unknown'));
  assert.equal(f.ir.get('accounts', accountId).roleAccessLock, undefined);

  audit('discord', 'not_in_guild');
  f.ir.transaction(() => assert.equal(reconcileMemberRoleDeparture(f.identity, memberId).state, 'locked'));
  assert.equal(f.ir.get('accounts', accountId).status, 'active');
  assert.equal(accountDTO(f.ir, f.ir.get('accounts', accountId)).roleAccessLocked, true);
  assert.equal(f.ir.get('members', memberId).memberStatus, 'active');
  assert.throws(() => f.identity.actorForAccount(accountId), /MEMBER_DEPARTED/);
  assert.throws(() => f.identity.session(initialWeb.token), /MEMBER_DEPARTED/);
  const previousLocale = getUiLocale();
  t.after(() => setUiLocale(previousLocale));
  setUiLocale('en');
  assert.equal(errorCopy({ errorCode: 'MEMBER_DEPARTED' }), PUBLIC_COPY.en.memberDeparted);
  setUiLocale('zh');
  assert.equal(errorCopy({ errorCode: 'MEMBER_DEPARTED' }), '你已离队，请联系管理获取语音频道角色');
  assert.equal(localizePublicError('memberDeparted', key => PUBLIC_COPY.zh[key] || key), '你已离队，请联系管理获取语音频道角色');
  assert.throws(() => mini.authenticate({ token: initialMini.token }), /IDENTITY_BINDING_REQUIRED/);
  const lockedMini = await mini.login({ code: 'locked' });
  assert.equal(lockedMini.memberId, null);
  assert.throws(() => mini.authenticate({ token: lockedMini.token }), /IDENTITY_BINDING_REQUIRED/);
  assert.ok(f.ir.get('wechatUsers', 'wechat_member').roleAccessLock);

  audit('kook', 'valid');
  f.ir.transaction(() => assert.equal(reconcileMemberRoleDeparture(f.identity, memberId).state, 'active'));
  assert.equal(f.ir.get('accounts', accountId).roleAccessLock, null);
  assert.equal(f.ir.get('wechatUsers', 'wechat_member').roleAccessLock, null);
  assert.equal(f.identity.actorForAccount(accountId).memberId, memberId);
  assert.equal((await mini.login({ code: 'restored' })).memberId, memberId);

  // An automatic role recovery must not silently undo an administrator's disabled state.
  f.ir.put('accounts', { ...f.ir.get('accounts', accountId), status: 'disabled' });
  audit('kook', 'missing_role');
  f.ir.transaction(() => assert.equal(reconcileMemberRoleDeparture(f.identity, memberId).state, 'locked'));
  audit('kook', 'valid');
  f.ir.transaction(() => assert.equal(reconcileMemberRoleDeparture(f.identity, memberId).state, 'active'));
  assert.equal(f.ir.get('accounts', accountId).status, 'disabled');
  assert.throws(() => f.identity.actorForAccount(accountId), /ACCOUNT_DISABLED/);
});
