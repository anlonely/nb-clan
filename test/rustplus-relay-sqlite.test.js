import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import WebSocket from 'ws';

function uniqueImport(file) {
  return import(`${file}?rustplus-relay-sqlite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function queryCount(status, name) {
  return status.sqlite?.queries?.byName?.[name]?.total || 0;
}

async function readWsJson(ws, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for WebSocket message'));
    }, timeoutMs);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
    };
    const onMessage = (data) => {
      cleanup();
      try {
        resolve(JSON.parse(data.toString()));
      } catch (error) {
        reject(error);
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    ws.once('message', onMessage);
    ws.once('error', onError);
  });
}

async function closeHttpServer(server) {
  if (!server) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function closeWebSocketServer(wss) {
  if (!wss) return;
  for (const client of wss.clients) {
    client.terminate();
  }
  await new Promise((resolve, reject) => {
    wss.close((error) => (error ? reject(error) : resolve()));
  });
}

test('sqlite-primary Rust+ relay WebSocket ACK survives integration event create failure', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-rustplus-ws-sqlite-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS
  };
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';
  process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS = '0';

  let server = null;
  let relayWsServer = null;
  let relayWs = null;
  try {
    const storeModule = await import('../server/store.js');
    const rustplusRelayModule = await import('../server/rustplus-relay.js');
    const { installRustplusRelayWebSocket } = await import('../server/rustplus-relay-stream.js');
    const repositoryModule = await import('../server/storage/repository.js');
    const traceModule = await import('../server/trace-record-persistence.js');
    await storeModule.ensureStore();
    traceModule.resetTraceRecordPersistenceForTests();

    const relayToken = 'sqlite_ws_relay_token_1234567890';
    await rustplusRelayModule.saveRustplusRelayToken(relayToken);

    const app = express();
    server = createServer(app);
    relayWsServer = installRustplusRelayWebSocket(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const relayWsUrl = `ws://127.0.0.1:${server.address().port}/api/integrations/rustplus/stream`;

    relayWs = new WebSocket(relayWsUrl, { headers: { Authorization: `Bearer ${relayToken}` } });
    const helloPromise = readWsJson(relayWs);
    await new Promise((resolve, reject) => {
      relayWs.once('open', resolve);
      relayWs.once('error', reject);
    });
    const hello = await helloPromise;
    assert.equal(hello.type, 'hello');
    assert.equal(hello.ok, true);

    repositoryModule.injectSqliteStorePatchFailureForTests('integration_event_create', 2);
    const ackPromise = readWsJson(relayWs);
    relayWs.send(JSON.stringify({
      type: 'clan_snapshot',
      eventId: 'sqlite-ws-integration-event-failure',
      clientId: 'sqlite-ws-client',
      clientName: 'SQLite WS Client',
      serverId: 'sqlite-ws-server',
      serverName: 'SQLite WS Server',
      capturedAt: '2026-07-09T00:00:00.000Z',
      members: [{
        steamId: '76561198000003001',
        displayName: 'SQLite WS Member',
        online: true
      }],
      invites: []
    }));
    const ack = await ackPromise;
    assert.equal(ack.type, 'ack');
    assert.equal(ack.ok, true);
    assert.equal(ack.eventId, 'sqlite-ws-integration-event-failure');
    assert.equal(ack.relayEvent.type, 'clan_snapshot');

    const relayServers = await repositoryModule.getSqliteCollection('rustplusRelayServers', { limit: 0 });
    assert.equal(relayServers.length, 1);
    assert.equal(relayServers[0].key, 'sqlite-ws-client:sqlite-ws-server');
    assert.equal(relayServers[0].snapshot.members[0].steamId, '76561198000003001');
    const traceRecord = traceModule.traceRecordPersistenceSnapshot().records
      .find((item) => item.name === 'integration_event_create');
    assert.equal(traceRecord?.fallbackSuppressed, 1);
  } finally {
    relayWs?.terminate();
    await closeWebSocketServer(relayWsServer).catch(() => {});
    await closeHttpServer(server).catch(() => {});
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('sqlite-primary Rust+ relay API routes fail closed without full store fallback', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-rustplus-api-sqlite-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS
  };
  const httpFetch = globalThis.fetch.bind(globalThis);
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';
  process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS = '0';

  let server = null;
  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const authModule = await uniqueImport('../server/auth.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const sessionId = await authModule.createSession('user_root');
    const cookie = `nb_session=${encodeURIComponent(sessionId)}`;

    const beforeSettingsFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteQueryFailureForTests('scalar_settings', 1);
    let response = await httpFetch(`${baseUrl}/settings/rustplus-relay`, { headers: { cookie } });
    let payload = await response.json();
    const afterSettingsFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(response.status, 503, JSON.stringify(payload));
    assert.match(payload.error, /Rust\+配置读取暂不可用/);
    assert.equal(
      queryCount(afterSettingsFailure, 'read_store_full'),
      queryCount(beforeSettingsFailure, 'read_store_full')
    );

    const beforeRuntimeFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteQueryFailureForTests('list_rustplusRelayServers', 1);
    response = await httpFetch(`${baseUrl}/rustplus-relay/summary`, { headers: { cookie } });
    payload = await response.json();
    const afterRuntimeFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(response.status, 503, JSON.stringify(payload));
    assert.match(payload.error, /Rust\+运行数据读取暂不可用/);
    assert.equal(
      queryCount(afterRuntimeFailure, 'read_store_full'),
      queryCount(beforeRuntimeFailure, 'read_store_full')
    );
  } finally {
    await closeHttpServer(server).catch(() => {});
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('sqlite-primary Rust+ relay Discord push reports tracking failure after external send', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-rustplus-discord-track-sqlite-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS,
    NB_DISCORD_API_BASE_URL: process.env.NB_DISCORD_API_BASE_URL,
    NB_DISCORD_SEND_INTERVAL_MS: process.env.NB_DISCORD_SEND_INTERVAL_MS
  };
  const httpFetch = globalThis.fetch.bind(globalThis);
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';
  process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS = '0';
  process.env.NB_DISCORD_SEND_INTERVAL_MS = '0';

  let server = null;
  let discordServer = null;
  try {
    const discordRequests = [];
    const discordApp = express();
    discordApp.use(express.json());
    discordApp.post('/channels/:channelId/messages', (req, res) => {
      discordRequests.push({
        channelId: req.params.channelId,
        authorization: req.get('authorization') || '',
        body: req.body
      });
      res.json({
        id: 'discord_rustplus_tracking_sent_1',
        channel_id: req.params.channelId,
        timestamp: new Date().toISOString()
      });
    });
    discordServer = createServer(discordApp);
    await new Promise((resolve) => discordServer.listen(0, '127.0.0.1', resolve));
    process.env.NB_DISCORD_API_BASE_URL = `http://127.0.0.1:${discordServer.address().port}`;

    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const authModule = await uniqueImport('../server/auth.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();

    const createdAt = '2026-07-09T00:00:00.000Z';
    const settings = await repositoryModule.getSqliteScalar('settings') || {};
    settings.discord ||= {};
    settings.discord.botToken = 'discord_bot_token_rustplus_tracking_failure';
    settings.discord.guildId = '111111111111111111';
    settings.discord.channelId = '222222222222222222';
    settings.discord.targets = [{
      id: 'default',
      name: 'Default channel',
      guildId: '111111111111111111',
      channelId: '222222222222222222'
    }];
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_rustplus_discord_tracking_seed',
      scalars: {
        settings,
        rustplusRelayCollectionsReady: { ready: true, updatedAt: createdAt }
      },
      upserts: {
        rustplusRelayClients: [{
          id: 'rustplus_tracking_client',
          name: 'Tracking Client',
          lastSeenAt: createdAt
        }],
        rustplusRelayServers: [{
          id: 'rustplus_tracking_client:server_tracking',
          key: 'rustplus_tracking_client:server_tracking',
          clientId: 'rustplus_tracking_client',
          clientName: 'Tracking Client',
          serverId: 'server_tracking',
          name: 'Tracking Server',
          lastSeenAt: createdAt,
          lastSnapshotAt: createdAt,
          snapshot: {
            capturedAt: createdAt,
            clan: { id: '57', name: 'NB', memberLimit: 40, announcement: '', names: [], count: 1 },
            members: [{
              steamId: '76561198000005001',
              displayName: 'Tracking Member',
              online: true,
              lastSeenAt: createdAt
            }],
            invites: []
          }
        }],
        rustplusRelayChatMessages: [{
          id: 'rustplus_tracking_chat_1',
          clientId: 'rustplus_tracking_client',
          clientName: 'Tracking Client',
          serverKey: 'rustplus_tracking_client:server_tracking',
          serverId: 'server_tracking',
          serverName: 'Tracking Server',
          steamId: '76561198000005001',
          displayName: 'Tracking Member',
          message: 'tracking failure chat',
          channel: 'clan',
          sentAt: createdAt,
          receivedAt: createdAt
        }]
      }
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const sessionId = await authModule.createSession('user_root');
    const cookie = `nb_session=${encodeURIComponent(sessionId)}`;

    const before = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteStorePatchFailureForTests('rustplus_relay_discord_push_mark', 1);
    const response = await httpFetch(`${baseUrl}/rustplus-relay/discord`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        clientId: 'rustplus_tracking_client',
        serverKey: 'rustplus_tracking_client:server_tracking'
      })
    });
    const payload = await response.json();
    const after = await storeModule.storeRuntimeStatus({ sqliteSummary: false });

    assert.equal(response.status, 503, JSON.stringify(payload));
    assert.match(payload.error, /Rust\+ Discord 推送已发送/);
    assert.match(payload.error, /discord_rustplus_tracking_sent_1/);
    assert.equal(discordRequests.length, 1);
    assert.equal(discordRequests[0].channelId, '222222222222222222');
    assert.match(discordRequests[0].authorization, /^Bot discord_bot_token_rustplus_tracking_failure/);
    assert.equal(queryCount(after, 'read_store_full'), queryCount(before, 'read_store_full'));
    const persistedSettings = await repositoryModule.getSqliteScalar('settings');
    assert.equal(persistedSettings.rustplusRelay?.lastDiscordMessageId || '', '');
  } finally {
    await closeHttpServer(server).catch(() => {});
    await closeHttpServer(discordServer).catch(() => {});
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('sqlite-primary Rust+ relay split routes use scoped collection pages', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-rustplus-api-pages-sqlite-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS
  };
  const httpFetch = globalThis.fetch.bind(globalThis);
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';
  process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS = '0';

  let server = null;
  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const authModule = await uniqueImport('../server/auth.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();

    const createdAt = '2026-07-09T00:00:00.000Z';
    const chatRecords = Array.from({ length: 3 }, (_, index) => ({
      id: `rustplus_chat_page_${index}`,
      clientId: 'rustplus_client_page',
      clientName: 'Page Client',
      serverKey: 'rustplus_client_page:server_page',
      serverId: 'server_page',
      serverName: 'Page Server',
      steamId: '76561198000004001',
      displayName: 'Page Member',
      message: `page chat ${index}`,
      channel: 'clan',
      sentAt: new Date(Date.UTC(2026, 6, 9, 0, 0, index)).toISOString(),
      receivedAt: new Date(Date.UTC(2026, 6, 9, 0, 0, index)).toISOString()
    }));
    const inviteRecords = Array.from({ length: 2 }, (_, index) => ({
      id: `rustplus_invite_page_${index}`,
      clientId: 'rustplus_client_page',
      clientName: 'Page Client',
      serverKey: 'rustplus_client_page:server_page',
      serverId: 'server_page',
      serverName: 'Page Server',
      inviterSteamId: '76561198000004001',
      inviterName: 'Page Member',
      inviteeSteamId: `7656119800000400${index + 2}`,
      inviteeName: `Invitee ${index}`,
      invitedAt: new Date(Date.UTC(2026, 6, 9, 0, 5, index)).toISOString(),
      receivedAt: new Date(Date.UTC(2026, 6, 9, 0, 5, index)).toISOString(),
      status: 'pending'
    }));

    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_rustplus_split_route_pages_seed',
      scalars: {
        rustplusRelayCollectionsReady: { ready: true, updatedAt: createdAt }
      },
      upserts: {
        members: [{
          id: 'member_rustplus_page',
          steamId: '76561198000004001',
          rawInput: '76561198000004001',
          customName: 'Page System Name',
          steamNickname: 'Page Steam Nick',
          avatar: 'https://avatars.test/page.jpg',
          discordId: '',
          wechatId: '',
          wechatUserId: '',
          notes: '',
          specialty: [],
          memberStatus: 'active',
          invitedByUserId: '',
          createdAt,
          updatedAt: createdAt
        }],
        rustplusRelayClients: [{
          id: 'rustplus_client_page',
          name: 'Page Client',
          lastSeenAt: createdAt
        }],
        rustplusRelayServers: [{
          id: 'rustplus_client_page:server_page',
          key: 'rustplus_client_page:server_page',
          clientId: 'rustplus_client_page',
          clientName: 'Page Client',
          serverId: 'server_page',
          name: 'Page Server',
          lastSeenAt: createdAt,
          lastSnapshotAt: createdAt,
          snapshot: {
            capturedAt: createdAt,
            clan: { id: '57', name: 'NB', memberLimit: 40, announcement: '', names: [], count: 1 },
            members: [{
              steamId: '76561198000004001',
              displayName: 'Page Member',
              online: true,
              lastSeenAt: createdAt
            }],
            invites: []
          }
        }],
        rustplusRelayChatMessages: [
          ...chatRecords,
          {
            id: 'rustplus_chat_page_unrelated',
            clientId: 'rustplus_client_other',
            clientName: 'Other Client',
            serverKey: 'rustplus_client_other:server_other',
            serverId: 'server_other',
            serverName: 'Other Server',
            steamId: '76561198000004999',
            displayName: 'Other Member',
            message: 'unrelated',
            channel: 'clan',
            sentAt: createdAt,
            receivedAt: createdAt
          }
        ],
        rustplusRelayInviteRecords: [
          ...inviteRecords,
          {
            id: 'rustplus_invite_page_unrelated',
            clientId: 'rustplus_client_other',
            clientName: 'Other Client',
            serverKey: 'rustplus_client_other:server_other',
            serverId: 'server_other',
            serverName: 'Other Server',
            inviterSteamId: '76561198000004999',
            inviterName: 'Other Member',
            inviteeSteamId: '76561198000004998',
            inviteeName: 'Other Invitee',
            invitedAt: createdAt,
            receivedAt: createdAt,
            status: 'pending'
          }
        ],
        rustplusRelaySteamProfiles: [{
          id: '76561198000004001',
          steamId: '76561198000004001',
          steamNickname: 'Page Steam Nick',
          avatar: 'https://avatars.test/page.jpg',
          profileUrl: 'https://steamcommunity.com/profiles/76561198000004001',
          fetchedAt: createdAt
        }]
      },
      positions: {
        rustplusRelayChatMessages: Object.fromEntries([
          ...chatRecords.map((record, index) => [record.id, index + 1]),
          ['rustplus_chat_page_unrelated', 99]
        ]),
        rustplusRelayInviteRecords: Object.fromEntries([
          ...inviteRecords.map((record, index) => [record.id, index + 1]),
          ['rustplus_invite_page_unrelated', 99]
        ])
      }
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const sessionId = await authModule.createSession('user_root');
    const cookie = `nb_session=${encodeURIComponent(sessionId)}`;
    const scopeQuery = 'clientId=rustplus_client_page&serverKey=rustplus_client_page%3Aserver_page';

    const beforeChats = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    let response = await httpFetch(`${baseUrl}/rustplus-relay/chats?${scopeQuery}&chatLimit=1`, { headers: { cookie } });
    let payload = await response.json();
    const afterChats = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.ok, true);
    assert.equal(payload.relay.chatMessages.length, 1);
    assert.equal(payload.relay.chatPage.offset, 0);
    assert.equal(payload.relay.chatPage.limit, 1);
    assert.equal(payload.relay.chatPage.count, 1);
    assert.equal(payload.relay.chatPage.total, 3);
    assert.equal(payload.relay.chatPage.hasMore, true);
    assert.equal(payload.relay.summary.chatCount, 3);
    assert.equal(queryCount(afterChats, 'list_rustplusRelayChatMessages'), queryCount(beforeChats, 'list_rustplusRelayChatMessages'));
    assert.equal(queryCount(afterChats, 'list_rustplusRelayInviteRecords'), queryCount(beforeChats, 'list_rustplusRelayInviteRecords'));
    assert.equal(
      queryCount(afterChats, 'list_rustplusRelayChatMessages_clientId_serverKey') >
        queryCount(beforeChats, 'list_rustplusRelayChatMessages_clientId_serverKey'),
      true
    );
    assert.equal(
      queryCount(afterChats, 'count_rustplusRelayChatMessages_serverKey') >
        queryCount(beforeChats, 'count_rustplusRelayChatMessages_serverKey'),
      true
    );

    const beforeInvites = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    response = await httpFetch(`${baseUrl}/rustplus-relay/invites?${scopeQuery}&includeInviteRecords=1&inviteRecordLimit=1`, { headers: { cookie } });
    payload = await response.json();
    const afterInvites = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.ok, true);
    assert.equal(payload.relay.inviteRecords.length, 1);
    assert.equal(payload.relay.inviteRecordsIncluded, true);
    assert.equal(payload.relay.summary.inviteRecordCount, 2);
    assert.equal(queryCount(afterInvites, 'list_rustplusRelayInviteRecords'), queryCount(beforeInvites, 'list_rustplusRelayInviteRecords'));
    assert.equal(queryCount(afterInvites, 'list_rustplusRelayChatMessages'), queryCount(beforeInvites, 'list_rustplusRelayChatMessages'));
    assert.equal(
      queryCount(afterInvites, 'list_rustplusRelayInviteRecords_clientId_serverKey') >
        queryCount(beforeInvites, 'list_rustplusRelayInviteRecords_clientId_serverKey'),
      true
    );
    assert.equal(
      queryCount(afterInvites, 'count_rustplusRelayInviteRecords_serverKey') >
        queryCount(beforeInvites, 'count_rustplusRelayInviteRecords_serverKey'),
      true
    );

    const beforeMembers = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    response = await httpFetch(`${baseUrl}/rustplus-relay/members?${scopeQuery}&chatLimit=0`, { headers: { cookie } });
    payload = await response.json();
    const afterMembers = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.ok, true);
    assert.equal(payload.relay.members.length, 1);
    assert.equal(payload.relay.members[0].memberId, 'member_rustplus_page');
    assert.equal(Object.hasOwn(payload.relay, 'chatMessages'), false);
    assert.equal(Object.hasOwn(payload.relay, 'inviteRecords'), false);
    assert.equal(queryCount(afterMembers, 'list_rustplusRelayChatMessages'), queryCount(beforeMembers, 'list_rustplusRelayChatMessages'));
    assert.equal(queryCount(afterMembers, 'list_rustplusRelayInviteRecords'), queryCount(beforeMembers, 'list_rustplusRelayInviteRecords'));
    assert.equal(
      queryCount(afterMembers, 'list_rustplusRelayChatMessages_clientId_serverKey'),
      queryCount(beforeMembers, 'list_rustplusRelayChatMessages_clientId_serverKey')
    );
    assert.equal(
      queryCount(afterMembers, 'list_rustplusRelayInviteRecords_clientId_serverKey'),
      queryCount(beforeMembers, 'list_rustplusRelayInviteRecords_clientId_serverKey')
    );
  } finally {
    await closeHttpServer(server).catch(() => {});
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
