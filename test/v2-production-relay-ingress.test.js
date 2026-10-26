import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import WebSocket from 'ws';

test('production HTTP and WebSocket relay use only the injected owner, recheck credentials and drain accepted work', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nb-v2-relay-ingress-'));
  const saved = { ...process.env };
  Object.assign(process.env, { NODE_ENV: 'test', NB_DATA_DIR: directory, NB_STORAGE_MODE: 'json',
    NB_ROOT_PASSWORD: 'Constructed-local-fixture-only', NB_DISABLE_BACKGROUND_JOBS: '1', NB_DISABLE_DATA_BACKUP: '1',
    NB_DISABLE_EXTERNAL_VITAL: '1', NB_DISABLE_EXTERNAL_ATLAS: '1', NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: '0' });
  const { createApiRouter, stopBackgroundJobs } = await import('../server/api.js');
  const { installRustplusRelayWebSocket } = await import('../server/rustplus-relay-stream.js');
  const { saveRustplusRelayToken, RUSTPLUS_RELAY_STREAM_ENDPOINT } = await import('../server/rustplus-relay.js');
  const { ensureStore, readStore, drainStoreWrites } = await import('../server/store.js');
  await ensureStore(); const token = 'constructed-production-relay-token'; await saveRustplusRelayToken(token);
  const before = structuredClone(await readStore());
  const calls = []; let release, started, block = false, revoked = false, authCalls = 0;
  const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { started = resolve; });
  const relayIngest = async (raw, context) => {
    context.assertCredentialsCurrent(); calls.push({ raw, transport: context.transport });
    if (block) { started(); await gate; }
    context.assertCredentialsCurrent();
    return { event: { type: raw.type, clientId: raw.clientId, serverKey: raw.serverId, receivedAt: new Date().toISOString() } };
  };
  const api = createApiRouter({ relayIngest }), app = express(); app.use('/api', api);
  const server = createServer(app);
  const wss = installRustplusRelayWebSocket(server, { relayIngest, onRelayPayload() { assert.fail('legacy forwarding is forbidden'); },
    authenticateRelay: async req => { authCalls++; const current = await api.v2Runtime.authenticateRelay(req); return () => {
      current(); if (revoked) throw Object.assign(new Error('revoked'), { errorCode: 'RELAY_CREDENTIALS_CHANGED', status: 401 });
    }; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    release(); for (const client of wss.clients) client.terminate(); await wss.drain();
    await new Promise(resolve => server.close(resolve)); stopBackgroundJobs(); await api.v2Runtime.stop(); await drainStoreWrites();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved);
    await rm(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const body = { type: 'clan_chat_message', clientId: 'fixture-client', serverId: 'fixture-server', messageId: 'fixture-message', message: 'private fixture' };
  const post = credential => fetch(origin + '/api/integrations/rustplus/relay', { method: 'POST',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('incorrect')).status, 401); assert.equal(calls.length, 0);
  const ack = await post(token); assert.equal(ack.status, 200); assert.equal((await ack.json()).event.type, body.type);
  assert.equal(calls[0].transport, 'http');
  const ws = new WebSocket(origin.replace('http:', 'ws:') + RUSTPLUS_RELAY_STREAM_ENDPOINT, { headers: { authorization: `Bearer ${token}` } });
  const next = () => new Promise((resolve, reject) => { ws.once('message', data => resolve(JSON.parse(data))); ws.once('error', reject); });
  const hello = next(); assert.equal((await hello).type, 'hello');
  let reply = next(); ws.send(JSON.stringify(body)); assert.equal((await reply).ok, true);
  assert.equal(calls[1].transport, 'websocket'); assert.equal(authCalls, 2);
  revoked = true; reply = next(); ws.send(JSON.stringify(body)); assert.equal((await reply).error, 'RELAY_CREDENTIALS_CHANGED');
  assert.equal(calls.length, 2);
  revoked = false; block = true; ws.send(JSON.stringify(body)); await entered;
  let drained = false; const drain = wss.drain().then(() => { drained = true; });
  await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(drained, false);
  release(); await drain; assert.equal(drained, true);
  const after = await readStore();
  assert.deepEqual(after.rustplusRelay, before.rustplusRelay);
  assert.deepEqual(after.integrationEvents, before.integrationEvents);
});
