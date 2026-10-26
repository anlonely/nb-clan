import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { fixture } from './support/v2-platform-host/fixture.mjs';
import { installPlatformMediaSchema } from '../server/v2/platform-media/repository.js';
import { png } from './support/v2-platform-media/fixtures.mjs';
import { createIdentityRouter } from '../server/v2/identity/routes.js';

const image = { dataUrl: `data:image/png;base64,${png.toString('base64')}` };
const rejects = (fn, errorCode) => assert.rejects(async () => fn(), { errorCode });
async function setup(t, legacyWechatAppId) {
  let clock = Date.parse('2030-09-08T10:00:00Z');
  const f = fixture({ options: { now: () => clock, legacyWechatAppId } }); installPlatformMediaSchema(f.db);
  f.ir.put('accounts', { ...f.ir.get('accounts', 'admin'), roleId: 'admin', adminAssignedByOwner: true });
  for (const name of ['member','leader']) {
    f.ir.remove('identities', `host-wx-${name}`);
    f.ir.put('identities', { id: `kook-${name}`, provider: 'kook', externalId: `kook-${name}`, accountId: name, verifiedAt: new Date(clock).toISOString(), revision: 1 });
  }
  await f.start(); t.after(() => f.close());
  const link = f.host.mini.wechatLink;
  const guest = async (name = 'guest') => {
    const session = await f.login(name), envelope = { token: session.token };
    await link.avatar(envelope, image); await link.saveProfile(envelope, { nickName: `微信${name}` });
    return { session, envelope };
  };
  return { ...f, link, guest, advance: ms => { clock += ms; } };
}

test('unlinked wx.login is a guest; profile and strictly validated avatar persist, canonical membership is unchanged', async t => {
  const f = await setup(t), before = { accounts: f.ir.all('accounts'), members: f.ir.all('members'), bindings: f.ir.all('bindings') };
  const session = await f.login('new-guest'), envelope = { token: session.token };
  assert.equal(session.memberId, null); assert.equal(session.profile.linked, false); assert.equal(session.profile.complete, false);
  await rejects(() => f.command(session.token, 'member_home'), 'IDENTITY_BINDING_REQUIRED');
  await rejects(() => f.link.createCode(envelope, {}), 'WECHAT_PROFILE_REQUIRED');
  await rejects(() => f.link.saveProfile(envelope, { nickName: '昵称', accountId: 'admin' }), 'WECHAT_LINK_INPUT_INVALID');
  await rejects(() => f.link.avatar(envelope, { dataUrl: 'https://evil.invalid/avatar.png' }), 'MEDIA_IMAGE_UNSUPPORTED');
  await f.link.avatar(envelope, image); const profile = await f.link.saveProfile(envelope, { nickName: '微信昵称' });
  assert.equal(profile.complete, true); assert.equal(profile.nickName, '微信昵称'); assert.deepEqual(f.link.avatarImage(envelope).bytes, png);
  const again = await f.login('new-guest'); assert.equal(again.profile.complete, true); assert.equal(again.profile.nickName, '微信昵称');
  assert.deepEqual({ accounts: f.ir.all('accounts'), members: f.ir.all('members'), bindings: f.ir.all('bindings') }, before);
  await f.host.mini.logout(envelope); assert.throws(() => f.link.profile(envelope), { errorCode: 'MINI_SESSION_INVALID' });
});

test('unverified migrated identity enters as guest and re-verifies only its original canonical account', async t => {
  const f = await setup(t);
  f.ir.put('identities', { id: 'migrated-wechat', accountId: 'member', provider: 'wechat:host_app', externalId: 'openid-legacy', source: 'legacy_wechat', verifiedAt: null, revision: 1 });
  f.ir.setScalar('settings', { ...f.ir.scalar('settings'), wechat: { appId: 'host_app' } });
  f.ir.put('wechatUsers', { id: 'old-wechat-user', openid: 'openid-legacy', memberId: 'm002', nickname: '保留旧昵称', avatarUrl: 'https://old.invalid/avatar.png', avatarUploadId: 'legacy-avatar' });
  const session = await f.login('legacy'), envelope = { token: session.token };
  assert.equal(session.memberId, null); assert.equal(session.profile.linked, false); assert.equal(session.profile.nickName, '保留旧昵称');
  assert.equal(session.profile.complete, false); assert.equal(session.profile.avatarUrl, '');
  assert.throws(() => f.host.mini.authenticate(envelope), { errorCode: 'IDENTITY_BINDING_REQUIRED' });
  await f.link.avatar(envelope, image); const code = await f.link.createCode(envelope, {});
  await rejects(() => f.link.claim(f.actor('leader'), { code: code.code }), 'WECHAT_LINK_WECHAT_CONFLICT');
  await f.link.claim(f.actor('member'), { code: code.code });
  const result = await f.link.confirm(envelope, { linkId: code.linkId });
  assert.equal(result.memberId, 'm002'); assert.equal(result.profile.nickName, '保留旧昵称');
  assert.equal(f.ir.all('wechatUsers').filter(user => user.openid === 'openid-legacy').length, 1);
  assert.equal(f.ir.get('wechatUsers', 'old-wechat-user').appId, 'host_app');
  assert.equal(f.identity.identity('wechat:host_app', 'openid-legacy').id, 'migrated-wechat');
  assert.ok(Number.isFinite(Date.parse(f.identity.identity('wechat:host_app', 'openid-legacy').verifiedAt)));
  assert.equal((await f.login('legacy')).profile.linked, true);
});

test('QR can re-verify an old unverified mapping but cannot substitute its WeChat subject', async t => {
  const f = await setup(t);
  f.ir.put('identities', { id: 'migrated-wechat', accountId: 'member', provider: 'wechat:host_app', externalId: 'openid-legacy', source: 'legacy_wechat', verifiedAt: 'invalid', revision: 1 });
  const login = await f.login('legacy'); assert.equal(login.profile.linked, false);
  const original = { token: login.token }; await f.link.avatar(original, image); await f.link.saveProfile(original, { nickName: '重新填写' });
  const wrong = await f.guest('wrong'), qr = await f.link.createQr(f.actor('member'), {});
  await rejects(() => f.link.scan(wrong.envelope, { token: qr.qrPayload }), 'WECHAT_LINK_ACCOUNT_CONFLICT');
  const scan = await f.link.scan(original, { token: qr.qrPayload }); assert.equal(scan.status, 'awaiting_confirmation');
  const result = await f.link.confirm(original, { linkId: qr.linkId }); assert.equal(result.profile.linked, true);
});

test('unscoped legacy profiles without matching app pin are never imported or overwritten', async t => {
  const f = await setup(t);
  f.ir.put('identities', { id: 'migrated-wechat', accountId: 'member', provider: 'wechat:host_app', externalId: 'openid-legacy', source: 'legacy_wechat', verifiedAt: null, revision: 1 });
  f.ir.setScalar('settings', { ...f.ir.scalar('settings'), wechat: { appId: 'different_app' } });
  const old = { id: 'foreign-unscoped', openid: 'openid-legacy', memberId: 'm002', nickname: '不能导入', avatarUrl: 'https://old.invalid/avatar.png' };
  f.ir.put('wechatUsers', old);
  const login = await f.login('legacy'); assert.equal(login.profile.nickName, ''); assert.equal(login.profile.linked, false);
  await rejects(() => f.link.avatar({ token: login.token }, image), 'WECHAT_PROFILE_APP_CONFLICT');
  await rejects(() => f.link.saveProfile({ token: login.token }, { nickName: '重新填写' }), 'WECHAT_PROFILE_APP_CONFLICT');
  assert.deepEqual(f.ir.get('wechatUsers', 'foreign-unscoped'), old);
});

test('legacy guest compatibility does not adopt ambiguous scope or existing account relationships', async t => {
  const cases = [
    ['missing server pin', { wechat: { appId: 'host_app' } }, {}, null, ''],
    ['mismatched server pin', { wechat: { appId: 'host_app' } }, {}, null, 'different_app'],
    ['mismatched app pin', { wechat: { appId: 'other_app' } }, {}],
    ['conflicting app pins', { wechat: { appId: 'host_app' }, wechatMini: { appId: 'other_app' } }, {}],
    ['explicit foreign app', { wechat: { appId: 'host_app' } }, { appId: 'other_app' }],
    ['member relationship', { wechat: { appId: 'host_app' } }, { memberId: 'm002' }],
    ['union identity', { wechat: { appId: 'host_app' } }, { unionid: 'existing-union' }],
    ['legacy admin role', { wechat: { appId: 'host_app' } }, { role: 'admin' }],
    ['account reference', { wechat: { appId: 'host_app' } }, {}, f => f.ir.put('accounts', { ...f.ir.get('accounts', 'member'), wechatUserId: 'legacy-guest' })],
    ['other app identity', { wechat: { appId: 'host_app' } }, {}, f => f.ir.put('identities', { id: 'foreign-wx', provider: 'wechat:other_app', externalId: 'openid-legacy', accountId: 'member', verifiedAt: null })]
  ];
  for (const [name, settings, extra, prepare, serverPin = 'host_app'] of cases) await t.test(name, async t => {
    const f = await setup(t, serverPin);
    const old = { id: 'legacy-guest', openid: 'openid-legacy', memberId: '', unionid: '', role: 'member', status: 'guest', nickname: '旧资料', ...extra };
    f.ir.setScalar('settings', settings); f.ir.put('wechatUsers', old); prepare?.(f);
    const session = await f.login('legacy'), envelope = { token: session.token };
    assert.equal(session.profile.nickName, ''); assert.equal(session.memberId, null);
    await rejects(() => f.link.saveProfile(envelope, { nickName: '新资料' }), 'WECHAT_PROFILE_APP_CONFLICT');
    await rejects(() => f.link.avatar(envelope, image), 'WECHAT_PROFILE_APP_CONFLICT');
    assert.deepEqual(f.ir.get('wechatUsers', old.id), old);
    assert.equal(f.ir.all('wechatUsers').filter(row => row.openid === old.openid).length, 1);
  });
});

test('link preparation and confirmation require the exact verified Steam member binding', async t => {
  const f = await setup(t), guest = await f.guest(), member = f.ir.get('members', 'm002'), actor = f.actor('member');
  const code = await f.link.createCode(guest.envelope, {});
  const mismatch = () => f.ir.put('members', { ...member, steamId: '76561198999999999' });
  mismatch();
  await rejects(() => f.link.claim(actor, { code: code.code }), 'IDENTITY_CONFLICT');
  await rejects(() => f.link.createQr(actor, {}), 'IDENTITY_CONFLICT');
  f.ir.put('members', member);
  await f.link.claim(f.actor('member'), { code: code.code });
  mismatch();
  await rejects(() => f.link.confirm(guest.envelope, { linkId: code.linkId }), 'IDENTITY_CONFLICT');
  assert.equal(Boolean(f.identity.identity('wechat:host_app', 'openid-guest')), false);
});

test('short code is hashed, cannot be claimed twice, requires originating mini confirmation, and rotates all guest sessions', async t => {
  const f = await setup(t), guest = await f.guest(), secondSession = await f.login('guest'), another = await f.guest('other-guest');
  const code = await f.link.createCode(guest.envelope, {}); assert.match(code.code, /^\d{8}$/);
  const stored = f.db.prepare("SELECT payload FROM platform_admin_records WHERE kind='wechat-link'").get().payload;
  assert.equal(stored.includes(code.code), false); assert.equal(f.identity.identity('wechat:host_app', 'openid-guest'), undefined);
  const claim = await f.link.claim(f.actor('member'), { code: code.code });
  assert.equal(claim.status, 'awaiting_confirmation'); assert.equal(claim.target.kookId, 'kook-member');
  assert.equal(f.identity.identity('wechat:host_app', 'openid-guest'), undefined);
  await rejects(() => f.link.claim(f.actor('leader'), { code: code.code }), 'WECHAT_LINK_CLAIMED');
  assert.throws(() => f.link.miniStatus(another.envelope, code.linkId), { errorCode: 'WECHAT_LINK_NOT_FOUND' });
  await rejects(() => f.link.confirm(another.envelope, { linkId: code.linkId }), 'WECHAT_LINK_NOT_FOUND');
  const result = await f.link.confirm(guest.envelope, { linkId: code.linkId });
  assert.notEqual(result.token, guest.session.token); assert.equal(result.memberId, 'm002'); assert.equal(result.profile.linked, true);
  assert.equal(f.identity.identity('wechat:host_app', 'openid-guest').accountId, 'member');
  assert.equal(f.ir.all('wechatUsers').find(u => u.openid === 'openid-guest').memberId, 'm002');
  assert.throws(() => f.link.profile(guest.envelope), { errorCode: 'MINI_SESSION_INVALID' });
  assert.throws(() => f.link.profile({ token: secondSession.token }), { errorCode: 'MINI_SESSION_INVALID' });
  assert.equal(f.link.webStatus(f.actor('member'), code.linkId).status, 'linked');
  await rejects(() => f.link.confirm({ token: result.token }, { linkId: code.linkId }), 'WECHAT_LINK_NOT_READY');
});

test('website QR is a hashed single-use challenge, reveals target only after scanning, and expires after five minutes', async t => {
  const f = await setup(t), a = await f.guest('a'), b = await f.guest('b');
  const qr = await f.link.createQr(f.actor('member'), {}); assert.match(qr.qrPayload, /^nbclan:wechat-link:[A-Za-z0-9_-]{43}$/);
  const stored = f.db.prepare("SELECT payload FROM platform_admin_records WHERE kind='wechat-link'").get().payload;
  assert.equal(stored.includes(qr.qrPayload.slice(19)), false);
  const scan = await f.link.scan(a.envelope, { token: qr.qrPayload }); assert.equal(scan.target.kookId, 'kook-member');
  await rejects(() => f.link.scan(b.envelope, { token: qr.qrPayload }), 'WECHAT_LINK_CLAIMED');
  assert.throws(() => f.link.webStatus(f.actor('leader'), qr.linkId), { errorCode: 'WECHAT_LINK_NOT_FOUND' });
  assert.deepEqual(f.link.webAvatar(f.actor('member'), qr.linkId).bytes, png);
  f.advance(300001); await rejects(() => f.link.confirm(a.envelope, { linkId: qr.linkId }), 'WECHAT_LINK_EXPIRED');
  assert.equal(f.identity.identity('wechat:host_app', 'openid-a'), undefined);
});

test('binding refuses occupied accounts, reassigned WeChat subjects and account changes after website claim', async t => {
  const f = await setup(t), a = await f.guest('a'), b = await f.guest('b');
  const codeA = await f.link.createCode(a.envelope, {}), codeB = await f.link.createCode(b.envelope, {});
  await f.link.claim(f.actor('member'), { code: codeA.code });
  const account = f.ir.get('accounts', 'member'); f.ir.put('accounts', { ...account, permissionVersion: account.permissionVersion + 1 });
  await rejects(() => f.link.confirm(a.envelope, { linkId: codeA.linkId }), 'WECHAT_LINK_ACCOUNT_CHANGED');
  await f.link.claim(f.actor('member'), { code: codeA.code }); await f.link.confirm(a.envelope, { linkId: codeA.linkId });
  await rejects(() => f.link.claim(f.actor('member'), { code: codeB.code }), 'WECHAT_LINK_ACCOUNT_CONFLICT');
  await rejects(() => f.link.createQr(f.actor('member'), {}), 'WECHAT_LINK_ACCOUNT_CONFLICT');
  f.ir.put('identities', { id: 'wx-race', provider: 'wechat:host_app', externalId: 'openid-b', accountId: 'leader', verifiedAt: new Date(f.now()).toISOString(), revision: 1 });
  await rejects(() => f.link.claim(f.actor('member'), { code: codeB.code }), 'WECHAT_LINK_WECHAT_CONFLICT');
});

test('claim attempts are persisted and rate limited; refreshing a short code retires its predecessor', async t => {
  const f = await setup(t), a = await f.guest();
  const first = await f.link.createCode(a.envelope, {}), second = await f.link.createCode(a.envelope, {});
  await rejects(() => f.link.claim(f.actor('member'), { code: first.code }), 'WECHAT_LINK_EXPIRED');
  for (let i = 0; i < 9; i++) await rejects(() => f.link.claim(f.actor('member'), { code: 'invalid' }), 'WECHAT_LINK_CODE_INVALID');
  await rejects(() => f.link.claim(f.actor('member'), { code: second.code }), 'WECHAT_LINK_RATE_LIMITED');
});

test('configuration changes fence outstanding challenges and transaction failure cannot partially bind', async t => {
  const f = await setup(t), a = await f.guest();
  const code = await f.link.createCode(a.envelope, {}); await f.link.claim(f.actor('member'), { code: code.code });
  f.db.exec("CREATE TRIGGER reject_link BEFORE INSERT ON json_records WHEN NEW.collection='v2Identities' AND json_extract(NEW.payload_json,'$.provider')='wechat:host_app' BEGIN SELECT RAISE(ABORT,'isolated write failure'); END");
  await assert.rejects(() => f.link.confirm(a.envelope, { linkId: code.linkId }));
  assert.equal(f.link.profile(a.envelope).linked, false);
  assert.equal(f.link.webStatus(f.actor('member'), code.linkId).status, 'awaiting_confirmation');
  assert.equal(f.ir.all('wechatUsers').find(u => u.openid === 'openid-guest').memberId, null);
  f.db.exec('DROP TRIGGER reject_link');
  await f.runStoreWriteTask(() => f.platformService.save(f.actor('admin'), 'wechat', { expectedRevision: 1, config: { minClientVersion: 2 } }, { operationId: 'fence-link-config' }));
  await rejects(() => f.link.confirm(a.envelope, { linkId: code.linkId }), 'WECHAT_LINK_CONFIG_CHANGED');
  assert.equal(f.identity.identity('wechat:host_app', 'openid-guest'), undefined);
});

test('HTTP enforces website cookie+CSRF+origin, mini Bearer isolation, and retired management endpoints', async t => {
  const f = await setup(t), app = express(), server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, auth = createIdentityRouter({ service: f.identity, origin, providers: {} });
  t.after(async () => { await auth.stopEvents(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  app.use('/api/v2', f.host.miniRouter); app.use('/api', f.host.legacyRouter);
  app.use('/api/v2', (req,res,next) => { req.v2Identity = { service: f.identity, authenticate: options => auth.authenticate(options)(req) }; next(); }, auth, f.host.wechatLinkRouter);
  f.ir.put('policies', { id: 'link-kook', provider: 'kook', guildId: 'kook-guild', enabled: true, allowedRoleIds: ['member-role'], policyRevision: 1 });
  const evidence = { id: 'member-evidence', provider: 'kook', externalId: 'kook-member', status: 'eligible', policyRevision: 1, expiresAt: new Date(f.now()+3600000).toISOString() };
  f.ir.put('eligibility', evidence); const browser = f.identity.issueSession(f.ir.get('accounts','member'), evidence);
  const guest = await f.guest(), code = await f.link.createCode(guest.envelope, {});
  const call = async (path, { method='GET', body, headers={} }={}) => {
    const response = await fetch(origin+path,{method,headers:{...(body ? {'Content-Type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
    return { status:response.status, body:await response.json() };
  };
  const web = { Cookie:`nb_v2_session=${browser.token}`,Origin:origin,'X-CSRF-Token':browser.csrfToken }, mini = { Authorization:`Bearer ${guest.session.token}` };
  assert.equal((await call('/api/v2/wechat-link/claim',{method:'POST',body:{code:code.code},headers:{...mini,Origin:origin}})).status,401);
  assert.equal((await call('/api/v2/wechat-link/claim',{method:'POST',body:{code:code.code},headers:{...web,'X-CSRF-Token':''}})).status,403);
  assert.equal((await call('/api/v2/wechat-link/claim',{method:'POST',body:{code:code.code},headers:{...web,Origin:'https://evil.invalid'}})).status,403);
  const claimed=await call('/api/v2/wechat-link/claim',{method:'POST',body:{code:code.code},headers:web}); assert.equal(claimed.status,200,JSON.stringify(claimed));
  assert.equal((await call('/api/v2/mini-program/profile',{headers:web})).status,401);
  assert.equal((await call('/api/v2/mini-program/profile',{headers:mini})).status,200);
  for (const path of ['/api/wechat/admin/summary','/api/wechat/join-applications/me']) assert.equal((await call(path)).status,410);
  const retired=await call('/api/v2/mini-program/commands/wipe_create',{method:'POST',body:{},headers:mini}); assert.equal(retired.status,410);
});

test('mini profile distinguishes a verified KOOK identity from a website-only association', async t => {
  const f = await setup(t);
  f.ir.put('identities', { id: 'wx-kook-display-test', provider: 'wechat:host_app', externalId: 'openid-member', accountId: 'member', verifiedAt: new Date(f.now()).toISOString(), revision: 1 });
  const session = await f.login('member');
  const envelope = { token: session.token };
  assert.equal(f.link.profile(envelope).linked, true);
  assert.equal(f.link.profile(envelope).kookLinked, true);
  f.ir.put('identities', { ...f.ir.get('identities', 'kook-member'), verifiedAt: null });
  assert.equal(f.link.profile(envelope).kookLinked, false);
  f.ir.remove('identities', 'kook-member');
  assert.equal(f.link.profile(envelope).kookLinked, false);
});
