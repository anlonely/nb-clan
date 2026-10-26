import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertExternalProviderAvailable,
  externalProviderHealthSnapshot,
  recordExternalProviderFailure,
  recordExternalProviderSuccess,
  resetExternalProviderHealthForTests
} from '../server/external-provider-health.js';

function uniqueImport(file) {
  return import(`${file}?provider-health-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function mockTextResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body || '{}')
  };
}

function mockJsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body
  };
}

function mockBattlemetricsResponse(body, status = 200, headers = {}) {
  const normalizedHeaders = new Map(
    Object.entries({ 'content-type': 'application/json', ...headers })
      .map(([key, value]) => [String(key).toLowerCase(), String(value)])
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return normalizedHeaders.get(String(name).toLowerCase()) || null;
      }
    },
    text: async () => JSON.stringify(body),
    json: async () => body
  };
}

test('external provider circuit opens only after retryable failures', () => {
  const previousEnv = {
    NB_EXTERNAL_PROVIDER_CIRCUIT_FAILURE_THRESHOLD: process.env.NB_EXTERNAL_PROVIDER_CIRCUIT_FAILURE_THRESHOLD,
    NB_EXTERNAL_PROVIDER_CIRCUIT_COOLDOWN_MS: process.env.NB_EXTERNAL_PROVIDER_CIRCUIT_COOLDOWN_MS
  };
  process.env.NB_EXTERNAL_PROVIDER_CIRCUIT_FAILURE_THRESHOLD = '2';
  process.env.NB_EXTERNAL_PROVIDER_CIRCUIT_COOLDOWN_MS = '10000';
  resetExternalProviderHealthForTests();

  try {
    recordExternalProviderFailure('vital_kda', Object.assign(new Error('bad request'), { status: 400 }), 'server:16:wipe:test');
    let snapshot = externalProviderHealthSnapshot();
    assert.equal(snapshot.openCount, 0);
    assert.equal(snapshot.circuits[0].consecutiveFailures, 0);

    recordExternalProviderFailure('vital_kda', Object.assign(new Error('timeout'), { status: 504 }), 'server:16:wipe:test');
    snapshot = externalProviderHealthSnapshot();
    assert.equal(snapshot.openCount, 0);
    assert.equal(snapshot.circuits[0].consecutiveFailures, 1);

    recordExternalProviderFailure('vital_kda', Object.assign(new Error('upstream failed'), { status: 502 }), 'server:16:wipe:test');
    snapshot = externalProviderHealthSnapshot();
    assert.equal(snapshot.openCount, 1);
    assert.equal(snapshot.total, 3);
    assert.equal(snapshot.failed, 3);
    assert.equal(snapshot.retryableFailed, 2);
    assert.equal(snapshot.failureRate, 1);
    assert.equal(snapshot.retryableFailureRate, 0.6667);
    assert.equal(snapshot.failingProviderCount, 1);
    assert.equal(snapshot.circuits[0].status, 'open');
    assert.equal(snapshot.circuits[0].retryAfterSeconds > 0, true);
    assert.throws(
      () => assertExternalProviderAvailable('vital_kda', 'server:16:wipe:test'),
      /provider circuit is open/
    );

    recordExternalProviderSuccess('vital_kda', 'server:16:wipe:test');
    snapshot = externalProviderHealthSnapshot();
    assert.equal(snapshot.openCount, 0);
    assert.equal(snapshot.circuits[0].status, 'closed');
    assert.equal(snapshot.circuits[0].consecutiveFailures, 0);
  } finally {
    resetExternalProviderHealthForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
  }
});

test('BattleMetrics queue updates provider health and stops when circuit is open', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-bm-provider-health-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_EXTERNAL_PROVIDER_CIRCUIT_FAILURE_THRESHOLD: process.env.NB_EXTERNAL_PROVIDER_CIRCUIT_FAILURE_THRESHOLD,
    NB_EXTERNAL_PROVIDER_CIRCUIT_COOLDOWN_MS: process.env.NB_EXTERNAL_PROVIDER_CIRCUIT_COOLDOWN_MS,
    NB_BATTLEMETRICS_MIN_INTERVAL_MS: process.env.NB_BATTLEMETRICS_MIN_INTERVAL_MS,
    NB_BATTLEMETRICS_REQUESTS_PER_MINUTE: process.env.NB_BATTLEMETRICS_REQUESTS_PER_MINUTE,
    NB_BATTLEMETRICS_AUTO_REQUESTS_PER_MINUTE: process.env.NB_BATTLEMETRICS_AUTO_REQUESTS_PER_MINUTE,
    NB_BATTLEMETRICS_MAX_RETRIES: process.env.NB_BATTLEMETRICS_MAX_RETRIES
  };
  const previousFetch = globalThis.fetch;
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'file';
  delete process.env.NB_SQLITE_FILE;
  process.env.NB_EXTERNAL_PROVIDER_CIRCUIT_FAILURE_THRESHOLD = '2';
  process.env.NB_EXTERNAL_PROVIDER_CIRCUIT_COOLDOWN_MS = '10000';
  process.env.NB_BATTLEMETRICS_MIN_INTERVAL_MS = '0';
  process.env.NB_BATTLEMETRICS_REQUESTS_PER_MINUTE = '1000';
  process.env.NB_BATTLEMETRICS_AUTO_REQUESTS_PER_MINUTE = '1000';
  process.env.NB_BATTLEMETRICS_MAX_RETRIES = '0';
  resetExternalProviderHealthForTests();

  try {
    const storeModule = await import('../server/store.js');
    await storeModule.ensureStore();
    const apiModule = await uniqueImport('../server/api.js');
    apiModule.__battlemetricsProviderHealthForTests.resetQueue();

    let fetches = 0;
    globalThis.fetch = async (url) => {
      assert.match(String(url), /^https:\/\/api\.battlemetrics\.com\//);
      fetches += 1;
      return mockBattlemetricsResponse({ errors: [{ title: 'upstream unavailable' }] }, 503);
    };

    const request = () => apiModule.__battlemetricsProviderHealthForTests.queueBattlemetricsJson(
      'battlemetrics_api_key_for_test',
      '/players',
      { queue: { operation: 'match_players', source: 'manual' } }
    );

    await assert.rejects(request, /BattleMetrics HTTP 503/);
    await assert.rejects(request, /BattleMetrics HTTP 503/);

    let snapshot = externalProviderHealthSnapshot();
    const battlemetricsState = snapshot.circuits.find(
      (state) => state.provider === 'battlemetrics_api' && state.scope === 'match_players'
    );
    assert.equal(battlemetricsState.status, 'open');
    assert.equal(battlemetricsState.failed, 2);
    assert.equal(battlemetricsState.retryableFailed, 2);
    assert.equal(fetches, 2);

    await assert.rejects(request, /provider circuit is open/);
    snapshot = externalProviderHealthSnapshot();
    assert.equal(snapshot.openCount, 1);
    assert.equal(fetches, 2);
  } finally {
    globalThis.fetch = previousFetch;
    resetExternalProviderHealthForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('Discord API requests update provider health and stop when circuit is open', async () => {
  const previousEnv = {
    NB_DISCORD_API_BASE_URL: process.env.NB_DISCORD_API_BASE_URL,
    NB_DISCORD_MESSAGE_MAX_ATTEMPTS: process.env.NB_DISCORD_MESSAGE_MAX_ATTEMPTS,
    NB_DISCORD_RETRY_MAX_DELAY_MS: process.env.NB_DISCORD_RETRY_MAX_DELAY_MS,
    NB_DISCORD_API_REQUEST_TIMEOUT_MS: process.env.NB_DISCORD_API_REQUEST_TIMEOUT_MS,
    NB_EXTERNAL_PROVIDER_CIRCUIT_FAILURE_THRESHOLD: process.env.NB_EXTERNAL_PROVIDER_CIRCUIT_FAILURE_THRESHOLD,
    NB_EXTERNAL_PROVIDER_CIRCUIT_COOLDOWN_MS: process.env.NB_EXTERNAL_PROVIDER_CIRCUIT_COOLDOWN_MS
  };
  let requests = 0;
  const server = createServer((_req, res) => {
    requests += 1;
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'temporarily unavailable' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.NB_DISCORD_API_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.NB_DISCORD_MESSAGE_MAX_ATTEMPTS = '1';
  process.env.NB_DISCORD_RETRY_MAX_DELAY_MS = '250';
  process.env.NB_DISCORD_API_REQUEST_TIMEOUT_MS = '1000';
  process.env.NB_EXTERNAL_PROVIDER_CIRCUIT_FAILURE_THRESHOLD = '2';
  process.env.NB_EXTERNAL_PROVIDER_CIRCUIT_COOLDOWN_MS = '10000';
  resetExternalProviderHealthForTests();

  try {
    const apiModule = await uniqueImport('../server/api.js');
    const request = () => apiModule.__discordProviderHealthForTests.postDiscordChannelMessage(
      'discord_bot_token_for_test',
      '123456789012345678',
      { content: 'provider health test' }
    );

    await assert.rejects(request, /Discord push failed/);
    await assert.rejects(request, /Discord push failed/);

    let snapshot = externalProviderHealthSnapshot();
    const discordState = snapshot.circuits.find(
      (state) => state.provider === 'discord_api' && state.scope === 'channel_message_create'
    );
    assert.equal(discordState.status, 'open');
    assert.equal(discordState.failed, 2);
    assert.equal(discordState.retryableFailed, 2);
    assert.equal(requests, 2);

    await assert.rejects(request, /provider circuit is open/);
    snapshot = externalProviderHealthSnapshot();
    assert.equal(snapshot.openCount, 1);
    assert.equal(requests, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    resetExternalProviderHealthForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
  }
});

test('Discord message timeout retries with one stable idempotency nonce', async () => {
  const previousEnv = {
    NB_DISCORD_API_BASE_URL: process.env.NB_DISCORD_API_BASE_URL,
    NB_DISCORD_MESSAGE_MAX_ATTEMPTS: process.env.NB_DISCORD_MESSAGE_MAX_ATTEMPTS,
    NB_DISCORD_RETRY_MAX_DELAY_MS: process.env.NB_DISCORD_RETRY_MAX_DELAY_MS,
    NB_DISCORD_API_REQUEST_TIMEOUT_MS: process.env.NB_DISCORD_API_REQUEST_TIMEOUT_MS,
    NB_EXTERNAL_PROVIDER_CIRCUIT_FAILURE_THRESHOLD: process.env.NB_EXTERNAL_PROVIDER_CIRCUIT_FAILURE_THRESHOLD
  };
  const bodies = [];
  let requests = 0;
  const server = createServer(async (req, res) => {
    requests += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (requests === 1) {
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'late_discord_message' }));
      }, 1250);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'retried_discord_message' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.NB_DISCORD_API_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.NB_DISCORD_MESSAGE_MAX_ATTEMPTS = '2';
  process.env.NB_DISCORD_RETRY_MAX_DELAY_MS = '250';
  process.env.NB_DISCORD_API_REQUEST_TIMEOUT_MS = '1000';
  process.env.NB_EXTERNAL_PROVIDER_CIRCUIT_FAILURE_THRESHOLD = '5';
  resetExternalProviderHealthForTests();

  try {
    const apiModule = await uniqueImport('../server/api.js');
    const result = await apiModule.__discordProviderHealthForTests.postDiscordChannelMessage(
      'discord_bot_token_for_timeout_test',
      '123456789012345678',
      { content: 'idempotent timeout retry' }
    );
    assert.equal(result.id, 'retried_discord_message');
    assert.equal(requests, 2);
    assert.equal(bodies[0].enforce_nonce, true);
    assert.equal(bodies[1].enforce_nonce, true);
    assert.equal(Boolean(bodies[0].nonce), true);
    assert.equal(bodies[1].nonce, bodies[0].nonce);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    resetExternalProviderHealthForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
  }
});

test('KOOK API requests update provider health and stop when circuit is open', async () => {
  const previousEnv = {
    NB_KOOK_API_BASE_URL: process.env.NB_KOOK_API_BASE_URL,
    NB_KOOK_API_REQUEST_TIMEOUT_MS: process.env.NB_KOOK_API_REQUEST_TIMEOUT_MS,
    NB_EXTERNAL_PROVIDER_CIRCUIT_FAILURE_THRESHOLD: process.env.NB_EXTERNAL_PROVIDER_CIRCUIT_FAILURE_THRESHOLD,
    NB_EXTERNAL_PROVIDER_CIRCUIT_COOLDOWN_MS: process.env.NB_EXTERNAL_PROVIDER_CIRCUIT_COOLDOWN_MS
  };
  let requests = 0;
  const server = createServer((_req, res) => {
    requests += 1;
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'temporarily unavailable' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.NB_KOOK_API_BASE_URL = `http://127.0.0.1:${server.address().port}/api/v3`;
  process.env.NB_KOOK_API_REQUEST_TIMEOUT_MS = '1000';
  process.env.NB_EXTERNAL_PROVIDER_CIRCUIT_FAILURE_THRESHOLD = '2';
  process.env.NB_EXTERNAL_PROVIDER_CIRCUIT_COOLDOWN_MS = '10000';
  resetExternalProviderHealthForTests();

  try {
    const apiModule = await uniqueImport('../server/api.js');
    const request = () => apiModule.__kookProviderHealthForTests.kookApiRequest(
      { botToken: 'kook_bot_token_for_test' },
      '/message/list',
      { query: { target_id: 'kook_channel_for_test' } }
    );

    await assert.rejects(request, /KOOK API failed/);
    await assert.rejects(request, /KOOK API failed/);

    let snapshot = externalProviderHealthSnapshot();
    const kookState = snapshot.circuits.find(
      (state) => state.provider === 'kook_api' && state.scope === '/message/list'
    );
    assert.equal(kookState.status, 'open');
    assert.equal(kookState.failed, 2);
    assert.equal(kookState.retryableFailed, 2);
    assert.equal(requests, 2);

    await assert.rejects(request, /provider circuit is open/);
    snapshot = externalProviderHealthSnapshot();
    assert.equal(snapshot.openCount, 1);
    assert.equal(requests, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    resetExternalProviderHealthForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
  }
});

test('WeChat subscribe messages update provider health and stop when circuit is open', async () => {
  const previousEnv = {
    NB_WECHAT_API_BASE_URL: process.env.NB_WECHAT_API_BASE_URL,
    NB_WECHAT_APPID: process.env.NB_WECHAT_APPID,
    NB_WECHAT_SECRET: process.env.NB_WECHAT_SECRET,
    NB_WECHAT_APP_SECRET: process.env.NB_WECHAT_APP_SECRET,
    NB_EXTERNAL_PROVIDER_CIRCUIT_FAILURE_THRESHOLD: process.env.NB_EXTERNAL_PROVIDER_CIRCUIT_FAILURE_THRESHOLD,
    NB_EXTERNAL_PROVIDER_CIRCUIT_COOLDOWN_MS: process.env.NB_EXTERNAL_PROVIDER_CIRCUIT_COOLDOWN_MS
  };
  let tokenRequests = 0;
  let sendRequests = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/cgi-bin/token') {
      tokenRequests += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'wechat_access_token_for_test', expires_in: 7200 }));
      return;
    }
    if (url.pathname === '/cgi-bin/message/subscribe/send') {
      sendRequests += 1;
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ errmsg: 'temporarily unavailable' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ errmsg: 'not found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.NB_WECHAT_API_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.NB_WECHAT_APPID = 'wechat_appid_for_test';
  process.env.NB_WECHAT_SECRET = 'wechat_secret_for_test';
  delete process.env.NB_WECHAT_APP_SECRET;
  process.env.NB_EXTERNAL_PROVIDER_CIRCUIT_FAILURE_THRESHOLD = '2';
  process.env.NB_EXTERNAL_PROVIDER_CIRCUIT_COOLDOWN_MS = '10000';
  resetExternalProviderHealthForTests();

  try {
    const apiModule = await uniqueImport('../server/api.js');
    apiModule.__wechatProviderHealthForTests.resetAccessTokenCache();
    const request = () => apiModule.__wechatProviderHealthForTests.sendWechatSubscribeMessage({
      openid: 'wechat_openid_for_test',
      templateId: 'wechat_template_for_test',
      data: { thing1: { value: 'NB Clan' } }
    });

    await assert.rejects(request, /微信订阅消息发送失败/);
    await assert.rejects(request, /微信订阅消息发送失败/);

    let snapshot = externalProviderHealthSnapshot();
    const wechatState = snapshot.circuits.find(
      (state) => state.provider === 'wechat_api' && state.scope === 'subscribe_message'
    );
    assert.equal(wechatState.status, 'open');
    assert.equal(wechatState.failed, 2);
    assert.equal(wechatState.retryableFailed, 2);
    assert.equal(tokenRequests, 1);
    assert.equal(sendRequests, 2);

    await assert.rejects(request, /provider circuit is open/);
    snapshot = externalProviderHealthSnapshot();
    assert.equal(snapshot.openCount, 1);
    assert.equal(sendRequests, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    resetExternalProviderHealthForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
  }
});

test('WeChat provider network errors redact credential query values', async () => {
  const previousEnv = {
    NB_WECHAT_API_BASE_URL: process.env.NB_WECHAT_API_BASE_URL,
    NB_WECHAT_APPID: process.env.NB_WECHAT_APPID,
    NB_WECHAT_SECRET: process.env.NB_WECHAT_SECRET,
    NB_WECHAT_APP_SECRET: process.env.NB_WECHAT_APP_SECRET
  };
  const server = createServer((_req, res) => {
    res.writeHead(500).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  process.env.NB_WECHAT_API_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.NB_WECHAT_APPID = 'wx_secret_probe_appid';
  process.env.NB_WECHAT_SECRET = 'SECRET_PROBE_SHOULD_NOT_PERSIST';
  delete process.env.NB_WECHAT_APP_SECRET;
  resetExternalProviderHealthForTests();

  try {
    const apiModule = await uniqueImport('../server/api.js');
    apiModule.__wechatProviderHealthForTests.resetAccessTokenCache();
    let thrown = null;
    await assert.rejects(
      () => apiModule.__wechatProviderHealthForTests.sendWechatSubscribeMessage({
        openid: 'openid_network_probe_should_not_persist',
        templateId: 'wechat_template_for_test',
        data: { thing1: { value: 'NB Clan' } }
      }),
      (error) => {
        thrown = error;
        return Boolean(error);
      }
    );
    assert.equal(String(thrown?.message || '').includes('SECRET_PROBE_SHOULD_NOT_PERSIST'), false);
    assert.equal(String(thrown?.message || '').includes('wx_secret_probe_appid'), false);
    assert.equal(String(thrown?.message || '').includes('openid_network_probe_should_not_persist'), false);
  } finally {
    resetExternalProviderHealthForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
  }
});

test('Steam provider calls update health and circuit state', async () => {
  const previousEnv = {
    NB_EXTERNAL_PROVIDER_CIRCUIT_FAILURE_THRESHOLD: process.env.NB_EXTERNAL_PROVIDER_CIRCUIT_FAILURE_THRESHOLD,
    NB_EXTERNAL_PROVIDER_CIRCUIT_COOLDOWN_MS: process.env.NB_EXTERNAL_PROVIDER_CIRCUIT_COOLDOWN_MS,
    NB_STEAM_BROADCAST_REQUEST_INTERVAL_MS: process.env.NB_STEAM_BROADCAST_REQUEST_INTERVAL_MS,
    NB_STEAM_WEB_API_REQUEST_INTERVAL_MS: process.env.NB_STEAM_WEB_API_REQUEST_INTERVAL_MS
  };
  const previousFetch = globalThis.fetch;
  process.env.NB_EXTERNAL_PROVIDER_CIRCUIT_FAILURE_THRESHOLD = '2';
  process.env.NB_EXTERNAL_PROVIDER_CIRCUIT_COOLDOWN_MS = '10000';
  process.env.NB_STEAM_BROADCAST_REQUEST_INTERVAL_MS = '0';
  process.env.NB_STEAM_WEB_API_REQUEST_INTERVAL_MS = '0';
  resetExternalProviderHealthForTests();

  try {
    const {
      fetchSteamBroadcastRestriction,
      fetchSteamPlayerBans,
      fetchSteamProfile
    } = await import('../server/steam.js');
    const steamId = '76561198000001234';
    let broadcastFetches = 0;
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href === `https://steamcommunity.com/profiles/${steamId}?xml=1`) {
        return mockTextResponse([
          '<profile>',
          `<steamID64>${steamId}</steamID64>`,
          '<steamID><![CDATA[Steam Health]]></steamID>',
          '</profile>'
        ].join(''));
      }
      if (href === `https://steamcommunity.com/broadcast/getbroadcastmpd/?steamid=${steamId}`) {
        broadcastFetches += 1;
        return mockJsonResponse({ success: 'failed' }, 503);
      }
      if (href.startsWith('https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/')) {
        return mockJsonResponse({
          players: [{ SteamId: steamId, VACBanned: false, NumberOfVACBans: 0, NumberOfGameBans: 0 }]
        });
      }
      throw new Error(`unexpected fetch ${href}`);
    };

    const profile = await fetchSteamProfile(steamId);
    assert.equal(profile.nickname, 'Steam Health');
    let snapshot = externalProviderHealthSnapshot();
    assert.equal(snapshot.circuits.some((state) => state.provider === 'steam_profile' && state.succeeded === 1), true);

    await fetchSteamBroadcastRestriction(steamId);
    await fetchSteamBroadcastRestriction(steamId);
    snapshot = externalProviderHealthSnapshot();
    const broadcastState = snapshot.circuits.find((state) => state.provider === 'steam_broadcast');
    assert.equal(broadcastState.status, 'open');
    assert.equal(broadcastFetches, 2);

    const blockedBroadcast = await fetchSteamBroadcastRestriction(steamId);
    assert.match(blockedBroadcast.error, /provider circuit is open/);
    assert.equal(broadcastFetches, 2);

    const bans = await fetchSteamPlayerBans([steamId], { apiKey: 'steam_api_key_for_test' });
    assert.equal(bans.bansBySteamId.get(steamId).steamId, steamId);
    snapshot = externalProviderHealthSnapshot();
    assert.equal(snapshot.circuits.some((state) => state.provider === 'steam_web_api' && state.succeeded === 1), true);
  } finally {
    globalThis.fetch = previousFetch;
    resetExternalProviderHealthForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
  }
});
