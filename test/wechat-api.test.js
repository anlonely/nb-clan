import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const ONE_PIXEL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

async function rmTempDirWithRetry(target) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  await rm(target, { recursive: true, force: true });
}

test('wechat login and profile work while retired review routes return 410 without domain writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-wechat-api-'));
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';
  process.env.NB_DISABLE_EXTERNAL_ATLAS = '1';
  process.env.NB_RUST_KDA_BASE_URL = 'https://rust-kda.anlonely.me';
  process.env.NB_RUST_KDA_PROVIDER = 'http';
  process.env.NB_WECHAT_DEV_LOGIN = '1';
  process.env.NODE_ENV = 'production';
  const originalTemplateEnv = {
    joinReviewResult: process.env.NB_WECHAT_TEMPLATE_JOIN_REVIEW_RESULT,
    adminJoinReview: process.env.NB_WECHAT_TEMPLATE_ADMIN_JOIN_REVIEW,
    wipeOpen: process.env.NB_WECHAT_TEMPLATE_WIPE_OPEN,
    wipeReminder: process.env.NB_WECHAT_TEMPLATE_WIPE_REMINDER,
    appId: process.env.NB_WECHAT_APPID,
    appSecret: process.env.NB_WECHAT_SECRET,
    appSecretAlt: process.env.NB_WECHAT_APP_SECRET,
    apiBaseUrl: process.env.NB_WECHAT_API_BASE_URL
  };
  process.env.NB_WECHAT_TEMPLATE_JOIN_REVIEW_RESULT = 'tmpl_join_review';
  process.env.NB_WECHAT_TEMPLATE_ADMIN_JOIN_REVIEW = 'tmpl_admin_join_review';
  process.env.NB_WECHAT_TEMPLATE_WIPE_OPEN = 'tmpl_wipe_open';
  process.env.NB_WECHAT_TEMPLATE_WIPE_REMINDER = 'tmpl_wipe_reminder';
  process.env.NB_WECHAT_APPID = 'wx_test_appid';
  process.env.NB_WECHAT_SECRET = 'wechat_test_secret';

  const originalFetch = globalThis.fetch;
  const fetchUrls = [];
  const wechatSubscribeRequests = [];
  let joinInventoryGate = null;
  let wechatApiServer = null;
  globalThis.fetch = async (url, options) => {
    const href = String(url || '');
    fetchUrls.push(href);
    if (href.includes('steamcommunity.com')) {
      const steamId = href.match(/profiles\/(\d+)/)?.[1] || '76561198000000000';
      return new Response([
        '<profile>',
        `<steamID64>${steamId}</steamID64>`,
        `<steamID><![CDATA[Steam ${steamId.slice(-4)}]]></steamID>`,
        `<avatarFull><![CDATA[https://example.com/${steamId}.jpg]]></avatarFull>`,
        '<privacyState>public</privacyState>',
        '<visibilityState>3</visibilityState>',
        '</profile>'
      ].join(''), { status: 200, headers: { 'Content-Type': 'text/xml' } });
    }
    if (href.includes('/api/player/76561198000001111')) {
      return new Response(JSON.stringify({
        name: 'Steam 1111 Fresh',
        avatarFull: 'https://example.com/76561198000001111-fresh.jpg',
        profileUrl: 'https://steamcommunity.com/profiles/76561198000001111',
        playTimeMinutes: 7200,
        privacyState: 'public'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (href.includes('/api/inventory/76561198000001111')) {
      return new Response(JSON.stringify({
        inventoryAvailable: true,
        totalSummary: { currency: 'USD', totalValue: 456.78 }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (href.includes('/api/kda/76561198000001111')) {
      return new Response(JSON.stringify({
        kills: 101,
        deaths: 10,
        assists: 9,
        kda: 11,
        accuracy: 42.5,
        rockets: 13,
        sulfur: 21000,
        metalOre: 33000,
        playTimeMinutes: 780
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (href.includes('/api/player/76561198000002222')) {
      return new Response(JSON.stringify({
        name: 'Steam 2222',
        avatarFull: 'https://example.com/76561198000002222.jpg',
        profileUrl: 'https://steamcommunity.com/profiles/76561198000002222',
        playTimeMinutes: 3660,
        privacyState: 'public'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (href.includes('/api/inventory/76561198000002222')) {
      if (joinInventoryGate) {
        joinInventoryGate.markStarted();
        await joinInventoryGate.wait;
      }
      return new Response(JSON.stringify({
        inventoryAvailable: true,
        totalSummary: { currency: 'USD', totalValue: 123.45 }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (href.includes('/api/kda/76561198000002222')) {
      return new Response(JSON.stringify({
        kills: 88,
        deaths: 11,
        assists: 0,
        kda: 8,
        accuracy: 37.5,
        rockets: 9,
        sulfur: 12000,
        metalOre: 18000,
        playTimeMinutes: 540
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (href.includes('playerstatistics.vitalgamenetwork.com/players/overview')) {
      const body = JSON.parse(String(options?.body || '{}'));
      const playerId = Array.isArray(body.playerIds) ? body.playerIds[0] : '';
      if (playerId === '76561198000003333' && String(body.serverId) === '23' && body.wipeId === 'vital-wechat-current-1') {
        return new Response(JSON.stringify({
          data: [{
            player: { name: 'Vital Live', avatar: 'https://example.com/vital-live.jpg' },
            context: { userId: '76561198000003333', serverId: 23, wipeId: 'vital-wechat-current-1' },
            statistics: {
              combat: { kills: 66, killsT3: 12, deaths: 6, headshots: 21, hits: 155, shots: 310 },
              raiding: { rockets: 4, explosivesTimed: 2 },
              farming: { gathered: { 'sulfur.ore': 12345, 'metal.ore': 23456 } },
              building: { buildings: { wall: 2, foundation: 3 } }
            }
          }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (playerId === '76561198000002222' && String(body.serverId) === '23' && body.wipeId === 'vital-wechat-current-1') {
        return new Response(JSON.stringify({
          data: [{
            player: { name: 'External Vital 2222', avatar: 'https://example.com/vital-2222.jpg' },
            context: { userId: '76561198000002222', serverId: 23, wipeId: 'vital-wechat-current-1' },
            statistics: {
              combat: { kills: 77, killsT3: 18, deaths: 7, headshots: 22, hits: 166, shots: 332 },
              raiding: { rockets: 6, explosivesTimed: 3 },
              farming: { gathered: { 'sulfur.ore': 22345, 'metal.ore': 33456 } },
              building: { buildings: { wall: 4, foundation: 6 } }
            }
          }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch(url, options);
  };

  wechatApiServer = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/cgi-bin/token')) {
      res.end(JSON.stringify({ access_token: 'wechat_test_access_token', expires_in: 7200 }));
      return;
    }
    if (req.url.startsWith('/cgi-bin/message/subscribe/send')) {
      wechatSubscribeRequests.push(JSON.parse(bodyText || '{}'));
      res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ errcode: 404, errmsg: 'not found' }));
  });
  await new Promise((resolve) => wechatApiServer.listen(0, '127.0.0.1', resolve));
  process.env.NB_WECHAT_API_BASE_URL = `http://127.0.0.1:${wechatApiServer.address().port}`;

  const {
    createApiRouter,
    drainBackgroundTaskQueuesForTests,
    rustMapsImageUrlFromHtml,
    rustMapsImageUrlFromPayload,
    wechatWipeReminderSchedule
  } = await import('../server/api.js');
  const { ensureStore, hashPassword, nowIso, readStore, updateStore } = await import('../server/store.js');
  await ensureStore();
  assert.equal(
    rustMapsImageUrlFromPayload({
      imageUrl: 'https://content.rustmaps.com/maps/285/plain/map_raw_normalized.png',
      imageIconUrl: 'https://content.rustmaps.com/maps/285/icons/map_icons.png'
    }),
    'https://content.rustmaps.com/maps/285/icons/map_icons.png'
  );
  assert.equal(
    rustMapsImageUrlFromHtml([
      '<meta property="og:image" content="https://content.rustmaps.com/maps/285/example/map_raw_normalized.png">',
      '<script>window.pageData = {"data":{"imageUrl":"https://content.rustmaps.com/maps/285/abc/map_raw_normalized.png","imageIconUrl":"https://content.rustmaps.com/maps/285/abc/map_icons.png"}};</script>'
    ].join('')),
    'https://content.rustmaps.com/maps/285/abc/map_icons.png'
  );
  assert.deepEqual(
    wechatWipeReminderSchedule({ startedAt: '2026-06-21T13:30:00.000Z' }).map((item) => ({
      key: item.key,
      at: new Date(item.at).toISOString()
    })),
    [
      { key: 'two_days_20', at: '2026-06-19T12:00:00.000Z' },
      { key: 'one_day_20', at: '2026-06-20T12:00:00.000Z' },
      { key: 'same_day_20', at: '2026-06-21T12:00:00.000Z' },
      { key: 'one_hour_before', at: '2026-06-21T12:30:00.000Z' }
    ]
  );

  const app = express();
  app.use('/api', createApiRouter());
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/api`;

  async function request(url, options = {}) {
    const response = await fetch(`${baseUrl}${url}`, {
      method: options.method || 'GET',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.token ? { 'x-nb-wechat-session': options.token } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {}),
        ...(options.headers || {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const text = await response.text();
    const payload = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null;
    return { response, payload, text };
  }

  async function waitForWechatSubscribe(predicate, label) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const found = wechatSubscribeRequests.find((body, index) => predicate(body, index));
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(`未收到微信订阅消息发送请求：${label}`);
  }

  try {
    let result = await request('/wechat/access-status');
    assert.equal(result.response.status, 401);
    assert.equal(result.payload.ok, false);

    result = await request('/wechat/share-code?metric=kda');
    assert.equal(result.response.status, 401);
    assert.equal(result.payload.ok, false);

    result = await request('/wechat/login', {
      method: 'POST',
      body: {
        code: 'dev-wechat-player-1',
        profile: {
          nickname: '微信玩家',
          avatarUrl: 'https://example.com/avatar.png',
          region: 'Asia/Shanghai'
        }
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.ok, true);
    assert.ok(result.payload.sessionToken);
    assert.equal(result.payload.accessStatus.status, 'guest');
    assert.equal(result.payload.accessStatus.canEnterApp, false);
    assert.equal(result.payload.wechatUser.nickname, '微信玩家');
    const token = result.payload.sessionToken;
    assert.match(token, /^v2\./);

    result = await request('/wechat/avatar', {
      method: 'POST',
      token,
      body: {
        mimeType: 'image/png',
        originalName: 'wechat-avatar.png',
        dataUrl: `data:image/png;base64,${ONE_PIXEL_PNG_BASE64}`
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.upload.kind, 'wechat_avatar');
    assert.equal(result.payload.upload.width, 1);
    assert.equal(result.payload.upload.height, 1);
    assert.match(result.payload.wechatUser.avatarUrl, /^\/uploads\/wechat-avatars\/upload_/);

    result = await request('/wechat/avatar', {
      method: 'POST',
      token,
      body: {
        mimeType: 'image/png',
        originalName: 'fake-avatar.png',
        dataUrl: `data:image/png;base64,${Buffer.from('wechat-avatar').toString('base64')}`
      }
    });
    assert.equal(result.response.status, 400);
    assert.match(result.payload.error, /微信头像格式不支持/);

    const avatarForm = new FormData();
    avatarForm.set('avatar', new Blob([Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64')], { type: 'image/png' }), 'wechat-avatar-file.png');
    const avatarUploadResponse = await fetch(`${baseUrl}/wechat/avatar`, {
      method: 'POST',
      headers: {
        'x-nb-wechat-session': token
      },
      body: avatarForm
    });
    const avatarUploadPayload = await avatarUploadResponse.json();
    assert.equal(avatarUploadResponse.status, 200);
    assert.equal(avatarUploadPayload.upload.kind, 'wechat_avatar');
    assert.equal(avatarUploadPayload.upload.mimeType, 'image/png');
    assert.equal(avatarUploadPayload.upload.width, 1);
    assert.equal(avatarUploadPayload.upload.height, 1);
    assert.match(avatarUploadPayload.wechatUser.avatarUrl, /^\/uploads\/wechat-avatars\/upload_/);

    result = await request('/wechat/access-status', { token });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.status, 'guest');
    assert.equal(result.payload.canEnterApp, false);
    assert.match(result.payload.wechatUser.avatarUrl, /^\/uploads\/wechat-avatars\/upload_/);
    const accessStatusEtag = result.response.headers.get('etag');
    if (accessStatusEtag) {
      const cachedStatusResponse = await fetch(`${baseUrl}/wechat/access-status`, {
        headers: {
          'x-nb-wechat-session': token,
          'If-None-Match': accessStatusEtag
        }
      });
      assert.equal(cachedStatusResponse.status, 200);
      const cachedStatusPayload = await cachedStatusResponse.json();
      assert.equal(cachedStatusPayload.ok, true);
      assert.equal(cachedStatusPayload.status, 'guest');
    }

    result = await request('/wechat/notification-settings', { token });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.templates.joinReviewResult, 'tmpl_join_review');
    assert.equal(result.payload.templates.adminJoinReview, 'tmpl_admin_join_review');
    assert.equal('bindReviewResult' in result.payload.templates, false);
    assert.equal('adminBindReview' in result.payload.templates, false);
    assert.equal(result.payload.templates.wipeOpen, 'tmpl_wipe_open');
    assert.equal(result.payload.templates.wipeReminder, 'tmpl_wipe_reminder');

    result = await request('/wechat/member-specialties', { token });
    assert.equal(result.response.status, 200);
    assert.deepEqual(
      result.payload.specialties.map((item) => item.value),
      ['pvp', 'farming', 'breeding', 'electricity', 'building', 'pipe', 'gunman', 'commander', 'translator', 'logistics', 'external_lead', 'miner', 'merchant']
    );
    assert.equal(result.payload.specialties.find((item) => item.value === 'building').label, '建筑');
    assert.equal(result.payload.specialties.find((item) => item.value === 'translator').label, '翻译官');
    assert.equal(result.payload.specialties.find((item) => item.value === 'merchant').label, '商人');
    assert.equal(result.payload.specialties.some((item) => item.value === 'rich'), false);
    assert.equal(result.payload.specialties.some((item) => item.value === 'shitposter'), false);

    result = await request('/wechat/notification-settings', {
      method: 'PUT',
      token,
      body: { subscriptions: { joinReviewResult: 'accept', bindReviewResult: 'accept' } }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.subscriptions.joinReviewResult.status, 'accept');
    assert.equal('bindReviewResult' in result.payload.subscriptions, false);

    result = await request('/wechat/query?q=76561198000001111', { token });
    assert.equal(result.response.status, 403);

    let store = await readStore();
    assert.equal(store.wechatUsers.length, 1);
    assert.equal(store.wechatSessions.length, 0);
    const wechatUserId = store.wechatUsers[0].id;
    assert.equal(store.wechatUsers[0].subscriptionPreferences.joinReviewResult.status, 'accept');

    result = await request('/wechat/member-bind-requests', {
      method: 'POST',
      token,
      body: { steamInput: '76561198000001111' }
    });
    assert.equal(result.response.status, 404);
    result = await request('/wechat/member-bind-requests/me', { token });
    assert.equal(result.response.status, 404);
    result = await request('/wechat/member-bind-requests/retired-request', {
      method: 'PUT',
      token,
      body: { note: 'retired route must stay unavailable' }
    });
    assert.equal(result.response.status, 404);

    result = await request('/wechat/login', {
      method: 'POST',
      body: {
        code: 'dev-wechat-spam-join',
        profile: { nickname: '入队刷接口测试' }
      }
    });
    assert.equal(result.response.status, 200);
    const joinSpamToken = result.payload.sessionToken;
    const beforeRetired = await readStore();
    const retiredCollections = value => JSON.stringify({ members: value.members, users: value.users,
      discordMemberApplications: value.discordMemberApplications, wechatJoinApplications: value.wechatJoinApplications,
      wechatMemberBindRequests: value.wechatMemberBindRequests });
    for (const [route, method] of [
      ['/wechat/join-applications', 'POST'], ['/wechat/join-applications/me', 'GET'],
      ['/wechat/join-applications/retired-request', 'PUT'], ['/wechat/admin/join-applications', 'GET'],
      ['/wechat/admin/join-applications/retired-request/review', 'POST'],
      ['/wechat/admin/member-bind-requests/retired-request/review', 'POST']
    ]) {
      result = await request(route, { method, token: joinSpamToken,
        ...(method === 'GET' ? {} : { body: { steamInput: '76561198000001111', action: 'approve' } }) });
      assert.equal(result.response.status, 410, route);
      assert.equal(result.payload.errorCode, 'MINI_FEATURE_RETIRED', route);
    }
    assert.equal(retiredCollections(await readStore()), retiredCollections(beforeRetired));
  } finally {
    joinInventoryGate?.release?.();
    joinInventoryGate = null;
    await drainBackgroundTaskQueuesForTests({ timeoutMs: 5000 }).catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    if (wechatApiServer) {
      await new Promise((resolve) => wechatApiServer.close(resolve));
    }
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries({
      NB_WECHAT_TEMPLATE_JOIN_REVIEW_RESULT: originalTemplateEnv.joinReviewResult,
      NB_WECHAT_TEMPLATE_ADMIN_JOIN_REVIEW: originalTemplateEnv.adminJoinReview,
      NB_WECHAT_TEMPLATE_WIPE_OPEN: originalTemplateEnv.wipeOpen,
      NB_WECHAT_TEMPLATE_WIPE_REMINDER: originalTemplateEnv.wipeReminder,
      NB_WECHAT_APPID: originalTemplateEnv.appId,
      NB_WECHAT_SECRET: originalTemplateEnv.appSecret,
      NB_WECHAT_APP_SECRET: originalTemplateEnv.appSecretAlt,
      NB_WECHAT_API_BASE_URL: originalTemplateEnv.apiBaseUrl
    })) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    await rmTempDirWithRetry(dataDir);
    delete process.env.NB_RUST_KDA_BASE_URL;
    delete process.env.NB_RUST_KDA_PROVIDER;
  }
});
