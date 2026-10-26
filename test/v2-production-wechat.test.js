import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { fixture } from './support/v2-platform-host/fixture.mjs';
import { png } from './support/v2-platform-media/fixtures.mjs';
import { createProductionWechat, productionWechatSecretStatus } from '../server/v2/production/wechat.js';
import { createPlatformConfigReaders } from '../server/v2/management-adapters/platform-config/index.js';
import { createPlatformHost } from '../server/v2/management-adapters/platforms/index.js';
import { createPlatformMediaOwner, installPlatformMediaSchema } from '../server/v2/platform-media/index.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const code = errorCode => error => error.errorCode === errorCode;
const request = { appId: 'host_app', code: 'constructed-login-code', assertCurrent() {} };
async function setup(t) {
  const f = fixture();
  f.ir.put('accounts', { ...f.ir.get('accounts', 'admin'), roleId: 'admin', adminAssignedByOwner: true });
  await f.start(); t.after(() => f.close());
  f.ir.setScalar('settings', { ...f.ir.scalar('settings'), wechat: { appSecret: 'constructed-saved-secret' } });
  const config = patch => {
    const before = f.platformService.config('wechat');
    f.platformService.repo.put('config', 'wechat', 'wechat', '', f.now(), { ...before, ...patch });
  };
  const owner = (fetchImpl = async () => json({ openid: 'new-openid' }), env = {}, options = {}) => createProductionWechat({ identity: f.identity, env, fetchImpl, ...options });
  return { ...f, config, owner };
}

test('platform detail reports existing server credentials without exposing or persisting them', async t => {
  const f = await setup(t), env = { NB_WECHAT_SECRET: 'constructed-server-secret' };
  f.ir.setScalar('settings', {});
  f.platformService.adapters.vault = { statusSync: () => ({ ...productionWechatSecretStatus({ identity: f.identity, env }), ignoredSecret: env.NB_WECHAT_SECRET }) };
  const before = f.db.prepare('SELECT total_changes() n').get().n;
  const detail = f.platformService.detail(f.actor('admin'), 'wechat');
  assert.deepEqual(detail.secretStatus, { appSecret: true });
  assert.equal(JSON.stringify(detail).includes(env.NB_WECHAT_SECRET), false);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, before);
  assert.deepEqual(f.ir.scalar('settings'), {});
  delete env.NB_WECHAT_SECRET;
  assert.equal(f.platformService.detail(f.actor('admin'), 'wechat').secretStatus.appSecret, false);
});

test('production code exchange uses the canonical app and saved secret, returning only verified subject proof', async t => {
  const f = await setup(t), calls = [];
  const owner = f.owner(async (url, options) => {
    calls.push({ url: new URL(url), options });
    return json({ openid: 'wx_subject', session_key: 'must-not-return', unionid: 'must-not-return' });
  }, { NB_WECHAT_APPID: 'host_app', NB_WECHAT_SECRET: 'unused-env-secret', NB_WECHAT_DEV_LOGIN: '1' });
  assert.deepEqual(owner.mediaOptions, { appId: 'host_app' });
  assert.deepEqual(await owner.miniOptions.exchangeCode(request), { appId: 'host_app', openid: 'wx_subject', verified: true });
  assert.equal(calls.length, 1); assert.equal(calls[0].url.origin + calls[0].url.pathname, 'https://api.weixin.qq.com/sns/jscode2session');
  assert.equal(calls[0].url.searchParams.get('secret'), 'constructed-saved-secret');
  assert.equal(calls[0].url.searchParams.get('appid'), 'host_app');
  assert.equal(calls[0].url.searchParams.get('js_code'), request.code);
  assert.equal(calls[0].options.redirect, 'error'); assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(f.ir.all('identities').some(row => row.externalId === 'wx_subject'), false);
});

test('missing app remains unavailable until owner recreation; disabled existing app can be enabled without replacing its pin', async t => {
  const f = await setup(t); let calls = 0;
  f.config({ appId: '', enabled: false });
  const absent = f.owner(async () => { calls++; return json({ openid: 'subject' }); });
  assert.equal(absent.miniOptions, undefined); assert.equal(absent.mediaOptions, undefined);
  f.config({ appId: 'host_app', enabled: false });
  assert.equal(absent.miniOptions, undefined);
  const disabled = f.owner(async () => { calls++; return json({ openid: 'subject' }); });
  await assert.rejects(disabled.miniOptions.exchangeCode(request), code('MINI_PROGRAM_NOT_CONFIGURED')); assert.equal(calls, 0);
  f.config({ enabled: true }); assert.equal((await disabled.miniOptions.exchangeCode(request)).openid, 'subject');
  f.config({ appId: 'changed_app' });
  await assert.rejects(disabled.miniOptions.exchangeCode(request), code('PRODUCTION_WECHAT_APP_CHANGED')); assert.equal(calls, 1);
  assert.equal(f.owner().miniOptions.appId, 'changed_app');
});

test('environment app mismatch and missing credentials fail before I/O; existing secret fallbacks work', async t => {
  const f = await setup(t); let calls = 0;
  const fetchImpl = async () => { calls++; return json({ openid: 'subject' }); };
  await assert.rejects(f.owner(fetchImpl, { NB_WECHAT_APPID: 'wrong' }).miniOptions.exchangeCode(request), code('PRODUCTION_WECHAT_APP_MISMATCH'));
  f.ir.setScalar('settings', {});
  await assert.rejects(f.owner(fetchImpl, { NB_WECHAT_DEV_LOGIN: '1' }).miniOptions.exchangeCode(request), code('PRODUCTION_WECHAT_SECRET_REQUIRED'));
  assert.equal(calls, 0);
  for (const key of ['NB_WECHAT_SECRET', 'NB_WECHAT_APP_SECRET']) {
    let secret;
    const owner = f.owner(async url => { secret = new URL(url).searchParams.get('secret'); return json({ openid: 'subject' }); }, { [key]: 'fallback-secret' });
    await owner.miniOptions.exchangeCode(request); assert.equal(secret, 'fallback-secret');
  }
});

test('vendor errors, malformed or oversized replies, redirects and thrown URLs do not disclose credentials', async t => {
  const f = await setup(t);
  const replies = [
    [() => json({ errcode: 40029, errmsg: 'constructed-saved-secret' }), 'MINI_AUTH_INVALID'],
    [() => json({ errcode: -1, errmsg: 'constructed-saved-secret' }), 'WECHAT_CODE_EXCHANGE_FAILED'],
    [() => json({ openid: 'invalid subject' }), 'MINI_AUTH_INVALID'],
    [() => new Response('not-json'), 'WECHAT_CODE_EXCHANGE_FAILED'],
    [() => json({ openid: 'subject', extra: 'a'.repeat(16384) }), 'WECHAT_CODE_EXCHANGE_FAILED'],
    [() => json({}, 302), 'WECHAT_CODE_EXCHANGE_FAILED'],
    [() => { throw new Error('https://api.weixin.qq.com/?secret=constructed-saved-secret'); }, 'WECHAT_CODE_EXCHANGE_FAILED']
  ];
  for (const [reply, expected] of replies) await assert.rejects(f.owner(async () => reply()).miniOptions.exchangeCode(request), error => {
    assert.equal(error.errorCode, expected); assert.ok(!String(error.stack).includes('constructed-saved-secret')); return true;
  });
});

test('in-flight credential changes, timeout and lifecycle abort cannot produce verified proof', async t => {
  const f = await setup(t);
  const changed = f.owner(async () => {
    f.ir.setScalar('settings', { wechat: { appSecret: 'changed-secret' } });
    return json({ openid: 'subject' });
  });
  await assert.rejects(changed.miniOptions.exchangeCode(request), code('PRODUCTION_WECHAT_CREDENTIALS_CHANGED'));
  const never = f.owner(async () => new Promise(() => {}), {}, { timeoutMs: 15 });
  await assert.rejects(never.miniOptions.exchangeCode(request), code('WECHAT_CODE_EXCHANGE_CANCELLED'));
  const controller = new AbortController();
  const attempt = never.miniOptions.exchangeCode({ ...request, signal: controller.signal });
  controller.abort(); await assert.rejects(attempt, code('WECHAT_CODE_EXCHANGE_CANCELLED'));
});

test('production mini/media ports complete guest linking and serve the canonical uploaded avatar through HTTP', async t => {
  const f = await setup(t); installPlatformMediaSchema(f.db);
  f.ir.remove('identities', 'host-wx-member');
  f.ir.put('identities', { id: 'kook-member', accountId: 'member', provider: 'kook', externalId: 'kook-member', verifiedAt: new Date(f.now()).toISOString() });
  const port = f.owner(), readers = createPlatformConfigReaders({ identity: f.identity, platformService: f.platformService, appId: port.miniOptions.appId });
  const media = createPlatformMediaOwner({ ...port.mediaOptions, identity: f.identity, memberSpace: f.memberSpace, readConfig: readers.readMedia,
    runStoreWriteTask: f.runStoreWriteTask, patchStoreCache: f.patchStoreCache, now: f.now });
  const host = createPlatformHost({ ...f, media, wechat: { ...port.miniOptions, readConfig: readers.readMini } });
  await host.start();
  const app = express(), server = createServer(app); app.use('/api/v2', host.mediaRouter, host.miniRouter);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await host.stop(); await media.stop(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${origin}/api/v2/mini-program/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'real-port-shape', clientVersion: 2 }) });
  assert.equal(response.status, 200); const session = (await response.json()).data;
  assert.equal(session.memberId, null); const envelope = { token: session.token }, link = host.mini.wechatLink;
  await link.avatar(envelope, { dataUrl: `data:image/png;base64,${png.toString('base64')}` });
  await link.saveProfile(envelope, { nickName: '生产端口隔离验证' });
  const challenge = await link.createCode(envelope, {});
  await link.claim(f.actor('member'), { code: challenge.code });
  const linked = await link.confirm(envelope, { linkId: challenge.linkId });
  const url = f.ir.all('wechatUsers').find(user => user.openid === 'new-openid').avatarUrl;
  const image = await fetch(origin + url, { headers: { Authorization: `Bearer ${linked.token}` } });
  assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  assert.equal((await fetch(origin + url)).status, 401);
});

test('original environment AppID upgrades a legacy guest in place without granting membership', async t => {
  const f = await setup(t); installPlatformMediaSchema(f.db);
  const old = { id: 'original-guest', openid: 'new-openid', unionid: '', memberId: '', role: 'member', status: 'guest', nickname: '旧昵称', avatarUrl: 'https://old.invalid/avatar.png' };
  f.ir.put('wechatUsers', old);
  const before = { accounts: f.ir.all('accounts'), members: f.ir.all('members'), identities: f.ir.all('identities') };
  const port = f.owner(undefined, { NB_WECHAT_APPID: 'host_app' });
  assert.equal(port.miniOptions.legacyAppId, 'host_app');
  const host = createPlatformHost({ ...f, wechat: { ...port.miniOptions, readConfig: () => f.platformService.config('wechat') } });
  await host.start(); t.after(() => host.stop());
  const session = await host.mini.login({ code: 'original-guest-login' }), link = host.mini.wechatLink, envelope = { token: session.token };
  assert.equal(session.memberId, null); assert.equal(session.profile.complete, false); assert.equal(session.profile.avatarUrl, '');
  assert.deepEqual(f.ir.get('wechatUsers', old.id), old);
  await link.saveProfile(envelope, { nickName: '本次填写' });
  const profile = await link.avatar(envelope, { dataUrl: `data:image/png;base64,${png.toString('base64')}` });
  assert.equal(profile.complete, true); assert.equal(profile.linked, false); assert.equal(profile.memberId, null);
  assert.equal(profile.nickName, '本次填写'); assert.deepEqual(link.avatarImage(envelope).bytes, png);
  const rows = f.ir.all('wechatUsers').filter(row => row.openid === old.openid);
  assert.equal(rows.length, 1); assert.equal(rows[0].id, old.id); assert.equal(rows[0].appId, 'host_app'); assert.equal(rows[0].memberId, null);
  assert.deepEqual({ accounts: f.ir.all('accounts'), members: f.ir.all('members'), identities: f.ir.all('identities') }, before);
  assert.equal((await host.mini.login({ code: 'original-guest-login-again' })).profile.complete, true);
  assert.throws(() => host.mini.authenticate(envelope), { errorCode: 'IDENTITY_BINDING_REQUIRED' });
});
