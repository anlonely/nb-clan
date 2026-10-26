import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { fixture } from './support/v2-platform-host/fixture.mjs';
import { png, response, defer } from './support/v2-platform-media/fixtures.mjs';
import { createCommunityAvatar } from '../server/v2/management-adapters/platforms/community-avatar.js';
import { createMiniProgramRouter } from '../server/v2/platform-admin/routes.js';
import { createPinnedMediaFetch } from '../server/v2/platform-media/network.js';
import { IdentityError } from '../server/v2/identity/errors.js';

const token = 'x'.repeat(43), icon = 'https://img.kookapp.cn/icons/verified-guild.png';
function setup(t, options = {}) {
  const f = fixture(); let clock = f.now();
  f.ir.put('identities', { id: 'avatar-kook', provider: 'kook', externalId: 'kook-member', accountId: 'member', verifiedAt: new Date(clock).toISOString() });
  f.ir.put('policies', { id: 'avatar-policy', provider: 'kook', enabled: true, guildId: 'guild', policyRevision: 1 });
  const proof = { id: 'avatar-evidence', provider: 'kook', externalId: 'kook-member', guildId: 'guild', policyRevision: 1,
    status: 'eligible', checkedAt: new Date(clock).toISOString(), community: { name: 'My KOOK guild', available: true, iconUrl: icon } };
  f.ir.put('eligibility', proof);
  const calls = [];
  const authenticate = envelope => { if (envelope.token !== token) throw new IdentityError('MINI_SESSION_INVALID', 401); return { actor: f.identity.actorForAccount('member') }; };
  const owner = createCommunityAvatar({ identity: f.identity, memberSpace: f.memberSpace, authenticate, now: () => clock,
    fetchImage: async (url, input) => { calls.push({ url, input }); return response(png); }, ...options });
  t.after(async () => { await owner.stop(); await f.close(); });
  return { ...f, owner, proof, calls, tick: () => { clock += 60001; }, get: signal => owner.image({ token }, 'kook', signal) };
}

test('canonical icon bytes omit Referer, use fixed hosts with redirects disabled, cache briefly, and recheck access on cache hits', async t => {
  const f = setup(t);
  const before = f.ir.all('members');
  assert.deepEqual((await f.get()).bytes, png);
  assert.equal((await f.get()).contentType, 'image/png');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, icon);
  assert.deepEqual(f.calls[0].input.allowedHosts, ['img.kookapp.cn', 'img.kaiheila.cn']);
  assert.equal(f.calls[0].input.maxRedirects, 0);
  assert.equal(f.calls[0].input.redirect, 'error');
  assert.deepEqual(Object.keys(f.calls[0].input.headers), ['Accept']);
  assert.deepEqual(f.ir.all('members'), before);
  f.tick(); await f.get(); assert.equal(f.calls.length, 2);
  const binding = f.ir.get('bindings', 'binding-member');
  f.ir.put('bindings', { ...binding, status: 'legacy_unverified' });
  await assert.rejects(f.get(), { errorCode: 'MEMBER_VERIFICATION_REQUIRED' });
  f.ir.put('bindings', binding);
  f.ir.put('policies', { ...f.ir.get('policies', 'avatar-policy'), policyRevision: 2 });
  await assert.rejects(f.get(), { errorCode: 'COMMUNITY_AVATAR_NOT_FOUND' });
  assert.equal(f.calls.length, 2);
});

test('only the verified current user and supported provider can select an icon from current policy evidence', async t => {
  const f = setup(t);
  await assert.rejects(f.owner.image({}, 'kook'), { errorCode: 'MINI_SESSION_INVALID' });
  await assert.rejects(f.owner.image({ token }, 'discord'), { errorCode: 'COMMUNITY_AVATAR_PROVIDER_UNSUPPORTED' });
  for (const iconUrl of ['https://evil.example/icon.png', 'http://img.kookapp.cn/icon.png', 'https://user:secret@img.kookapp.cn/icon.png', 'https://img.kookapp.cn:8443/icon.png', 'https://img.kookapp.cn/icon.png#fragment']) {
    f.ir.put('eligibility', { ...f.proof, community: { ...f.proof.community, iconUrl } });
    await assert.rejects(f.get(), { errorCode: 'MEDIA_URL_FORBIDDEN' });
  }
  f.ir.put('eligibility', { ...f.proof, externalId: 'foreign-user' });
  await assert.rejects(f.get(), { errorCode: 'COMMUNITY_AVATAR_NOT_FOUND' });
  f.ir.put('eligibility', f.proof);
  f.ir.put('identities', { ...f.ir.get('identities', 'avatar-kook'), verifiedAt: null });
  await assert.rejects(f.get(), { errorCode: 'IDENTITY_BINDING_REQUIRED' });
  assert.equal(f.calls.length, 0);
});

test('same URL requests merge while a changed binding fences the result before returning bytes', async t => {
  const gate = defer(); let calls = 0;
  const f = setup(t, { fetchImage: async () => { calls++; await gate.promise; return response(png); } });
  const first = f.get(), second = f.get();
  await Promise.resolve(); assert.equal(calls, 1);
  f.ir.put('identities', { ...f.ir.get('identities', 'avatar-kook'), externalId: 'changed-user' });
  const checks = Promise.all([assert.rejects(first, { errorCode: 'COMMUNITY_AVATAR_NOT_FOUND' }), assert.rejects(second, { errorCode: 'COMMUNITY_AVATAR_NOT_FOUND' })]);
  gate.resolve(); await checks;
});

test('oversized, HTML, mismatched and redirected responses fail closed without entering the cache', async t => {
  for (const [upstream, errorCode] of [
    [{ ...response(png), status: 302 }, 'MEDIA_FETCH_FAILED'],
    [response(Buffer.from('<html>not an image</html>'), 'text/html'), 'MEDIA_IMAGE_UNSUPPORTED'],
    [response(png, 'image/jpeg'), 'MEDIA_IMAGE_TYPE_MISMATCH'],
    [{ ...response(png), headers: new Headers({ 'content-type': 'image/png', 'content-length': '1048577' }) }, 'MEDIA_IMAGE_SIZE'],
    [response(Buffer.alloc(1048577), 'image/png'), 'MEDIA_IMAGE_SIZE'],
  ]) {
    const f = setup(t, { fetchImage: async () => upstream });
    await assert.rejects(f.get(), { errorCode }); assert.equal(f.owner.diagnostics().cacheEntries, 0);
  }
});

test('deadline and shutdown abort stalled I/O; a cancelled caller does not leak bytes or cancel a shared reader', async t => {
  let upstreamSignal;
  const timed = setup(t, { timeoutMs: 50, fetchImage: async (_url, { signal }) => { upstreamSignal = signal; return new Promise(() => {}); } });
  await assert.rejects(timed.get(), { errorCode: 'MEDIA_TIMEOUT' }); assert.equal(upstreamSignal.aborted, true);
  const gate = defer(), f = setup(t, { fetchImage: async () => { await gate.promise; return response(png); } });
  const controller = new AbortController(), cancelled = f.get(controller.signal), continued = f.get();
  const assertion = assert.rejects(cancelled, { errorCode: 'MEDIA_CANCELLED' }); controller.abort(); await assertion;
  gate.resolve(); assert.deepEqual((await continued).bytes, png);
  await f.owner.stop(); await assert.rejects(f.get(), { errorCode: 'MEDIA_STOPPED' });
});

test('pinned production transport rejects private DNS and redirect targets before any second request', async () => {
  let requests = 0;
  const privateFetch = createPinnedMediaFetch({ lookup: async () => [{ address: '127.0.0.1', family: 4 }], request: async () => { requests++; return response(png); } });
  const input = { signal: new AbortController().signal, allowedHosts: ['img.kookapp.cn'], maxRedirects: 0 };
  await assert.rejects(privateFetch(icon, input), { errorCode: 'MEDIA_ADDRESS_FORBIDDEN' }); assert.equal(requests, 0);
  const redirectFetch = createPinnedMediaFetch({ lookup: async () => [{ address: '1.1.1.1', family: 4 }], request: async () => {
    requests++; return { status: 302, headers: new Headers({ location: 'http://127.0.0.1/private' }), dispose: async () => {} };
  } });
  await assert.rejects(redirectFetch(icon, input), { errorCode: 'MEDIA_REDIRECT_FORBIDDEN' }); assert.equal(requests, 1);
});

test('HTTP community avatar endpoint accepts only Bearer and no caller query URL', async t => {
  const f = setup(t), app = express(); app.use('/api/v2', createMiniProgramRouter({ adapter: { communityAvatar: f.owner } }));
  const server = createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const path = `http://127.0.0.1:${server.address().port}/api/v2/mini-program/community-avatar/kook`;
  assert.equal((await fetch(path, { headers: { cookie: 'session=browser-cookie' } })).status, 401);
  assert.equal((await fetch(path + '?url=https://evil.example', { headers: { Authorization: `Bearer ${token}` } })).status, 422);
  const result = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(result.status, 200); assert.equal(result.headers.get('content-type'), 'image/png');
  assert.equal(result.headers.get('cache-control'), 'private, no-store');
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), png);
});
