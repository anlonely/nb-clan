import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import { getEventListeners } from 'node:events';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import nodeFetch, { Response as NodeResponse } from 'node-fetch';
import { createProductionNetwork } from '../server/v2/production/network.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, body, options = {}) {
  const raw = new NodeResponse(body, { url: 'https://upstream.example/resource', ...options });
  const calls = [];
  const network = createProductionNetwork({ readSettings: () => ({ system: { proxy: { enabled: false } } }), env: {},
    fetchImpl: async (url, request) => { calls.push({ url, request }); return raw; } });
  t.after(() => { body?.destroy?.(); network.stop(); });
  return { network, raw, calls };
}

test('production network streams chunks and preserves response metadata', async t => {
  const body = new PassThrough(), f = fixture(t, body, { status: 429, statusText: 'Too Many Requests', headers: { 'retry-after': '3' } });
  const response = await f.network.serviceFetch('discord', 'https://upstream.example/resource');
  assert.equal(response.status, 429); assert.equal(response.statusText, 'Too Many Requests');
  assert.equal(response.headers.get('retry-after'), '3'); assert.equal(response.url, f.raw.url);
  assert.equal(response.redirected, false); assert.equal(f.calls[0].request.redirect, 'error');
  const reader = response.body.getReader();
  body.write(Buffer.from('first'));
  assert.equal(Buffer.from((await reader.read()).value).toString(), 'first', 'first chunk arrives before source end');
  body.end(Buffer.from('second'));
  assert.equal(Buffer.from((await reader.read()).value).toString(), 'second');
  assert.equal((await reader.read()).done, true);
  reader.releaseLock();
});

test('production network destroys bodyless HTTP responses and keeps native responses', async t => {
  for (const status of [204, 205, 304]) {
    const body = new PassThrough(), f = fixture(t, body, { status });
    const response = await f.network.fetchImpl('https://upstream.example/resource');
    assert.equal(response.status, status); assert.equal(response.body, null); assert.equal(body.destroyed, true);
  }
  const native = new Response('native');
  const network = createProductionNetwork({ readSettings: () => ({}), env: {}, fetchImpl: async () => native });
  t.after(() => network.stop());
  assert.equal(await network.fetchImpl('https://upstream.example/resource'), native);
});

test('production network applies byte backpressure instead of buffering an entire body', async t => {
  let reads = 0;
  const body = new Readable({ highWaterMark: 16, read() { reads++; this.push(reads <= 100 ? Buffer.alloc(16, reads) : null); } });
  const f = fixture(t, body), response = await f.network.fetchImpl('https://upstream.example/resource');
  await tick(); await tick();
  assert.ok(reads < 10, `unread response should remain bounded, got ${reads} source reads`);
  const reader = response.body.getReader();
  assert.equal((await reader.read()).value.byteLength, 16);
  await reader.cancel('response byte limit');
  assert.equal(body.destroyed, true);
});

test('production network cancellation fences late callbacks without uncaught exceptions', async () => {
  // A deferred destroy permits the same event-turn race as a queued HTTP data
  // listener. Run in a child so an uncaught exception cannot be hidden by a
  // process-wide handler; the former Readable.toWeb adapter exits nonzero here.
  const moduleUrl = new URL('../server/v2/production/network.js', import.meta.url).href;
  const source = `
    import assert from 'node:assert/strict';
    import { PassThrough } from 'node:stream';
    import { createProductionNetwork } from ${JSON.stringify(moduleUrl)};
    const body = new PassThrough({ destroy(error, done) { setImmediate(() => done(error)); } });
    const network = createProductionNetwork({ readSettings: () => ({}), env: {}, fetchImpl: async () =>
      ({ body, status: 200, statusText: 'OK', headers: new Headers(), url: 'https://upstream.example/', redirected: false }) });
    const response = await network.fetchImpl('https://upstream.example/');
    const reader = response.body.getReader();
    const pending = reader.read();
    const queued = [...body.listeners('data'), ...body.listeners('readable')];
    await new Promise(resolve => process.nextTick(() => {
      void reader.cancel('response byte limit');
      for (const listener of queued) listener(Buffer.from('late HTTP data'));
      body.emit('data', Buffer.from('later HTTP data'));
      body.emit('error', new Error('late pipeline error'));
      body.emit('end');
      resolve();
    }));
    assert.equal((await pending).done, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(body.destroyed, true);
    body.emit('error', new Error('error after close'));
    network.stop();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  assert.deepEqual(result, { code: 0, signal: null }, output);
});

test('production network aborts pending reads and removes its AbortSignal listener', async t => {
  const body = new PassThrough(), f = fixture(t, body), controller = new AbortController();
  const response = await f.network.fetchImpl('https://upstream.example/resource', { signal: controller.signal });
  const reader = response.body.getReader(), pending = reader.read();
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort(); await rejected;
  assert.equal(body.destroyed, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.doesNotThrow(() => { body.emit('readable'); body.emit('error', new Error('late abort error')); });
  reader.releaseLock();
});

test('production network handles abort before conversion and already failed sources', async t => {
  const controller = new AbortController(); controller.abort();
  const body = new PassThrough(), f = fixture(t, body);
  const response = await f.network.fetchImpl('https://upstream.example/resource', { signal: controller.signal });
  await assert.rejects(response.text(), { name: 'AbortError' }); assert.equal(body.destroyed, true);
  const ended = new PassThrough(); ended.end(); ended.resume(); await tick();
  const complete = fixture(t, ended); assert.equal(await (await complete.network.fetchImpl('https://upstream.example/resource')).text(), '');
  const failed = new PassThrough(); failed.on('error', () => {}); failed.destroy(new Error('source failed')); await tick();
  const failedFixture = fixture(t, failed);
  await assert.rejects((await failedFixture.network.fetchImpl('https://upstream.example/resource')).text(), /source failed/);
});

test('production network rejects source errors and premature close instead of truncated success', async t => {
  for (const failure of ['error', 'close']) {
    const body = new PassThrough(), f = fixture(t, body);
    const response = await f.network.fetchImpl('https://upstream.example/resource');
    const text = response.text();
    const rejected = assert.rejects(text, failure === 'error' ? /upstream failed/ : { code: 'ERR_STREAM_PREMATURE_CLOSE' });
    body.write('partial JSON');
    if (failure === 'error') body.destroy(new Error('upstream failed')); else body.destroy();
    await rejected;
  }
});

async function listen(t, server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.closeAllConnections?.(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('production network real node-fetch supports streaming, HTTP status and abort', async t => {
  let closeSlow;
  const slowClosed = new Promise(resolve => { closeSlow = resolve; });
  const origin = await listen(t, http.createServer((req, res) => {
    if (req.url === '/slow') { res.writeHead(200); res.write('first'); res.once('close', closeSlow); return; }
    res.writeHead(429, { 'retry-after': '7' }); res.write('first'); setImmediate(() => res.end('second'));
  }));
  const network = createProductionNetwork({ readSettings: () => ({ system: { proxy: { enabled: false } } }), env: {} });
  t.after(() => network.stop());
  const response = await network.serviceFetch('discord', origin + '/status');
  assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '7');
  assert.equal(await response.text(), 'firstsecond');
  const controller = new AbortController(), slow = await network.fetchImpl(origin + '/slow', { signal: controller.signal });
  const reader = slow.body.getReader(); assert.equal(Buffer.from((await reader.read()).value).toString(), 'first');
  const rejected = assert.rejects(reader.read(), { name: 'AbortError' }); controller.abort(); await rejected;
  await slowClosed; reader.releaseLock();
  await assert.rejects(network.fetchImpl(origin + '/status', { signal: controller.signal }), { name: 'AbortError' });
});

test('production network keeps configured CONNECT proxy routing and master switch behavior', async t => {
  const upstream = await listen(t, http.createServer((_req, res) => { res.writeHead(200, { 'x-route': 'fixture' }); res.end('proxied'); }));
  let connects = 0;
  const sockets = new Set();
  const proxy = http.createServer();
  proxy.on('connect', (req, client, head) => {
    connects++; assert.equal(req.url, new URL(upstream).host);
    const target = net.connect(new URL(upstream).port, '127.0.0.1');
    for (const socket of [client, target]) { sockets.add(socket); socket.on('error', () => socket.destroy()); socket.on('close', () => sockets.delete(socket)); }
    target.once('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) target.write(head); target.pipe(client); client.pipe(target); });
  });
  const proxyUrl = await listen(t, proxy);
  t.after(() => { for (const socket of sockets) socket.destroy(); });
  const settings = { system: { proxy: { enabled: true, url: proxyUrl, scope: 'discord' } } };
  const network = createProductionNetwork({ readSettings: () => settings, env: {}, fetchImpl: nodeFetch });
  t.after(() => network.stop());
  const response = await network.serviceFetch('discord', upstream + '/proxy');
  assert.equal(await response.text(), 'proxied'); assert.equal(response.headers.get('x-route'), 'fixture'); assert.equal(connects, 1);
  settings.system.proxy.enabled = false;
  assert.equal(await (await network.proxyFetch(upstream + '/direct', { proxyUrl })).text(), 'proxied');
  assert.equal(connects, 1, 'disabled proxy must not reuse the previously selected route');
});
