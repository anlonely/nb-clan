const test = require('node:test');
const assert = require('node:assert/strict');
const modulePath = require.resolve('../miniprogram/services/api');
const session = token => ({ token, expiresAt: new Date(Date.now() + 3600000).toISOString() });
function harness(initial = session('session-before'), handler = () => ({ data: {} })) {
  const calls = [], storage = new Map(initial ? [['nb_wechat_v2_session', initial]] : []);
  let logins = 0;
  global.wx = {
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key),
    login: options => { logins++; options.success({ code: 'verified-wechat-code' }); },
    request(options) { calls.push(options); const result = handler(options); if (result?.deferred) return; if (result?.network) options.fail({ errMsg: 'request:fail timeout' }); else options.success({ statusCode: result?.status || 200, data: result?.body || { data: result?.data }, header: {} }); }
  };
  delete require.cache[modulePath];
  return { api: require(modulePath), calls, storage, logins: () => logins };
}
test('V2 login exchanges wx code, unwraps data and sends Bearer plus idempotency key', async () => {
  const h = harness(null, options => options.url.endsWith('/login') ? { data: { ...session('new-session'), profile: { complete: true, linked: false } } } : { data: { items: [] } });
  await h.api.readCommand('member_directory', { squadId: '', limit: 40 });
  assert.equal(h.logins(), 1);
  assert.equal(h.calls[0].url, 'https://clan.example.com/api/v2/mini-program/login');
  assert.deepEqual(h.calls[0].data, { code: 'verified-wechat-code', clientVersion: 2 });
  assert.equal(h.calls[1].header.Authorization, 'Bearer new-session');
  assert.match(h.calls[1].header['Idempotency-Key'], /^mini_/);
  assert.deepEqual(h.calls[1].data, { squadId: '', limit: 40 });
  assert.ok(h.storage.has('nb_wechat_v2_session'));
});
test('concurrent identical command reads coalesce without caching stale future reads', async () => {
  const h = harness(session('token'), () => ({ deferred: true }));
  const first = h.api.readCommand('member_home');
  const second = h.api.readCommand('member_home');
  await Promise.resolve();
  assert.equal(h.calls.length, 1);
  h.calls[0].success({ statusCode: 200, data: { data: { member: { id: 'm1' } } } });
  assert.deepEqual(await first, await second);
  const third = h.api.readCommand('member_home'); await Promise.resolve();
  assert.equal(h.calls.length, 2);
  h.calls[1].success({ statusCode: 200, data: { data: { member: { id: 'm2' } } } });
  assert.equal((await third).member.id, 'm2');
});
test('401 re-authentication retains mutation idempotency key and rejects structured V2 errors', async () => {
  let attempts = 0;
  const h = harness(session('expired'), options => {
    if (options.url.endsWith('/login')) return { data: session('renewed') };
    if (++attempts === 1) return { status: 401, body: { error: { errorCode: 'MINI_SESSION_INVALID' } } };
    return { status: 409, body: { error: { errorCode: 'REVISION_CONFLICT', current: { signupRevision: 2 } } } };
  });
  await assert.rejects(h.api.command('member_home', {}, { key: 'retry-same-operation' }), error => error.statusCode === 409 && error.current.signupRevision === 2);
  assert.equal(h.calls[0].header['Idempotency-Key'], h.calls[2].header['Idempotency-Key']);
  assert.equal(h.calls[2].header.Authorization, 'Bearer renewed');
});
test('signup uses displayed versions, explicit withdrawal and no client-selected member', async () => {
  const h = harness();
  const wipe = { id: 'w1', contentRevision: 7, mySignup: { signupRevision: 3 } };
  await h.api.submitWipeSignup(wipe, null, null, 'withdraw-operation');
  assert.deepEqual(h.calls[0].data, { kind: 'direct-v2', adapterVersion: 2, wipeId: 'w1', input: { response: null, expectedArrivalAt: null, timeZone: 'Asia/Shanghai', expectedSignupRevision: 3, confirmedContentRevision: 7 } });
  assert.equal(h.calls[0].header['Idempotency-Key'], 'withdraw-operation');
  await assert.rejects(h.api.submitWipeSignup({ id: 'w1', contentRevision: 7 }, 'attending_on_time'), /刷新/);
  assert.equal(h.calls.length, 1);
});
test('link confirmation installs the rotated session before further member reads', async () => {
  const h = harness(session('before'), options => options.url.endsWith('/link/confirm') ? { data: { ...session('after'), memberId: 'member-1', profile: { complete: true, linked: true } } } : { data: { member: {} } });
  await h.api.confirmLink('link-1'); await h.api.readCommand('member_home');
  assert.deepEqual(h.calls[0].data, { linkId: 'link-1' });
  assert.equal(h.calls[1].header.Authorization, 'Bearer after');
});
test('protected avatar is downloaded with Bearer and never shown as an unauthenticated URL', async () => {
  const h = harness();
  let options;
  global.wx.downloadFile = input => { options = input; input.success({ statusCode: 200, tempFilePath: 'wxfile://avatar' }); };
  assert.equal(await h.api.avatarDisplayUrl({ avatarUrl: '/api/v2/mini-program/profile/avatar' }), 'wxfile://avatar');
  assert.equal(options.header.Authorization, 'Bearer session-before');
  assert.equal(options.url, 'https://clan.example.com/api/v2/mini-program/profile/avatar');
});
test('KOOK guild avatar uses the authenticated same-origin endpoint, local cache and no caller URL', async () => {
  const h = harness(), downloads = [];
  global.wx.downloadFile = options => { downloads.push(options); options.success({ statusCode: 200, tempFilePath: 'wxfile://kook' }); };
  const source = 'https://img.kookapp.cn/icon.png';
  assert.equal(await h.api.communityAvatarDisplayUrl('kook', source), 'wxfile://kook');
  assert.equal(await h.api.communityAvatarDisplayUrl('kook', source), 'wxfile://kook');
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].url, 'https://clan.example.com/api/v2/mini-program/community-avatar/kook');
  assert.equal(downloads[0].header.Authorization, 'Bearer session-before');
  assert.equal(await h.api.communityAvatarDisplayUrl('unknown', source), '');
  global.wx.downloadFile = options => options.success({ statusCode: 403 });
  assert.equal(await h.api.communityAvatarDisplayUrl('kook', `${source}?new`), '');
});
test('late guild image download cannot be adopted by a rotated mini session', async () => {
  const h = harness(session('before'), () => ({ data: session('after') }));
  let finish;
  global.wx.downloadFile = options => { finish = options.success; };
  const result = h.api.communityAvatarDisplayUrl('kook', 'https://img.kookapp.cn/icon.png');
  await Promise.resolve();
  await h.api.confirmLink('link-1');
  finish({ statusCode: 200, tempFilePath: 'wxfile://old-session' });
  assert.equal(await result, '');
});
test.after(() => { delete global.wx; delete require.cache[modulePath]; });
