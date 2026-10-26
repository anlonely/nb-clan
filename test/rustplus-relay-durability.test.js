import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import WebSocket from 'ws';

const fixturePath = fileURLToPath(new URL('./support/rustplus-relay-durability-server.mjs', import.meta.url));
const relayToken = 'rustplus_durability_token_1234567890';

function fixtureEnvironment(dataDir, options = {}) {
  return {
    ...process.env,
    NODE_ENV: 'test',
    NB_DATA_DIR: dataDir,
    NB_ROOT_PASSWORD: 'RootPass123!',
    NB_STORAGE_MODE: 'sqlite-primary',
    NB_SQLITE_FILE: path.join(dataDir, 'nb-clan.sqlite'),
    NB_DISABLE_BACKGROUND_JOBS: '1',
    NB_DISABLE_EXTERNAL_VITAL: '1',
    NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: String(options.flushIntervalMs ?? 40),
    NB_TEST_RUSTPLUS_RELAY_TOKEN: relayToken,
    NB_TEST_RUSTPLUS_CHAT_FLUSH_FAILURES: String(options.flushFailures || 0),
    NB_TEST_RUSTPLUS_INVITE_WRITE_FAILURES: String(options.inviteFailures || 0)
  };
}

async function startFixture(dataDir, options = {}) {
  const child = spawn(process.execPath, [fixturePath], {
    cwd: path.resolve(fileURLToPath(new URL('..', import.meta.url))),
    env: fixtureEnvironment(dataDir, options),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const stderr = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const lines = readline.createInterface({ input: child.stdout });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Rust+ durability fixture startup timed out: ${stderr.join('')}`)), 10_000);
    const onExit = (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Rust+ durability fixture exited before ready (${code ?? signal}): ${stderr.join('')}`));
    };
    child.once('exit', onExit);
    lines.on('line', (line) => {
      let payload;
      try {
        payload = JSON.parse(line);
      } catch {
        return;
      }
      if (payload?.type !== 'ready') return;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(payload);
    });
  });
  return {
    child,
    stderr,
    baseUrl: `http://127.0.0.1:${ready.port}/api`,
    wsUrl: `ws://127.0.0.1:${ready.port}/api/integrations/rustplus/stream`,
    async stop() {
      lines.close();
      if (child.exitCode !== null || child.signalCode) return;
      child.kill('SIGTERM');
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`Rust+ durability fixture shutdown timed out: ${stderr.join('')}`));
        }, 5_000);
        child.once('exit', (code, signal) => {
          clearTimeout(timer);
          if (code === 0 || signal === 'SIGTERM') resolve();
          else reject(new Error(`Rust+ durability fixture shutdown failed (${code ?? signal}): ${stderr.join('')}`));
        });
      });
    }
  };
}

async function postRelay(baseUrl, payload) {
  const response = await fetch(`${baseUrl}/integrations/rustplus/relay`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${relayToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  return { response, body };
}

function readWsJson(ws, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for Rust+ relay WebSocket message'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
    };
    const onMessage = (data) => {
      cleanup();
      resolve(JSON.parse(data.toString()));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    ws.once('message', onMessage);
    ws.once('error', onError);
  });
}

async function openRelayWebSocket(url) {
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${relayToken}` } });
  const helloPromise = readWsJson(ws);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const hello = await helloPromise;
  assert.equal(hello.type, 'hello');
  return ws;
}

async function sendRelayWebSocket(ws, payload) {
  const responsePromise = readWsJson(ws);
  ws.send(JSON.stringify(payload));
  return responsePromise;
}

function relayChatPayload(messageId, message, sentAt) {
  return {
    type: 'clan_chat_message',
    eventId: `event_${messageId}`,
    clientId: 'durability-client',
    clientName: 'Durability Client',
    serverId: 'durability-server',
    serverName: 'Durability Server',
    messageId,
    steamId: '76561198000007001',
    displayName: 'Durability Member',
    message,
    channel: 'clan',
    sentAt
  };
}

function relayInvitePayload() {
  return {
    type: 'clan_invite_record',
    eventId: 'event_durable_invite_1',
    clientId: 'durability-client',
    clientName: 'Durability Client',
    serverId: 'durability-server',
    serverName: 'Durability Server',
    inviteId: 'durable-invite-1',
    steamId: '76561198000007002',
    displayName: 'Durability Invitee',
    inviterSteamId: '76561198000007001',
    inviterName: 'Durability Member',
    status: 'pending',
    sentAt: '2026-07-10T00:00:02.000Z'
  };
}

test('Rust+ HTTP and WebSocket ACK only after durable flush, including restart and idempotent retry', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-rustplus-durability-'));
  const httpPayload = relayChatPayload('durable-http-1', 'durable HTTP message', '2026-07-10T00:00:00.000Z');
  const wsPayload = relayChatPayload('durable-ws-1', 'durable WebSocket message', '2026-07-10T00:00:01.000Z');
  const invitePayload = relayInvitePayload();
  let fixture = null;
  let ws = null;
  try {
    fixture = await startFixture(dataDir, { flushFailures: 2, inviteFailures: 1, flushIntervalMs: 40 });

    let result = await postRelay(fixture.baseUrl, httpPayload);
    assert.equal(result.response.status, 500, JSON.stringify(result.body));
    assert.equal(typeof result.body.error, 'string');
    assert.notEqual(result.body.error, '');

    ws = await openRelayWebSocket(fixture.wsUrl);
    let ack = await sendRelayWebSocket(ws, wsPayload);
    assert.equal(ack.type, 'ack');
    assert.equal(ack.ok, false);
    assert.match(ack.error, /Injected sqlite patch failure for rustplus_relay_chat_flush/);

    result = await postRelay(fixture.baseUrl, invitePayload);
    assert.equal(result.response.status, 500, JSON.stringify(result.body));

    result = await postRelay(fixture.baseUrl, httpPayload);
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.event.skipped, false);
    assert.equal(result.body.event.inserted, true);

    result = await postRelay(fixture.baseUrl, invitePayload);
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.event.skipped, false);
    assert.equal(result.body.event.inserted, true);

    ack = await sendRelayWebSocket(ws, wsPayload);
    assert.equal(ack.type, 'ack');
    assert.equal(ack.ok, true);
    assert.equal(ack.relayEvent.skipped, undefined);
    assert.equal(ack.relayEvent.inserted, true);

    ws.close();
    ws = null;
    await fixture.stop();
    fixture = await startFixture(dataDir, { flushIntervalMs: 0 });

    result = await postRelay(fixture.baseUrl, httpPayload);
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.event.skipped, true);
    assert.equal(result.body.event.skipReason, 'duplicate_chat_message');
    assert.equal(result.body.event.inserted, false);

    ws = await openRelayWebSocket(fixture.wsUrl);
    ack = await sendRelayWebSocket(ws, wsPayload);
    assert.equal(ack.type, 'ack');
    assert.equal(ack.ok, true);
    assert.equal(ack.relayEvent.skipped, true);
    assert.equal(ack.relayEvent.skipReason, 'duplicate_chat_message');

    result = await postRelay(fixture.baseUrl, invitePayload);
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.event.skipped, true);
    assert.equal(result.body.event.skipReason, 'duplicate_invite_record');
    assert.equal(result.body.event.inserted, false);

    const previousEnv = {
      NB_DATA_DIR: process.env.NB_DATA_DIR,
      NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
      NB_SQLITE_FILE: process.env.NB_SQLITE_FILE
    };
    process.env.NB_DATA_DIR = dataDir;
    process.env.NB_STORAGE_MODE = 'sqlite-primary';
    process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
    const repositoryModule = await import('../server/storage/repository.js');
    const sqliteModule = await import('../server/storage/sqlite.js');
    const messages = await repositoryModule.getSqliteCollection('rustplusRelayChatMessages', { limit: 0 });
    const inviteRecords = await repositoryModule.getSqliteCollection('rustplusRelayInviteRecords', { limit: 0 });
    assert.deepEqual(messages.map((item) => item.message).sort(), [httpPayload.message, wsPayload.message].sort());
    assert.deepEqual(inviteRecords.map((item) => item.displayName), [invitePayload.displayName]);
    await sqliteModule.closeSqliteDatabasesForTests();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  } finally {
    ws?.terminate();
    await fixture?.stop().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
});
