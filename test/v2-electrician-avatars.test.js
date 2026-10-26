import test from 'node:test';
import assert from 'node:assert/strict';
import { createElectricianAvatars, steamAvatarUrl } from '../server/v2/platform-admin/electrician-avatars.js';

const steamId = '76561198000000001', avatar = `https://avatars.cloudflare.steamstatic.com/${'a'.repeat(40)}_full.jpg`;
const rows = { china: [{ name: 'Configured member', url: `https://steamcommunity.com/profiles/${steamId}/` }],
  foreign: [{ name: 'Goshawox', url: 'https://steamcommunity.com/id/goshawox/' }] };
const xml = (id = steamId, image = avatar) => `<profile><steamID64>${id}</steamID64><avatarFull><![CDATA[${image}]]></avatarFull></profile>`;

test('fixed Steam XML supports numeric and vanity profiles, coalesces callers, and caches successes', async t => {
  const calls = []; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const service = createElectricianAvatars({ fetchImpl: async (url, options) => {
    calls.push(url); assert.equal(options.redirect, 'error'); assert.equal(options.headers.authorization, undefined);
    await gate; return new Response(xml());
  } }); t.after(() => service.stop());
  const requests = Array.from({ length: 15 }, () => service.read(rows));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.sort(), [...rows.china, ...rows.foreign].map(row => `${row.url}?xml=1`).sort());
  release(); const results = await Promise.all(requests);
  for (const result of results) for (const row of [...result.china, ...result.foreign]) assert.equal(row.avatar, avatar);
  await service.read(rows); assert.equal(calls.length, 2);
});

test('failed refresh retains the last good avatar and imposes failure cooldown', async t => {
  let at = 100, calls = 0, fail = false;
  const service = createElectricianAvatars({ now: () => at, ttlMs: 50, failureTtlMs: 10,
    fetchImpl: async () => { calls++; if (fail) throw new Error('private transport details'); return new Response(xml()); } });
  t.after(() => service.stop()); const details = { china: rows.china, foreign: [] };
  assert.equal((await service.read(details)).china[0].avatar, avatar);
  at = 151; fail = true;
  assert.equal((await service.read(details)).china[0].avatar, avatar); assert.equal(calls, 2);
  at = 155; await service.read(details); assert.equal(calls, 2);
  at = 162; await service.read(details); assert.equal(calls, 3);
});

test('unknown profiles have negative caching and only fixed Steam paths can be fetched', async t => {
  let calls = 0;
  const service = createElectricianAvatars({ fetchImpl: async () => { calls++; return new Response(xml('76561198000000999')); } });
  t.after(() => service.stop());
  const details = { china: rows.china, foreign: ['https://elsewhere.example/id/x/', 'https://steamcommunity.com/profiles/123/',
    'https://steamcommunity.com/id/goshawox/?url=http://127.0.0.1/', 'https://user:password@steamcommunity.com/id/goshawox/']
    .map(url => ({ name: 'unsafe', url })) };
  for (let n = 0; n < 2; n++) for (const row of Object.values(await service.read(details)).flat()) assert.equal(row.avatar, '');
  assert.equal(calls, 1);
  for (const value of ['https://evil.example/avatar.jpg', avatar.replace('https:', 'http:'), `${avatar}?token=private`,
    avatar.replace('avatars.cloudflare.steamstatic.com', 'avatars.cloudflare.steamstatic.com.evil.example'),
    'https://avatars.steamstatic.com/not-an-avatar.jpg']) assert.equal(steamAvatarUrl(value), '');
});

test('oversized and redirected XML bodies are cancelled and never produce avatars', async t => {
  for (const kind of ['oversize', 'redirect']) {
    let cancelled = 0;
    const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(129 * 1024)); }, cancel() { cancelled++; } });
    const service = createElectricianAvatars({ fetchImpl: async () => new Response(body, { status: kind === 'redirect' ? 302 : 200 }) });
    t.after(() => service.stop());
    assert.equal((await service.read({ china: rows.china, foreign: [] })).china[0].avatar, '');
    assert.equal(cancelled, 1);
  }
});

test('whole-list wait is bounded, upstream work is concurrency limited, and stop aborts and drains', async () => {
  let running = 0, peak = 0, aborted = 0;
  const service = createElectricianAvatars({ waitMs: 20, timeoutMs: 1000, concurrency: 2,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      running++; peak = Math.max(peak, running);
      signal.addEventListener('abort', () => { running--; aborted++; reject(new Error('aborted')); }, { once: true });
    }) });
  const details = { china: Array.from({ length: 20 }, (_, i) => ({ name: `Configured ${i}`, url: `https://steamcommunity.com/id/configured-${i}/` })), foreign: [] };
  const started = Date.now(), result = await service.read(details);
  assert.ok(Date.now() - started < 500); assert.equal(result.china.length, 20);
  assert.ok(result.china.every(row => row.avatar === '')); assert.equal(peak, 2);
  await service.stop(); assert.equal(running, 0); assert.equal(aborted, 2);
});

test('individual fetch timeout aborts upstream and subsequent readers use failure cooldown', async t => {
  let calls = 0, aborted = 0;
  const service = createElectricianAvatars({ timeoutMs: 15, waitMs: 200,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      calls++; signal.addEventListener('abort', () => { aborted++; reject(new Error('timeout')); }, { once: true });
    }) }); t.after(() => service.stop());
  const details = { china: rows.china, foreign: [] };
  assert.equal((await service.read(details)).china[0].avatar, '');
  assert.equal((await service.read(details)).china[0].avatar, '');
  assert.equal(calls, 1); assert.equal(aborted, 1);
});
