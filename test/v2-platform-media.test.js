import './support/results.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fixture, upload, png, jpeg, webp, defer, delay, response, loopbackServer } from './support/v2-platform-media/fixtures.mjs';
import { validateImage, readImage } from '../server/v2/platform-media/image.js';
import { createPlatformMediaDomainAdapters, createPinnedMediaFetch, createWechatCodeExchange } from '../server/v2/platform-media/index.js';
import { publicAddress } from '../server/v2/platform-media/network.js';
import { digest } from '../server/v2/platform-media/model.js';
const setup = (t, options) => { const f = fixture(options); t.after(() => f.close()); return f; };
const reject = (fn, errorCode) => assert.rejects(async () => fn(), { errorCode });

test('factory/GET never install schema, and missing capabilities fail closed', async t => {
  const f = setup(t, { schema: false }), owner = f.owner('appA', { getAccessToken: undefined, exchangeCode: undefined });
  const before = f.db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all();
  assert.equal(owner.diagnostics().active, 0); assert.equal(f.state.writes, 0);
  assert.equal((await owner.avatarState(f.args())).revision, 0);
  await reject(() => owner.avatar(f.args(upload())), 'MEDIA_MIGRATION_REQUIRED');
  await reject(() => owner.shareCode(f.args()), 'MEDIA_SHARE_UNAVAILABLE');
  assert.deepEqual(f.db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(), before);
});

test('real PNG/JPEG/WebP validation enforces content/type/size/dimensions and rejects malformed bytes', async () => {
  const palette = await readFile(new URL('./support/v2-platform-media/images/palette.png', import.meta.url));
  assert.deepEqual(validateImage(palette).bytes, palette);
  for (const [bytes, type] of [[png, 'image/png'], [jpeg, 'image/jpeg'], [webp, 'image/webp']]) {
    const image = validateImage(bytes); assert.equal(image.contentType, type); assert.equal(image.width, 8); assert.equal(image.height, 8);
    assert.throws(() => validateImage(bytes, { maxDimension: 4 }), { errorCode: 'MEDIA_IMAGE_DIMENSION' });
    assert.throws(() => validateImage(bytes.subarray(0, bytes.length - 4)), { errorCode: 'MEDIA_IMAGE_INVALID' });
  }
  const bad = Buffer.from(png); bad[25] ^= 1;
  assert.throws(() => validateImage(bad), { errorCode: 'MEDIA_IMAGE_INVALID' });
  assert.throws(() => validateImage(Buffer.from('<svg onload=alert(1)>')), { errorCode: 'MEDIA_IMAGE_UNSUPPORTED' });
  assert.throws(() => validateImage(png, { maxBytes: 12 }), { errorCode: 'MEDIA_IMAGE_SIZE' });
  let disposed = false;
  await reject(() => readImage({ ...response(png, 'application/json'), dispose: async () => { disposed = true; } }, new AbortController().signal), 'MEDIA_IMAGE_UNSUPPORTED');
  assert.equal(disposed, true);
  await reject(() => readImage(response(jpeg, 'image/png'), new AbortController().signal), 'MEDIA_IMAGE_TYPE_MISMATCH');
  await reject(() => readImage(response(png), new AbortController().signal, { maxBytes: 12 }), 'MEDIA_IMAGE_SIZE');
});

test('self avatar atomically updates canonical wechatUsers/uploads/blob/receipt, not members or identities', async t => {
  const f = setup(t), owner = f.owner(), beforeMembers = f.repo.all('members'), beforeIdentities = f.repo.all('identities'), bindings = f.repo.all('bindings');
  const result = await owner.avatar(f.args(upload())); assert.equal(result.current.revision, 1); assert.equal(result.replayed, false);
  const user = f.repo.get('wechatUsers', 'wxuser_appA_alpha');
  assert.equal(user.avatarRevision, 1); assert.equal(user.avatarUrl, '/api/v2/platform-media/avatar-image?memberId=g05_alpha');
  assert.equal(f.state.cache.wechatUsers[0].avatarRevision, 1); assert.equal(f.state.cache.uploads[0].size, png.length);
  assert.deepEqual(f.repo.all('members'), beforeMembers); assert.deepEqual(f.repo.all('identities'), beforeIdentities); assert.deepEqual(f.repo.all('bindings'), bindings);
  const bytes = await owner.avatarImage(f.args()); assert.deepEqual(bytes.bytes, png);
  assert.equal(f.state.writes, 1);
  await reject(() => owner.avatar(f.args(upload(), 'alpha', 'appA', 'another-operation')), 'REVISION_CONFLICT');
  await reject(() => owner.avatar(f.args({ ...upload(), sha256: 'wrong' })), 'MEDIA_DIGEST_MISMATCH');
  for (const key of ['actor', 'accountId', 'memberId', 'ownerId', 'target', 'accessToken', 'page']) await reject(() => owner.avatar(f.args({ ...upload(), [key]: 'bad' })), 'MEDIA_INPUT_INVALID');
});

test('idempotency repairs failed cache from current canonical facts and never replays stale avatar', async t => {
  const f = setup(t), owner = f.owner(); f.state.cacheFailure = true;
  await reject(() => owner.avatar(f.args(upload())), 'MEDIA_CACHE_SYNC_FAILED');
  assert.equal(f.repo.get('wechatUsers', 'wxuser_appA_alpha').avatarRevision, 1);
  f.state.cacheFailure = false;
  const replay = await owner.avatar(f.args(upload())); assert.equal(replay.replayed, true);
  await owner.avatar(f.args(upload(1, jpeg, 'image/jpeg'), 'alpha', 'appA', 'second-operation'));
  const again = await owner.avatar(f.args(upload())); assert.equal(again.current.revision, 2);
  assert.equal(f.state.cache.wechatUsers[0].avatarRevision, 2);
  await reject(() => owner.avatar(f.args(upload(0, jpeg, 'image/jpeg'))), 'IDEMPOTENCY_CONFLICT');
  assert.equal(f.db.prepare('SELECT count(*) n FROM v2_platform_media').get().n, 1);
});

test('receipt failure rolls back blob, canonical avatar, upload and audit in the same transaction', async t => {
  const f = setup(t), owner = f.owner(), audits = f.repo.all('audits');
  f.db.exec("CREATE TRIGGER reject_media_receipt BEFORE INSERT ON v2_platform_media_receipts BEGIN SELECT RAISE(ABORT,'isolated receipt failure'); END");
  await reject(() => owner.avatar(f.args(upload())), 'MEDIA_UNAVAILABLE');
  assert.equal(f.repo.get('wechatUsers', 'wxuser_appA_alpha').avatarUrl, '');
  assert.equal(f.db.prepare('SELECT count(*) n FROM v2_platform_media').get().n, 0);
  assert.equal(f.db.prepare("SELECT count(*) n FROM json_records WHERE collection='uploads'").get().n, 0);
  assert.deepEqual(f.repo.all('audits'), audits); assert.equal(f.state.cacheWrites, 0);
});

test('disabled account and queued revocation prevent media writes', async t => {
  const f = setup(t), owner = f.owner(); const account = f.repo.get('accounts', 'g05_account_alpha');
  f.repo.put('accounts', { ...account, status: 'disabled' });
  await reject(() => owner.avatar(f.args(upload())), 'ACCOUNT_DISABLED');
  f.repo.put('accounts', account);
  const gate = defer(), entered = defer(); f.runStoreWriteTask(async () => { entered.resolve(); await gate.promise; }); await entered.promise;
  const pending = reject(() => owner.avatar(f.args(upload())), 'PERMISSIONS_CHANGED'); await delay(10);
  f.identity.revokeAccountScope(account.id, 'isolated revoke'); gate.resolve(); await pending;
  assert.equal(f.repo.get('wechatUsers', 'wxuser_appA_alpha').avatarRevision, undefined);
});

test('app/subject/current visible member fences prevent cross-app and foreign avatar access', async t => {
  const f = setup(t), a = f.owner(), b = f.owner('appB');
  await a.avatar(f.args(upload())); await b.avatar(f.args(upload(0, webp, 'image/webp'), 'alpha', 'appB'));
  assert.equal((await a.avatarImage(f.args())).contentType, 'image/png');
  assert.equal((await b.avatarImage(f.args({}, 'alpha', 'appB'))).contentType, 'image/webp');
  await reject(() => a.avatarImage(f.args({}, 'alpha', 'appB')), 'MEDIA_SUBJECT_INVALID');
  await reject(() => a.avatarImage(f.args({ memberId: 'g05_foreign' })), 'ACCESS_DENIED');
  await reject(() => a.avatarImage(f.args({ memberId:'g05_alpha' },'beta')), 'ACCESS_DENIED');
  const forged = f.args(); forged.subject = () => ({ verified: false, appId: 'appA', accountId: forged.actor.id, externalId: 'open_alpha' });
  await reject(() => a.avatarImage(forged), 'MEDIA_SUBJECT_INVALID');
  const original = f.repo.get('wechatUsers', 'wxuser_appA_alpha'); f.repo.put('wechatUsers', { ...original, appId: '' });
  await reject(() => a.avatarState(f.args()), 'MEDIA_SUBJECT_INVALID');
});

test('avatar proxy streams loopback substitute and rechecks source/permissions after await', async t => {
  const f = setup(t), gate = defer(), entered = defer(); let wait = false, requests = 0;
  const server = await loopbackServer(async (_req, res) => { requests++; if (wait) { entered.resolve(); await gate.promise; } res.setHeader('Content-Type', 'image/png'); res.end(png); });
  t.after(() => server.close());
  const member = f.repo.get('members', 'g05_alpha'); f.repo.put('members', { ...member, avatar: 'https://avatars.steamstatic.com/fixture.png' });
  const owner = f.owner('appA', { fetchAvatar: (url, options) => { assert.equal(url, 'https://avatars.steamstatic.com/fixture.png'); return server.fetch(server.origin + '/avatar', options); } });
  assert.deepEqual((await owner.avatarImage(f.args())).bytes, png); assert.equal(requests, 1);
  await reject(() => owner.avatarImage(f.args({ url: server.origin })), 'MEDIA_INPUT_INVALID');
  wait = true; const pending = reject(() => owner.avatarImage(f.args()), 'MEDIA_AVATAR_CHANGED'); await entered.promise;
  f.repo.put('members', { ...member, avatar: 'https://avatars.steamstatic.com/changed.png' }); gate.resolve(); await pending;
});

test('URL allowlist, redirect, DNS mixed-private/rebinding and IPv4/IPv6 rejection are enforced before request', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '100.64.0.1', '192.168.1.1', '0.0.0.0', '::1', '::ffff:8.8.8.8', 'fc00::1', 'fe80::1', '2001:db8::1', '2001:0db8::1', '2001:20::1', '2002:7f00:1::']) assert.equal(publicAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(publicAddress(address), true, address);
  let calls = 0, lookups = 0;
  const fetch = createPinnedMediaFetch({ lookup: async () => [{ address: ++lookups === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }], request: async args => {
    calls++; assert.equal(args.address.address, '8.8.8.8'); return { ...response(), status: 302, headers: new Headers({ location: 'https://avatars.steamstatic.com/two.png' }), dispose: async () => {} };
  } });
  const options = { signal: new AbortController().signal, allowedHosts: ['avatars.steamstatic.com'] };
  for (const url of ['http://avatars.steamstatic.com/a.png', 'https://avatars.steamstatic.com.evil.invalid/a.png', 'https://user@avatars.steamstatic.com/a.png', 'https://avatars.steamstatic.com:444/a.png', 'file:///etc/passwd', 'https://127.0.0.1/a']) await reject(() => fetch(url, options), 'MEDIA_URL_FORBIDDEN');
  assert.equal(calls, 0); await reject(() => fetch('https://avatars.steamstatic.com/a.png', options), 'MEDIA_ADDRESS_FORBIDDEN'); assert.equal(calls, 1);
  const mixed = createPinnedMediaFetch({ lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '::1', family: 6 }], request: async () => { throw Error('never'); } });
  await reject(() => mixed('https://avatars.steamstatic.com/a.png', options), 'MEDIA_ADDRESS_FORBIDDEN');
});

test('share tokens/page/scene are server-owned; cache is app/generation scoped and metadata is JSON only', async t => {
  const f = setup(t), a = f.owner(), b = f.owner('appB');
  const beforeChanges = f.db.prepare('SELECT total_changes() n').get().n;
  const result = await a.shareCode(f.args({ metric: 'kd' })); assert.equal(result.cached, false);
  assert.equal((await a.shareCode(f.args({ metric: 'kd' }))).cached, true); assert.equal(f.state.tokenCalls.length, 1);
  const second = await b.shareCode(f.args({ metric: 'kd' }, 'alpha', 'appB')); assert.equal(second.cached, false);
  assert.ok(f.state.exchanges[1].token.includes('appB')); assert.equal(f.state.exchanges[0].page, 'pages/rankings/index/index'); assert.equal(f.state.exchanges[0].scene, 'm=kd');
  f.configs.appA.generation++; assert.equal((await a.shareCode(f.args({ metric: 'kd' }))).cached, false);
  for (const input of [{ page: 'evil' }, { accessToken: 'evil' }, { actor: {} }, { target: 'evil' }, { metric: 'constructor' }]) await assert.rejects(async () => a.shareCode(f.args(input)));
  const adapters = createPlatformMediaDomainAdapters(a), metadata = await adapters.profile.shareCode(f.args({ metric: 'kd' }));
  assert.equal(metadata.schema, 'platform-media/1'); assert.equal(metadata.bytes, undefined); assert.equal(metadata.base64, undefined);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, beforeChanges);
  f.state.ready = false; await reject(() => a.shareCode(f.args({ metric: 'kd' })), 'MINI_SESSION_REVOKED');
});

test('bounded cache evicts/expires and token errors do not expose secret messages', async t => {
  const f = setup(t); let clock = 1000;
  const owner = f.owner('appA', { now: () => clock, cacheTtlMs: 100, maxCacheEntries: 1 });
  await owner.shareCode(f.args({ metric: 'kda' })); await owner.shareCode(f.args({ metric: 'kd' }));
  assert.equal(owner.diagnostics().cacheEntries, 1);
  assert.equal((await owner.shareCode(f.args({ metric: 'kda' }))).cached, false);
  clock += 101; assert.equal((await owner.shareCode(f.args({ metric: 'kda' }))).cached, false);
  const bad = f.owner('appA', { getAccessToken: async () => { throw Error('access_token=never-expose-this'); } });
  await assert.rejects(bad.shareCode(f.args()), e => e.errorCode === 'MEDIA_UNAVAILABLE' && !JSON.stringify(e).includes('never-expose') && !e.message.includes('never-expose'));
  const mismatched = f.owner('appA', { getAccessToken: async () => ({ appId: 'appB', generation: 1, accessToken: 'wrong-app' }) });
  await reject(() => mismatched.shareCode(f.args()), 'MEDIA_TOKEN_INVALID');
});

test('concurrent revision conflict commits once; stop after commit drains cache repair before completing', async t => {
  const f = setup(t), owner = f.owner();
  const results = await Promise.allSettled([owner.avatar(f.args(upload(), 'alpha', 'appA', 'race-one')), owner.avatar(f.args(upload(), 'alpha', 'appA', 'race-two'))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.errorCode, 'REVISION_CONFLICT');
  const entered = defer(), release = defer(); let repaired = false;
  const writing = f.owner('appA', { patchStoreCache: async apply => { entered.resolve(); await release.promise; await apply(f.state.cache); repaired = true; } });
  const pending = reject(() => writing.avatar(f.args(upload(1), 'alpha', 'appA', 'after-commit-stop')), 'MEDIA_STOPPED');
  await entered.promise; assert.equal(f.repo.get('wechatUsers', 'wxuser_appA_alpha').avatarRevision, 2);
  let stopped = false; const stopping = writing.stop().then(() => { stopped = true; }); await delay(10); assert.equal(stopped, false);
  release.resolve(); await stopping; await pending;
  assert.equal(repaired, true); assert.equal(f.state.cache.wechatUsers[0].avatarRevision, 2);
});

test('late code/token result is fenced by config generation or subject unlink; cache is not populated', async t => {
  for (const change of ['generation', 'unlink']) {
    const f = setup(t), entered = defer(), release = defer();
    const owner = f.owner('appA', { exchangeCode: async () => { entered.resolve(); await release.promise; return response(); } });
    const pending = reject(() => owner.shareCode(f.args()), change === 'generation' ? 'MEDIA_CONFIG_CHANGED' : 'MEDIA_SUBJECT_INVALID');
    await entered.promise;
    if (change === 'generation') f.configs.appA.generation++; else f.repo.remove('identities', 'wx_appA_alpha');
    release.resolve(); await pending; assert.equal(owner.diagnostics().cacheEntries, 0);
  }
});

test('share exchange fixed POST does not permit arbitrary page and rejects redirects', async () => {
  let observed;
  const exchange = createWechatCodeExchange({ fetch: async (url, options) => { observed = { url, options }; return response(); } });
  const params = { accessToken: 'isolated-secret', page: 'pages/rankings/index/index', scene: 'm=kda', width: 360, signal: new AbortController().signal, assertCurrent() {} };
  await exchange(params); assert.equal(observed.url.origin, 'https://api.weixin.qq.com'); assert.equal(observed.options.method, 'POST'); assert.equal(observed.options.maxRedirects, 0);
  assert.deepEqual(JSON.parse(observed.options.body), { page: params.page, scene: params.scene, width: 360, check_path: true, env_version: 'release', is_hyaline: false });
  await reject(() => exchange({ ...params, page: 'other/page' }), 'MEDIA_SHARE_INPUT_INVALID');
});

test('stop aborts late I/O and drains it; queued writes are fenced; shared DB and queue remain usable', async t => {
  const f = setup(t), entered = defer(), release = defer(); let aborted = false;
  const owner = f.owner('appA', { getAccessToken: async args => { entered.resolve(); args.signal.addEventListener('abort', () => { aborted = true; }); await release.promise; return { appId: 'appA', generation: 1, accessToken: 'isolated' }; } });
  const pending = reject(() => owner.shareCode(f.args()), 'MEDIA_STOPPED'); await entered.promise;
  let stopped = false; const stop = owner.stop().then(() => { stopped = true; }); assert.equal(owner.stop(), owner.stop());
  await delay(20); assert.equal(stopped, false); assert.equal(aborted, true); release.resolve(); await stop; await pending;
  assert.equal(owner.diagnostics().cacheEntries, 0); assert.equal(owner.diagnostics().active, 0);
  await reject(() => owner.shareCode(f.args()), 'MEDIA_STOPPED');
  const queued = f.owner(), gate = defer(); f.runStoreWriteTask(() => gate.promise);
  const write = reject(() => queued.avatar(f.args(upload())), 'MEDIA_STOPPED'); await delay(10); const stopQueued = queued.stop(); gate.resolve(); await stopQueued; await write;
  assert.equal(f.repo.get('wechatUsers', 'wxuser_appA_alpha').avatarRevision, undefined);
  await f.runStoreWriteTask(() => assert.equal(f.db.prepare('SELECT 1 n').get().n, 1));
});

test('deadline aborts a real loopback response body and drains the socket', async t => {
  const f = setup(t); let disconnected = false;
  const server = await loopbackServer((_req, res) => { res.setHeader('Content-Type', 'image/png'); res.write(png.subarray(0, 12)); res.once('close', () => { disconnected = true; }); });
  t.after(() => server.close());
  const owner = f.owner('appA', { timeoutMs: 80, exchangeCode: args => server.fetch(server.origin + '/slow', { signal: args.signal }) });
  await reject(() => owner.shareCode(f.args()), 'MEDIA_TIMEOUT'); await owner.stop(); await delay(10);
  assert.equal(disconnected, true); assert.equal(owner.diagnostics().active, 0);
  await writeFile(new URL('../output/test-results/g07-platform-media/lifecycle.json', import.meta.url), JSON.stringify({ realLoopbackAbort: true, socketClosed: disconnected, noSharedDbClose: f.db.prepare('SELECT 1 n').get().n === 1, remainingActive: owner.diagnostics().active, realPlatformCalls: 0 }, null, 2) + '\n');
});

test('timeout before response headers closes the owned request before settlement', async t => {
  const f = setup(t); let requestSeen = false, connectionClosed = false;
  const server = await loopbackServer((req, _res) => { requestSeen = true; req.socket.once('close', () => { connectionClosed = true; }); });
  t.after(() => server.close());
  const owner = f.owner('appA', { timeoutMs: 60, exchangeCode: args => server.fetch(server.origin + '/no-headers', { signal: args.signal }) });
  await reject(() => owner.shareCode(f.args()), 'MEDIA_TIMEOUT'); await owner.stop(); await delay(10);
  assert.equal(requestSeen, true); assert.equal(connectionClosed, true); assert.equal(owner.diagnostics().active, 0);
});
