import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

test('wipe workflow supports import, participant edits, history export, and closed read-only guards', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-api-'));
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';
  process.env.NB_DISABLE_EXTERNAL_ATLAS = '1';
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_TRUST_PROXY = '1';
  process.env.NB_STEAM_BROADCAST_REQUEST_INTERVAL_MS = '1';
  process.env.NB_STEAM_WEB_API_KEY = 'test-steam-web-api-key';
  process.env.NB_STEAM_WEB_API_REQUEST_INTERVAL_MS = '1';
  process.env.NB_BATTLEMETRICS_MIN_INTERVAL_MS = '1';
  process.env.NB_RUST_KDA_BASE_URL = 'https://rust-kda.anlonely.me';
  process.env.NB_RUST_KDA_PROVIDER = 'http';
  process.env.NB_RUST_KDA_REQUEST_TIMEOUT_MS = '100';
  process.env.NB_RUST_KDA_INVENTORY_REQUEST_TIMEOUT_MS = '100';
  process.env.NB_RUST_KDA_INVENTORY_CACHE_TTL_MS = '1000';
  process.env.NB_VITAL_KDA_BATCH_SIZE = '50';
  process.env.NB_KDA_INLINE_SYNC_MAX_PARTICIPANTS = '1000';
  process.env.NB_DISCORD_KDA_AUTO_DELETE_MS = '15';
  process.env.NB_DISCORD_MEMBER_RANKING_AUTO_DELETE_MS = '15';
  process.env.NB_DISCORD_WIPE_ATTENDANCE_REFRESH_DEBOUNCE_MS = '5';
  process.env.NB_BATTLEMETRICS_SESSION_PAGE_LIMIT = '1';
  process.env.NODE_ENV = 'production';
  delete process.env.NB_COOKIE_SECURE;

  let discordRequest = null;
  const discordRequests = [];
  const discordMessageEdits = [];
  const discordCommandRequests = [];
  const discordFollowups = [];
  const discordDeletedInteractionMessages = [];
  const discordDmChannelRequests = [];
  const discordDirectMessages = [];
  const discordOAuthTokenRequests = [];
  const discordOAuthUsers = new Map();
  const discordOAuthTokens = new Map();
  const discordGuildMembers = new Map();
  const discordGuildMemberRequests = [];
  let discordGuildRoles = [
    { id: '123456789012345673', name: 'PVP Squad' },
    { id: '123456789012345697', name: 'Builder Squad' },
    { id: '123456789012345698', name: 'Unassigned Role' }
  ];
  let discordMetadataUnavailable = false;
  const discordApp = express();
  discordApp.use(express.json());
  discordApp.use(express.urlencoded({ extended: false }));
  discordApp.post('/oauth2/token', (req, res) => {
    discordOAuthTokenRequests.push({
      authorization: req.get('authorization') || '',
      body: req.body
    });
    const user = discordOAuthUsers.get(req.body?.code || '');
    if (!user) {
      res.status(400).json({ error: 'invalid_grant' });
      return;
    }
    const accessToken = `discord_token_${discordOAuthTokenRequests.length}`;
    discordOAuthTokens.set(accessToken, user);
    res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'identify'
    });
  });
  discordApp.get('/users/@me', (req, res) => {
    const token = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const user = discordOAuthTokens.get(token);
    if (!user) {
      res.status(401).json({ message: 'invalid token' });
      return;
    }
    res.json(user);
  });
  discordApp.get('/guilds/:guildId/members/:userId', (req, res) => {
    discordGuildMemberRequests.push({
      guildId: req.params.guildId,
      userId: req.params.userId,
      authorization: req.get('authorization') || ''
    });
    const member = discordGuildMembers.get(`${req.params.guildId}:${req.params.userId}`);
    if (!member) {
      res.status(404).json({ message: 'Unknown Member' });
      return;
    }
    res.json({
      user: {
        id: req.params.userId,
        username: member.username || `User${req.params.userId.slice(-4)}`,
        global_name: member.globalName || null
      },
      nick: member.nick || null,
      roles: member.roles || []
    });
  });
  discordApp.get('/guilds/:guildId/roles', (req, res) => {
    if (discordMetadataUnavailable) {
      res.status(403).json({ message: 'metadata unavailable' });
      return;
    }
    res.json(discordGuildRoles);
  });
  discordApp.get('/guilds/:guildId/channels', (req, res) => {
    if (discordMetadataUnavailable) {
      res.status(403).json({ message: 'metadata unavailable' });
      return;
    }
    res.json([
      { id: '123456789012345671', name: 'wipe-attendance' },
      { id: '123456789012345686', name: 'map-push' },
      { id: '123456789012345687', name: 'member-ranking' }
    ]);
  });
  discordApp.post('/users/@me/channels', (req, res) => {
    discordDmChannelRequests.push({
      authorization: req.get('authorization') || '',
      body: req.body
    });
    res.json({
      id: `dm_${req.body?.recipient_id || 'unknown'}`,
      type: 1,
      recipients: [{ id: req.body?.recipient_id || '' }]
    });
  });
  discordApp.post('/channels/:channelId/messages', (req, res) => {
    if (req.params.channelId.startsWith('dm_')) {
      discordDirectMessages.push({
        channelId: req.params.channelId,
        authorization: req.get('authorization') || '',
        body: req.body
      });
      res.json({
        id: `direct_${discordDirectMessages.length}`,
        channel_id: req.params.channelId
      });
      return;
    }
    discordRequest = {
      channelId: req.params.channelId,
      authorization: req.get('authorization') || '',
      body: req.body
    };
    discordRequests.push(discordRequest);
    res.json({
      id: '123456789012345678',
      channel_id: req.params.channelId
    });
  });
  discordApp.patch('/channels/:channelId/messages/:messageId', (req, res) => {
    const edit = {
      channelId: req.params.channelId,
      messageId: req.params.messageId,
      authorization: req.get('authorization') || '',
      body: req.body
    };
    discordMessageEdits.push(edit);
    if (req.params.messageId === '123456789012345700') {
      res.status(404).json({ message: 'Unknown Message' });
      return;
    }
    res.json({
      id: req.params.messageId,
      channel_id: req.params.channelId,
      ...req.body
    });
  });
  discordApp.post('/applications/:applicationId/guilds/:guildId/commands', (req, res) => {
    discordCommandRequests.push({
      applicationId: req.params.applicationId,
      guildId: req.params.guildId,
      authorization: req.get('authorization') || '',
      body: req.body
    });
    res.json({
      id: '123456789012345679',
      application_id: req.params.applicationId,
      guild_id: req.params.guildId,
      name: req.body?.name || '',
      type: req.body?.type || 1
    });
  });
  discordApp.post('/webhooks/:applicationId/:token', (req, res) => {
    discordFollowups.push({
      applicationId: req.params.applicationId,
      token: req.params.token,
      body: req.body
    });
    res.json({ id: `followup_${discordFollowups.length}` });
  });
  discordApp.delete('/webhooks/:applicationId/:token/messages/@original', (req, res) => {
    discordDeletedInteractionMessages.push({
      applicationId: req.params.applicationId,
      token: req.params.token
    });
    res.status(204).end();
  });
  const discordServer = createServer(discordApp);
  await new Promise((resolve) => discordServer.listen(0, '127.0.0.1', resolve));
  const discordPort = discordServer.address().port;
  process.env.NB_DISCORD_API_BASE_URL = `http://127.0.0.1:${discordPort}`;
  process.env.NB_DISCORD_OAUTH_CLIENT_ID = 'discord_oauth_client_test';
  process.env.NB_DISCORD_OAUTH_CLIENT_SECRET = 'discord_oauth_secret_test';

  const kookPosts = [];
  const kookUpdates = [];
  const kookDeletes = [];
  const kookMessages = [];
  const failingKookDeleteMessageIds = new Set();
  const kookApp = express();
  kookApp.use(express.json());
  kookApp.get('/api/v3/message/list', (req, res) => {
    const targetId = String(req.query.target_id || '');
    res.json({
      code: 0,
      message: '操作成功',
      data: {
        items: kookMessages.filter((message) => !targetId || message.target_id === targetId)
      }
    });
  });
  kookApp.post('/api/v3/message/create', (req, res) => {
    const msgId = `kook_message_${kookPosts.length + 1}`;
    const record = {
      authorization: req.get('authorization') || '',
      body: req.body
    };
    kookPosts.push(record);
    kookMessages.push({
      id: msgId,
      msg_id: msgId,
      target_id: req.body?.target_id || '',
      type: req.body?.type,
      content: req.body?.content || '',
      create_at: Date.now()
    });
    res.json({
      code: 0,
      message: '操作成功',
      data: {
        msg_id: msgId,
        msg_timestamp: Date.now()
      }
    });
  });
  kookApp.post('/api/v3/message/update', (req, res) => {
    const record = {
      authorization: req.get('authorization') || '',
      body: req.body
    };
    kookUpdates.push(record);
    const message = kookMessages.find((item) => item.id === req.body?.msg_id || item.msg_id === req.body?.msg_id);
    if (message) message.content = req.body?.content || message.content || '';
    res.json({
      code: 0,
      message: '操作成功',
      data: {
        msg_id: req.body?.msg_id || '',
        msg_timestamp: Date.now()
      }
    });
  });
  kookApp.post('/api/v3/message/delete', (req, res) => {
    const record = {
      authorization: req.get('authorization') || '',
      body: req.body
    };
    kookDeletes.push(record);
    if (failingKookDeleteMessageIds.has(String(req.body?.msg_id || ''))) {
      res.json({
        code: 500,
        message: 'injected delete failure',
        data: null
      });
      return;
    }
    const index = kookMessages.findIndex((message) => message.id === req.body?.msg_id || message.msg_id === req.body?.msg_id);
    if (index >= 0) kookMessages.splice(index, 1);
    res.json({
      code: 0,
      message: '操作成功',
      data: []
    });
  });
  const kookServer = createServer(kookApp);
  await new Promise((resolve) => kookServer.listen(0, '127.0.0.1', resolve));
  const kookPort = kookServer.address().port;
  process.env.NB_KOOK_API_BASE_URL = `http://127.0.0.1:${kookPort}/api/v3`;

  const { createApiRouter, battlemetricsAutoSyncTargets, drainBackgroundTaskQueuesForTests, kdaAutoSyncTargets, reconcileActiveSyncWork, sendDueDiscordVitalVipReminders, syncMissingDiscordMemberReviewCards } = await import('../server/api.js');
  const { __mooseStatsProviderForTests } = await import('../server/moose-stats-provider.js');
  const { ensureStore, hashPassword, nowIso, readStore, updateStore } = await import('../server/store.js');
  __mooseStatsProviderForTests.setPeriodQueryImplementation(async (server) => ({
    source: 'https://moose.gg/stats',
    server: { ...server, active: true },
    periods: [
      { id: 'all-time', name: 'All Time', nameZh: '全部时间', active: true },
      { id: '2026-07-30', name: '07/30/2026 18:00:00', nameZh: '07/30/2026 18:00:00', active: false }
    ],
    categories: []
  }));
  __mooseStatsProviderForTests.setQueryImplementation(async (params) => ({
    source: 'https://moose.gg/stats',
    server: { ...params.server, active: true },
    period: { id: 'all-time', name: params.period, nameZh: '全部时间', active: true },
    identity: {
      playerName: 'Workflow Moose Player',
      avatar: 'https://example.com/moose-player.png',
      playerUrl: `https://steamcommunity.com/profiles/${params.steamId}`,
      steamId: params.steamId
    },
    categories: [{
      category: { id: 'pvp', name: 'PvP', nameZh: '玩家对战', active: true },
      fields: [
        { id: 'kdr', name: 'KDR', labelZh: 'K/D', categoryId: 'pvp', kind: 'text' },
        { id: 'hqm', name: 'HQM', labelZh: '高金', categoryId: 'pvp', kind: 'text' }
      ],
      matchCount: 1,
      exactMatchCount: 1,
      selectedMatch: {
        rank: 1,
        playerName: 'Workflow Moose Player',
        avatar: 'https://example.com/moose-player.png',
        playerUrl: `https://steamcommunity.com/profiles/${params.steamId}`,
        steamId: params.steamId,
        values: { kdr: '2.50', hqm: '12,000' }
      },
      matches: []
    }],
    matchedCategories: 1
  }));
  await ensureStore();

  const discordAttendanceFieldName = (field) => String(field?.name || '').replace(/^[\u00A0\u2800\u3164]+|[\u00A0\u2800\u3164]+$/g, '');
  const findDiscordAttendanceField = (fields, name) => (
    Array.isArray(fields) ? fields.find((field) => discordAttendanceFieldName(field) === name) : null
  );

  await assert.rejects(
    updateStore((store) => {
      store.members.push({
        id: 'member_failed_update_leak',
        steamId: '76561198000009998',
        rawInput: '76561198000009998',
        customName: 'Failed Update Leak',
        createdAt: nowIso(),
        updatedAt: nowIso()
      });
      throw new Error('simulated failed update');
    }),
    /simulated failed update/
  );
  assert.equal((await readStore()).members.some((member) => member.id === 'member_failed_update_leak'), false);

  await updateStore(async (store) => {
    const createdAt = nowIso();
    store.users.push({
      id: 'user_leader_test',
      username: 'leader_test',
      role: 'leader',
      passwordHash: await hashPassword('LeaderPass123!'),
      boundSteamId: '76561198000009999',
      steamNickname: 'Leader Test',
      createdAt,
      updatedAt: createdAt,
      createdBy: 'user_root'
    });
    store.users.push({
      id: 'user_leader_other',
      username: 'leader_other',
      role: 'leader',
      passwordHash: await hashPassword('LeaderPass123!'),
      boundSteamId: '76561198000008888',
      steamNickname: 'Other Leader',
      createdAt,
      updatedAt: createdAt,
      createdBy: 'user_root'
    });
    store.members.push({
      id: 'member_test_1',
      steamId: '76561198000000001',
      rawInput: '76561198000000001',
      customName: 'Alpha',
      steamNickname: 'AlphaSteam',
      avatar: 'https://avatars.steamstatic.com/alpha-member_full.jpg',
      discordId: '',
      wechatId: '',
      notes: '',
      specialty: 'building',
      invitedByUserId: 'user_leader_test',
      createdAt,
      updatedAt: createdAt
    });
    store.members.push({
      id: 'member_test_2',
      steamId: '76561198000000004',
      rawInput: '76561198000000004',
      customName: 'Bravo',
      steamNickname: 'BravoSteam',
      avatar: '',
      discordId: '',
      wechatId: '',
      notes: '',
      specialty: ['farming'],
      invitedByUserId: 'user_leader_other',
      createdAt,
      updatedAt: createdAt
    });
    store.members.push({
      id: 'member_test_3',
      steamId: '76561198000000005',
      rawInput: '76561198000000005',
      customName: 'Squad Only',
      steamNickname: 'SquadOnlySteam',
      avatar: '',
      discordId: '',
      wechatId: '',
      notes: '',
      specialty: [],
      invitedByUserId: 'user_leader_test',
      createdAt,
      updatedAt: createdAt
    });
    store.members.push({
      id: 'member_test_4',
      steamId: '76561198000000008',
      rawInput: '76561198000000008',
      customName: 'Unassigned',
      steamNickname: 'UnassignedSteam',
      avatar: '',
      discordId: '',
      wechatId: '',
      notes: '',
      specialty: [],
      invitedByUserId: 'user_leader_other',
      createdAt,
      updatedAt: createdAt
    });
    store.squads.push({
      id: 'squad_test_1',
      name: 'Alpha Squad',
      leaderUserId: 'user_leader_test',
      notes: '',
      createdBy: 'user_root',
      createdAt,
      updatedAt: createdAt,
      archivedAt: ''
    });
    store.squads.push({
      id: 'squad_test_2',
      name: 'Bravo Squad',
      leaderUserId: 'user_leader_other',
      leaderUserIds: ['user_leader_other'],
      notes: '',
      createdBy: 'user_root',
      createdAt,
      updatedAt: createdAt,
      archivedAt: ''
    });
    store.squadMembers.push({
      id: 'squad_member_test_1',
      squadId: 'squad_test_1',
      memberId: 'member_test_1',
      addedByUserId: 'user_root',
      createdAt
    });
    store.squadMembers.push({
      id: 'squad_member_test_2',
      squadId: 'squad_test_2',
      memberId: 'member_test_2',
      addedByUserId: 'user_root',
      createdAt
    });
    store.squadMembers.push({
      id: 'squad_member_test_3',
      squadId: 'squad_test_1',
      memberId: 'member_test_3',
      addedByUserId: 'user_root',
      createdAt
    });
  });

  const app = express();
  app.set('trust proxy', 'loopback');
  app.use('/api', createApiRouter());
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/api`;
  let cookie = '';
  let lastSetCookie = '';

  async function request(url, options = {}) {
    const response = await fetch(`${baseUrl}${url}`, {
      method: options.method || 'GET',
      redirect: options.redirect || 'follow',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.ip ? { 'X-Forwarded-For': options.ip } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(options.headers || {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      lastSetCookie = setCookie;
      cookie = setCookie.split(';')[0];
    }
    const text = await response.text();
    const payload = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null;
    return { response, payload, text };
  }

  function encryptKookTestPayload(payload = {}, encryptKey = '') {
    const iv = '1234567890abcdef';
    const key = Buffer.alloc(32);
    Buffer.from(String(encryptKey || '')).copy(key, 0, 0, Math.min(Buffer.byteLength(String(encryptKey || '')), 32));
    const cipher = crypto.createCipheriv('aes-256-cbc', key, Buffer.from(iv));
    const encryptedBody = Buffer.concat([
      cipher.update(JSON.stringify(payload), 'utf8'),
      cipher.final()
    ]).toString('base64');
    return Buffer.from(`${iv}${encryptedBody}`, 'utf8').toString('base64');
  }

  async function waitForSyncState(kind, options = {}) {
    const attempts = options.attempts ?? (kind === 'memberProfiles' ? 180 : 80);
    const delayMs = options.delayMs ?? 100;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const result = await request(`/sync-status?kind=${encodeURIComponent(kind)}`);
      const state = result.payload?.syncState?.[kind] || {};
      if (state.status && state.status !== 'running') return state;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error(`Timed out waiting for ${kind} sync`);
  }

  async function waitForStoreCondition(predicate, { attempts = 80, delayMs = 50, label = 'store condition' } = {}) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const store = await readStore();
      const result = await predicate(store);
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  async function waitForDiscordRequest(predicate, { attempts = 80, delayMs = 50 } = {}) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const matched = discordRequests.find((request) => predicate(request));
      if (matched) return matched;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error('Timed out waiting for Discord request');
  }

  async function waitForDiscordDirectMessage(predicate, { attempts = 80, delayMs = 50 } = {}) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const message = discordDirectMessages.find(predicate);
      if (message) return message;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error('Timed out waiting for Discord direct message');
  }

  async function waitForDiscordFollowup(predicate, { attempts = 80, delayMs = 50 } = {}) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const message = discordFollowups.find(predicate);
      if (message) return message;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error('Timed out waiting for Discord followup');
  }

  async function waitForDiscordMessageEdit(predicate, { attempts = 80, delayMs = 50 } = {}) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const edit = discordMessageEdits.find(predicate);
      if (edit) return edit;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error('Timed out waiting for Discord message edit');
  }

  function discordInteractionMessageFromRecord(record) {
    return {
      id: record?.messageId || '123456789012345678',
      channel_id: record?.channelId || '',
      ...(record?.body || {})
    };
  }

  async function waitForKookPost(predicate, { attempts = 80, delayMs = 50 } = {}) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const post = kookPosts.find(predicate);
      if (post) return post;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error('Timed out waiting for KOOK post');
  }

  async function waitForKookUpdate(predicate, { attempts = 80, delayMs = 50 } = {}) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const update = kookUpdates.find(predicate);
      if (update) return update;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error('Timed out waiting for KOOK update');
  }

  async function waitForDiscordApplication(predicate, { attempts = 80, delayMs = 50 } = {}) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const store = await readStore();
      const application = (store.discordMemberApplications || []).find(predicate);
      if (application) return application;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error('Timed out waiting for Discord member application');
  }

  try {
    let result = await request('/moose/servers');
    assert.equal(result.response.status, 401);
    result = await request('/auth/login', { method: 'POST', body: { username: 'root', password: 'RootPass123!' } });
    assert.equal(result.response.status, 200);
    assert.doesNotMatch(lastSetCookie, /;\s*Secure\b/);
    const initialRootCookie = cookie;

    result = await request('/users', { method: 'POST', body: { username: 'ab', password: 'ShortName123!', role: 'member_manager' } });
    assert.equal(result.response.status, 200);
    assert.equal(Boolean(result.payload.users.find((user) => user.username === 'ab')), true);

    result = await request('/users', { method: 'POST', body: { username: 'logo_admin', password: 'AdminLogo123!', role: 'admin' } });
    assert.equal(result.response.status, 200);
    assert.equal(Boolean(result.payload.users.find((user) => user.username === 'logo_admin')), true);

    result = await request('/users', { method: 'POST', body: { username: 'readonly_viewer', password: 'ViewerPass123!', role: 'viewer' } });
    assert.equal(result.response.status, 200);
    const readonlyViewer = result.payload.users.find((user) => user.username === 'readonly_viewer');
    assert.equal(readonlyViewer.role, 'viewer');

    result = await request('/users', {
      method: 'POST',
      body: {
        username: 'web_member',
        password: 'MemberPass123!',
        role: 'member'
      }
    });
    assert.equal(result.response.status, 200);
    const webMemberUser = result.payload.users.find((user) => user.username === 'web_member');
    assert.equal(webMemberUser.role, 'member');
    assert.equal(webMemberUser.boundSteamId, '');

    result = await request('/users', { method: 'POST', body: { username: 'a', password: 'ShortName123!', role: 'member_manager' } });
    assert.equal(result.response.status, 400);
    assert.equal(result.payload.error, '账号只能包含 2-32 位字母、数字、下划线、点和短横线');

    result = await request('/users', { method: 'POST', body: { username: 'bad space', password: 'ShortName123!', role: 'member_manager' } });
    assert.equal(result.response.status, 400);
    assert.equal(result.payload.error, '账号只能包含 2-32 位字母、数字、下划线、点和短横线');

    result = await request('/users', { method: 'POST', body: { username: 'a'.repeat(33), password: 'ShortName123!', role: 'member_manager' } });
    assert.equal(result.response.status, 400);
    assert.equal(result.payload.error, '账号只能包含 2-32 位字母、数字、下划线、点和短横线');

    result = await request('/users/user_root', { method: 'PUT', body: { role: 'member_manager' } });
    assert.equal(result.response.status, 400);
    assert.equal(result.payload.error, '不能修改 root 权限');

    result = await request('/users');
    assert.equal(result.response.status, 200);
    const rootUser = result.payload.users.find((user) => user.username === 'root');
    assert.equal(rootUser.role, 'admin');
    assert.equal(rootUser.isRoot, true);

    result = await request('/permissions');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.modules.some((module) => module.id === 'permissions'), true);
    assert.equal(result.payload.modules.some((module) => module.id === 'departedMembers' && module.labelKey === 'navDepartedMembers'), true);
    assert.equal(result.payload.roles.some((role) => role.code === 'admin' && role.builtIn), true);
    const viewerPreset = result.payload.roles.find((role) => role.code === 'viewer');
    result = await request('/permissions/roles/viewer', {
      method: 'PUT',
      body: {
        name: viewerPreset.name,
        description: 'Read only preset',
        permissions: viewerPreset.permissions
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.roles.find((role) => role.code === 'viewer')?.description, 'Read only preset');

    result = await request('/permissions/roles', {
      method: 'POST',
      body: {
        code: 'account_reader',
        name: 'Account reader',
        permissions: {
          users: { view: true },
          permissions: { view: true }
        }
      }
    });
    assert.equal(result.response.status, 200);
    const accountReaderRole = result.payload.roles.find((role) => role.code === 'account_reader');
    assert.equal(accountReaderRole.builtIn, false);
    assert.equal(accountReaderRole.permissions.users.view, true);
    assert.equal(accountReaderRole.permissions.users.edit, false);

    result = await request('/permissions/roles', {
      method: 'POST',
      body: {
        code: 'departed_auditor',
        name: 'Departed auditor',
        permissions: {
          departedMembers: { view: true, edit: true },
          members: { view: false, edit: false }
        }
      }
    });
    assert.equal(result.response.status, 200);
    const departedAuditorRole = result.payload.roles.find((role) => role.code === 'departed_auditor');
    assert.equal(departedAuditorRole.permissions.departedMembers.view, true);
    assert.equal(departedAuditorRole.permissions.departedMembers.edit, true);
    assert.equal(departedAuditorRole.permissions.members.view, false);

    result = await request('/users', { method: 'POST', body: { username: 'account_reader_user', password: 'ReaderPass123!', role: 'account_reader' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.users.find((user) => user.username === 'account_reader_user')?.role, 'account_reader');

    result = await request('/users', { method: 'POST', body: { username: 'departed_auditor_user', password: 'DepartedPass123!', role: 'departed_auditor' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.users.find((user) => user.username === 'departed_auditor_user')?.role, 'departed_auditor');

    cookie = '';
    result = await request('/auth/login', { method: 'POST', body: { username: 'account_reader_user', password: 'ReaderPass123!' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.user.permissions.users.view, true);
    assert.equal(result.payload.user.permissions.users.edit, false);
    result = await request('/users');
    assert.equal(result.response.status, 200);
    result = await request('/users', { method: 'POST', body: { username: 'blocked_create', password: 'BlockedPass123!', role: 'member' } });
    assert.equal(result.response.status, 403);
    result = await request('/permissions');
    assert.equal(result.response.status, 403);
    assert.equal(result.payload.error, '只有 root 可以管理权限');
    result = await request('/permissions/roles', {
      method: 'POST',
      body: {
        code: 'blocked_role',
        name: 'Blocked role',
        permissions: { users: { view: true } }
      }
    });
    assert.equal(result.response.status, 403);
    assert.equal(result.payload.error, '只有 root 可以管理权限');
    cookie = '';
    result = await request('/auth/login', { method: 'POST', ip: '10.10.99.2', body: { username: 'departed_auditor_user', password: 'DepartedPass123!' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.user.permissions.departedMembers.view, true);
    assert.equal(result.payload.user.permissions.departedMembers.edit, true);
    assert.equal(result.payload.user.permissions.members.view, false);
    result = await request('/discord/member-audit');
    assert.equal(result.response.status, 200);
    assert.equal(Array.isArray(result.payload.candidates), true);
    cookie = initialRootCookie;

    result = await request('/permissions/roles', {
      method: 'POST',
      body: {
        code: 'squad_operator',
        name: 'Squad operator',
        permissions: {
          squads: { view: true, edit: true }
        }
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.roles.find((role) => role.code === 'squad_operator')?.permissions.squads.edit, true);
    result = await request('/users', { method: 'POST', body: { username: 'squad_operator_user', password: 'SquadPass123!', role: 'squad_operator' } });
    assert.equal(result.response.status, 200);
    cookie = '';
    result = await request('/auth/login', { method: 'POST', ip: '10.10.99.1', body: { username: 'squad_operator_user', password: 'SquadPass123!' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.user.permissions.squads.edit, true);
    result = await request('/squads');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.squads.find((squad) => squad.id === 'squad_test_2')?.canManage, true);
    result = await request('/squads/squad_test_2/members');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.squad.id, 'squad_test_2');
    result = await request('/squads/squad_test_2/candidates');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.members.some((member) => member.id === 'member_test_4'), true);
    result = await request('/squads/squad_test_2', {
      method: 'PUT',
      body: { name: 'Bravo Squad', notes: 'Squad operator note', leaderUserIds: ['user_leader_other'] }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.squads.find((squad) => squad.id === 'squad_test_2')?.notes, 'Squad operator note');
    cookie = initialRootCookie;

    cookie = '';
    result = await request('/auth/login', { method: 'POST', body: { username: 'readonly_viewer', password: 'ViewerPass123!' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.user.role, 'viewer');
    result = await request('/members');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.members.some((member) => member.id === 'member_test_2'), true);
    assert.equal(result.payload.members.find((member) => member.id === 'member_test_2').canManage, false);
    result = await request('/squads');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.squads.some((squad) => squad.id === 'squad_test_2'), true);
    result = await request('/wipes');
    assert.equal(result.response.status, 200);
    assert.equal(Array.isArray(result.payload.wipes), true);
    result = await request('/users');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.users.some((user) => user.username === 'root'), true);
    result = await request('/logs');
    assert.equal(result.response.status, 200);
    assert.equal(Array.isArray(result.payload.logs), true);
    assert.equal(Array.isArray(result.payload.logTypeGroups), true);
    assert.equal(result.payload.logTypeGroups.includes('access'), true);
    result = await request('/logs?typeGroup=access&from=2000-01-01T00%3A00%3A00.000Z&to=2100-01-01T00%3A00%3A00.000Z');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.logs.length > 0, true);
    assert.equal(result.payload.logs.every((log) => ['login', 'login_failed', 'query', 'query_failed', 'public_api_query'].includes(log.type)), true);
    result = await request('/logs?from=2000-01-01T00%3A00%3A00.000Z');
    assert.equal(result.response.status, 200);
    assert.equal(Array.isArray(result.payload.logs), true);
    result = await request('/wechat/admin/members?limit=5');
    assert.equal(result.response.status, 200);
    assert.equal(Array.isArray(result.payload.members), true);
    result = await request('/third-party/admin/discord-member-applications?status=pending');
    assert.equal(result.response.status, 200);
    assert.equal(Array.isArray(result.payload.applications), true);
    result = await request('/query', { method: 'POST', ip: '10.10.0.9', body: { steamInput: '76561198000000001' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.isMember, true);
    result = await request('/members', { method: 'POST', body: { steamInput: '76561198000006666' } });
    assert.equal(result.response.status, 403);
    assert.equal(result.payload.error, '只读账号只能查看和查询');
    result = await request('/profile', { method: 'PUT', body: { boundSteamInput: '76561198000006666' } });
    assert.equal(result.response.status, 403);
    assert.equal(result.payload.error, '只读账号只能查看和查询');
    cookie = initialRootCookie;

    const publicApiToken = 'nb_public_token_123456789';
    const storedSteamWebApiKey = 'steam_web_api_key_1234567890';
    result = await request('/settings/public-api');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.publicApi.enabled, false);
    assert.equal(result.payload.publicApi.endpoint, '/api/integrations/public-query');
    result = await request('/settings/api');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.publicApi.enabled, false);
    assert.equal(result.payload.battlemetrics.enabled, false);
    assert.equal(result.payload.steamWebApi.enabled, true);
    assert.equal(result.payload.steamWebApi.source, 'env');
    assert.equal(result.payload.steamWebApi.envConfigured, true);
    assert.equal(result.payload.steamWebApi.storeConfigured, false);
    assert.equal(result.payload.steamWebApi.masked, '********');
    assert.equal(result.payload.kook.enabled, false);
    assert.equal(result.payload.kook.eventEndpoint, '/api/integrations/kook/events');
    assert.equal(typeof result.payload.battlemetricsQueue.pendingCount, 'number');
    assert.equal(typeof result.payload.battlemetricsQueue.limits.globalPerMinute, 'number');

    result = await request('/permissions/roles', {
      method: 'POST',
      body: {
        code: 'kook_operator',
        name: 'KOOK operator',
        permissions: {
          kookBot: { view: true, edit: true }
        }
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.modules.some((module) => module.id === 'kookBot'), true);
    result = await request('/users', { method: 'POST', body: { username: 'kook_operator_user', password: 'KookPass123!', role: 'kook_operator' } });
    assert.equal(result.response.status, 200);
    cookie = '';
    result = await request('/auth/login', { method: 'POST', body: { username: 'kook_operator_user', password: 'KookPass123!' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.user.permissions.kookBot.edit, true);
    assert.equal(result.payload.user.permissions.discordBot.view, false);
    result = await request('/settings/api');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.kook.eventEndpoint, '/api/integrations/kook/events');
    assert.equal(Object.hasOwn(result.payload, 'publicApi'), false);
    assert.equal(Object.hasOwn(result.payload, 'battlemetrics'), false);
    assert.equal(Object.hasOwn(result.payload, 'discord'), false);
    result = await request('/settings/kook', { method: 'PUT', body: { botToken: 'short' } });
    assert.equal(result.response.status, 400);
    assert.match(result.payload.error, /KOOK Bot Token length/);
    result = await request('/settings/discord', { method: 'PUT', body: { botToken: 'discord_bot_token_1234567890' } });
    assert.equal(result.response.status, 403);
    cookie = initialRootCookie;

    const minimalCreateFetch = globalThis.fetch;
    const minimalCreateSteamId = '76561198000004444';
    globalThis.fetch = async (url, options = {}) => {
      if (String(url) === `https://steamcommunity.com/profiles/${minimalCreateSteamId}?xml=1`) {
        return new Response([
          '<profile>',
          `<steamID64>${minimalCreateSteamId}</steamID64>`,
          '<steamID>Minimal Create</steamID>',
          '<avatarFull>https://cdn.example.com/minimal-create.jpg</avatarFull>',
          '</profile>'
        ].join(''), { status: 200, headers: { 'content-type': 'text/xml' } });
      }
      return minimalCreateFetch(url, options);
    };
    try {
      result = await request('/members?response=minimal', {
        method: 'POST',
        body: { steamInput: minimalCreateSteamId, squadId: 'squad_test_1' }
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.member.steamId, minimalCreateSteamId);
      assert.equal(result.payload.member.squadId, 'squad_test_1');
      assert.equal(result.payload.syncQueued, 0);
      assert.equal(Object.hasOwn(result.payload, 'members'), false);
      const minimalStore = await readStore();
      const minimalMember = minimalStore.members.find((member) => member.steamId === minimalCreateSteamId);
      assert.equal(Boolean(minimalMember), true);
      assert.equal(minimalStore.squadMembers.some((item) => item.memberId === minimalMember.id && item.squadId === 'squad_test_1'), true);
    } finally {
      globalThis.fetch = minimalCreateFetch;
    }

    result = await request('/settings/battlemetrics/queue');
    assert.equal(result.response.status, 200);
    assert.equal(typeof result.payload.battlemetricsQueue.limits.manualReservePerMinute, 'number');
    result = await request('/sync/auto-rules');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.rules.some((rule) => rule.id === 'auto_rule_kda_current_wipe'), true);
    assert.equal(result.payload.options.types.some((option) => option.value === 'kda'), true);
    result = await request('/sync/auto-rules', {
      method: 'POST',
      body: {
        name: '测试自动任务',
        type: 'member_profile',
        enabled: false,
        intervalMinutes: 30,
        scope: 'missing_only',
        notes: '测试规则'
      }
    });
    assert.equal(result.response.status, 200);
    const autoRuleId = result.payload.rules.find((rule) => rule.name === '测试自动任务')?.id;
    assert.equal(Boolean(autoRuleId), true);
    result = await request(`/sync/auto-rules/${autoRuleId}`, {
      method: 'PUT',
      body: {
        name: '测试自动任务更新',
        type: 'member_profile',
        enabled: true,
        intervalMinutes: 45,
        scope: 'all_members',
        notes: '已更新'
      }
    });
    assert.equal(result.response.status, 200);
    const updatedAutoRule = result.payload.rules.find((rule) => rule.id === autoRuleId);
    assert.equal(updatedAutoRule.name, '测试自动任务更新');
    assert.equal(updatedAutoRule.enabled, true);
    assert.equal(updatedAutoRule.intervalMinutes, 45);
    result = await request(`/sync/auto-rules/${autoRuleId}`, { method: 'DELETE' });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.deleted, 1);
    assert.equal(result.payload.rules.some((rule) => rule.id === autoRuleId), false);
    await updateStore(async (store) => {
      store.syncJobs.unshift({
        id: 'sync_job_stale_test',
        type: 'kda',
        source: 'manual',
        scope: 'kda',
        status: 'running',
        targetWipeId: 'wipe_stale_test',
        targetServerId: '',
        targetServerName: '',
        totalCount: 2,
        doneCount: 1,
        failedCount: 0,
        skippedCount: 0,
        percent: 50,
        etaSeconds: 120,
        startedAt: '2000-01-01T00:00:00.000Z',
        finishedAt: '',
        createdBy: 'user_root',
        errorSummary: '',
        details: {},
        createdAt: '2000-01-01T00:00:00.000Z',
        updatedAt: '2000-01-01T00:00:00.000Z'
      });
    });
    result = await request('/sync/jobs/recent?limit=3');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.current.some((job) => job.id === 'sync_job_stale_test'), false);
    const staleJob = result.payload.recent.find((job) => job.id === 'sync_job_stale_test');
    assert.equal(staleJob.status, 'failed');
    assert.equal(staleJob.failedCount, 1);
    assert.match(staleJob.errorSummary, /长时间未更新/);
    result = await request('/sync/jobs/sync_job_stale_test', { method: 'DELETE' });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.deleted, 1);
    assert.equal(result.payload.recent.some((job) => job.id === 'sync_job_stale_test'), false);
    await updateStore((store) => {
      store.syncJobs.unshift({
        id: 'sync_job_restart_interrupted_test',
        type: 'kda',
        source: 'auto',
        scope: 'kda',
        status: 'running',
        targetWipeId: 'wipe_restart_interrupted_test',
        targetServerId: '',
        targetServerName: '',
        totalCount: 2,
        doneCount: 1,
        failedCount: 0,
        skippedCount: 0,
        percent: 50,
        etaSeconds: 120,
        startedAt: nowIso(),
        finishedAt: '',
        createdBy: 'system',
        errorSummary: '',
        details: {},
        createdAt: nowIso(),
        updatedAt: nowIso()
      });
      store.syncState ||= {};
      store.syncState.kda = {
        status: 'running',
        source: 'auto',
        requested: 2,
        imported: 1,
        ignored: 0,
        completed: 1,
        failed: 0,
        percent: 50,
        etaSeconds: 120,
        syncJobId: 'sync_job_restart_interrupted_test',
        updatedAt: nowIso()
      };
      reconcileActiveSyncWork(store, {
        force: true,
        reason: '服务重启，中断同步任务已取消',
        status: 'cancelled',
        nowMs: Date.now()
      });
    });
    result = await request('/sync/jobs/recent?limit=3');
    assert.equal(result.response.status, 200);
    const interruptedJob = result.payload.recent.find((job) => job.id === 'sync_job_restart_interrupted_test');
    assert.equal(interruptedJob.status, 'cancelled');
    assert.equal(interruptedJob.failedCount, 0);
    assert.equal(interruptedJob.skippedCount, 1);
    assert.match(interruptedJob.errorSummary, /已取消/);
    const interruptedStateStore = await readStore();
    assert.equal(interruptedStateStore.syncState.kda.status, 'cancelled');
    assert.equal(interruptedStateStore.syncState.kda.failed, 0);
    assert.equal(interruptedStateStore.syncState.kda.ignored, 1);
    await updateStore((store) => {
      store.syncJobs = store.syncJobs.filter((job) => job.id !== 'sync_job_restart_interrupted_test');
      delete store.syncState.kda;
    });
    await updateStore((store) => {
      store.syncJobs.unshift({
        id: 'sync_job_active_delete_test',
        type: 'kda',
        source: 'manual',
        scope: 'kda',
        status: 'running',
        targetWipeId: 'wipe_active_delete_test',
        targetServerId: '',
        targetServerName: '',
        totalCount: 1,
        doneCount: 0,
        failedCount: 0,
        skippedCount: 0,
        percent: 10,
        etaSeconds: 60,
        startedAt: nowIso(),
        finishedAt: '',
        createdBy: 'user_root',
        errorSummary: '',
        details: {},
        createdAt: nowIso(),
        updatedAt: nowIso()
      });
    });
    result = await request('/sync/jobs/sync_job_active_delete_test', { method: 'DELETE' });
    assert.equal(result.response.status, 400);
    assert.equal(result.payload.error, '运行中的同步任务不能删除');
    await updateStore((store) => {
      store.syncJobs = store.syncJobs.filter((job) => job.id !== 'sync_job_active_delete_test');
    });
    result = await request('/settings/api-doc');
    assert.equal(result.response.status, 200);
    assert.match(result.text, /Clan Portal API 对接文档/);

    result = await request('/settings/system');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.system.proxy.enabled, false);
    assert.equal(result.payload.system.proxy.scope, 'global');
    assert.equal(result.payload.system.proxy.url, '');
    assert.equal(result.payload.system.proxy.battlemetrics.active, false);
    assert.equal(result.payload.system.proxy.kda.active, false);
    assert.equal(result.payload.system.teamLogoUrl, '');
    assert.equal(typeof result.payload.system.storage.dataUsedBytes, 'number');
    assert.equal(typeof result.payload.system.storage.disk.totalBytes, 'number');
    assert.equal(typeof result.payload.system.storage.disk.availableBytes, 'number');

    result = await request('/settings/system', { method: 'PUT', body: { proxyUrl: 'ftp://127.0.0.1:1080', proxyScope: 'global' } });
    assert.equal(result.response.status, 400);
    assert.equal(result.payload.error, '代理配置只支持 http, https, socks4, socks5, socks5h');

    result = await request('/settings/system', { method: 'PUT', body: { proxyUrl: 'socks5h://127.0.0.1:1080', proxyScope: 'unknown' } });
    assert.equal(result.response.status, 400);
    assert.equal(result.payload.error, '代理作用范围无效');

    result = await request('/settings/system', {
      method: 'PUT',
      body: {
        proxyUrl: 'socks5h://127.0.0.1:1080',
        proxyScope: 'battlemetrics',
        teamLogoUrl: 'https://cdn.example.com/nb-logo.png'
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.system.proxy.enabled, true);
    assert.equal(result.payload.system.proxy.url, 'socks5h://127.0.0.1:1080');
    assert.equal(result.payload.system.proxy.scope, 'battlemetrics');
    assert.equal(result.payload.system.proxy.battlemetricsActive, true);
    assert.equal(result.payload.system.proxy.kdaActive, false);
    assert.equal(result.payload.system.proxy.battlemetrics.active, true);
    assert.equal(result.payload.system.proxy.battlemetrics.source, 'store');
    assert.equal(result.payload.system.proxy.kda.active, false);
    assert.equal(result.payload.system.teamLogoUrl, 'https://cdn.example.com/nb-logo.png');
    const systemStoreSnapshot = await readStore();
    assert.equal(systemStoreSnapshot.settings.system.proxy.scope, 'battlemetrics');
    assert.equal(systemStoreSnapshot.settings.system.teamLogoUrl, 'https://cdn.example.com/nb-logo.png');

    result = await request('/settings/system', { method: 'PUT', body: { proxyUrl: '', proxyScope: 'global', teamLogoUrl: '' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.system.proxy.enabled, false);

    cookie = '';
    result = await request('/auth/login', { method: 'POST', body: { username: 'logo_admin', password: 'AdminLogo123!' } });
    assert.equal(result.response.status, 200);
    result = await request('/settings/system', {
      method: 'PUT',
      body: {
        proxyUrl: 'socks5h://127.0.0.1:1081',
        proxyScope: 'kda',
        teamLogoUrl: 'https://cdn.example.com/admin-logo.png'
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.system.teamLogoUrl, 'https://cdn.example.com/admin-logo.png');
    assert.equal(result.payload.system.proxy.url, '');
    const adminLogoStoreSnapshot = await readStore();
    assert.equal(adminLogoStoreSnapshot.settings.system.teamLogoUrl, 'https://cdn.example.com/admin-logo.png');
    assert.equal(adminLogoStoreSnapshot.settings.system.proxy.url, '');
    assert.equal(adminLogoStoreSnapshot.settings.system.proxy.scope, 'global');

    const logoDataUrl = `data:image/png;base64,${Buffer.from('nb-logo').toString('base64')}`;
    result = await request('/settings/system/team-logo', {
      method: 'POST',
      body: { originalName: 'nb-logo.png', mimeType: 'image/png', dataUrl: logoDataUrl }
    });
    assert.equal(result.response.status, 200);
    assert.match(result.payload.system.teamLogoUrl, /^\/uploads\/team-logo\/upload_/);
    const uploadedLogoStoreSnapshot = await readStore();
    assert.equal(uploadedLogoStoreSnapshot.settings.system.teamLogoUrl, result.payload.system.teamLogoUrl);
    assert.equal(uploadedLogoStoreSnapshot.uploads.filter((upload) => upload.kind === 'team_logo').length, 1);

    const largerLogoDataUrl = `data:image/png;base64,${Buffer.alloc(140_000, 1).toString('base64')}`;
    result = await request('/settings/system/team-logo', {
      method: 'POST',
      body: { originalName: 'larger-logo.png', mimeType: 'image/png', dataUrl: largerLogoDataUrl }
    });
    assert.equal(result.response.status, 200);
    assert.match(result.payload.system.teamLogoUrl, /^\/uploads\/team-logo\/upload_/);
    const largerLogoStoreSnapshot = await readStore();
    assert.equal(largerLogoStoreSnapshot.settings.system.teamLogoUrl, result.payload.system.teamLogoUrl);
    assert.equal(largerLogoStoreSnapshot.uploads.filter((upload) => upload.kind === 'team_logo').length, 1);

    result = await request('/settings/system/team-logo', {
      method: 'POST',
      body: { originalName: 'bad.txt', mimeType: 'text/plain', dataUrl: 'data:text/plain;base64,WA==' }
    });
    assert.equal(result.response.status, 400);
    assert.equal(result.payload.error, '战队徽标图片格式不支持');

    cookie = initialRootCookie;
    result = await request('/settings/system', { method: 'PUT', body: { proxyUrl: '', proxyScope: 'global', teamLogoUrl: '' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.system.proxy.enabled, false);

    result = await request('/auth/third-party-login');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.thirdPartyLogin.steam.enabled, true);
    assert.equal(result.payload.thirdPartyLogin.discord.enabled, false);
    assert.equal(result.payload.thirdPartyLogin.discord.configured, true);
    assert.equal(Object.hasOwn(result.payload.thirdPartyLogin.steam, 'adminSteamIds'), false);
    result = await request('/settings/third-party-login');
    assert.equal(result.response.status, 200);
    result = await request('/settings/third-party-login', {
      method: 'PUT',
      body: {
        steam: { enabled: true },
        discord: { enabled: true }
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.thirdPartyLogin.discord.enabled, true);
    assert.equal(Object.hasOwn(result.payload.thirdPartyLogin.steam, 'adminSteamIds'), false);
    result = await request('/auth/steam/start', { redirect: 'manual' });
    assert.equal(result.response.status, 302);
    assert.match(result.response.headers.get('location') || '', /steamcommunity\.com\/openid\/login/);

    const rootCookieBeforeSteamLogin = cookie;
    let steamMemberCookie = '';
    const steamLoginFetch = globalThis.fetch;
    const nodeEnvBeforeSteamLogin = process.env.NODE_ENV;
    const steamLoginProfiles = new Map([
      ['76561198000012345', { name: 'Steam Member Login', avatar: 'https://cdn.example.com/steam-member.jpg' }],
      ['76561198000012346', { name: 'Steam Admin Login', avatar: 'https://cdn.example.com/steam-admin.jpg' }],
      ['76561198000012350', { name: 'Steam Manager Login', avatar: 'https://cdn.example.com/steam-manager.jpg' }]
    ]);
    await updateStore(async (store) => {
      const now = nowIso();
      store.members.push({
        id: 'member_steam_login',
        steamId: '76561198000012345',
        rawInput: '76561198000012345',
        customName: 'Steam Login Member',
        steamNickname: 'Stored Steam Member',
        avatar: '',
        discordId: '',
        wechatId: '',
        notes: '',
        specialty: [],
        invitedByUserId: 'user_root',
        createdAt: now,
        updatedAt: now
      });
      store.members.push({
        id: 'member_steam_admin_login',
        steamId: '76561198000012346',
        rawInput: '76561198000012346',
        customName: 'Steam Admin Member',
        steamNickname: 'Stored Steam Admin Member',
        avatar: '',
        discordId: '333333333333333333',
        wechatId: '',
        notes: '',
        specialty: [],
        invitedByUserId: 'user_root',
        createdAt: now,
        updatedAt: now
      });
      store.members.push({
        id: 'member_discord_login',
        steamId: '76561198000012349',
        rawInput: '76561198000012349',
        customName: 'Discord Login Member',
        steamNickname: 'Stored Discord Member',
        avatar: '',
        discordId: '222222222222222222',
        wechatId: '',
        notes: '',
        specialty: [],
        invitedByUserId: 'user_root',
        createdAt: now,
        updatedAt: now
      });
      store.members.push({
        id: 'member_steam_manager_login',
        steamId: '76561198000012350',
        rawInput: '76561198000012350',
        customName: 'Steam Manager Member',
        steamNickname: 'Stored Steam Manager Member',
        avatar: '',
        discordId: '',
        wechatId: '',
        notes: '',
        specialty: [],
        invitedByUserId: 'user_root',
        createdAt: now,
        updatedAt: now
      });
      store.users.push({
        id: 'user_steam_admin_login',
        username: 'steam_admin_login',
        role: 'admin',
        passwordHash: await hashPassword('SteamAdminPass123!'),
        boundSteamId: '76561198000012346',
        steamNickname: 'Stored Steam Admin',
        createdAt: now,
        updatedAt: now,
        createdBy: 'user_root'
      });
      store.users.push({
        id: 'user_steam_manager_login',
        username: 'steam_manager_login',
        role: 'member_manager',
        passwordHash: await hashPassword('SteamManagerPass123!'),
        boundSteamId: '76561198000012350',
        steamNickname: 'Stored Steam Manager',
        createdAt: now,
        updatedAt: now,
        createdBy: 'user_root'
      });
    });
    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      const steamId = [...steamLoginProfiles.keys()].find((id) => href === `https://steamcommunity.com/profiles/${id}?xml=1`);
      if (steamId) {
        const profile = steamLoginProfiles.get(steamId);
        return new Response([
          '<profile>',
          `<steamID64>${steamId}</steamID64>`,
          `<steamID><![CDATA[${profile.name}]]></steamID>`,
          `<avatarFull>${profile.avatar}</avatarFull>`,
          '</profile>'
        ].join(''), { status: 200, headers: { 'content-type': 'text/xml' } });
      }
      return steamLoginFetch(url, options);
    };
    try {
      process.env.NODE_ENV = 'test';
      cookie = '';
      result = await request('/auth/steam/callback?openid.claimed_id=https%3A%2F%2Fsteamcommunity.com%2Fopenid%2Fid%2F76561198000012345&testVerified=1', { redirect: 'manual' });
      assert.equal(result.response.status, 302);
      result = await request('/auth/me');
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.user.username, 'steam_00012345');
      assert.equal(result.payload.user.role, 'member');
      assert.equal(result.payload.user.boundSteamId, '76561198000012345');
      steamMemberCookie = cookie;
      result = await request('/members');
      assert.equal(result.response.status, 200);
      const steamMember = result.payload.members.find((member) => member.steamId === '76561198000012345');
      assert.equal(Boolean(steamMember), true);
      assert.equal(steamMember.canManage, true);
      assert.equal(result.payload.members.find((member) => member.id === 'member_test_1').canManage, false);
      result = await request('/squads');
      assert.equal(result.response.status, 200);
      result = await request('/wipes/current');
      assert.equal(result.response.status, 200);
      result = await request('/query', { method: 'POST', body: { steamInput: '76561198000000001' } });
      assert.equal(result.response.status, 200);
      result = await request('/settings/api');
      assert.equal(result.response.status, 403);
      assert.equal(result.payload.error, '无权查看该模块');
      result = await request('/settings/branding');
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.system.teamLogoUrl, '');
      assert.equal(Object.hasOwn(result.payload.system, 'proxy'), false);
      result = await request('/members', { method: 'POST', body: { steamInput: '76561198000012347' } });
      assert.equal(result.response.status, 403);
      assert.equal(result.payload.error, '成员角色只能修改自己的信息');
      const selfVipPurchasedAt = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const selfVipExpiresAt = new Date(Date.parse(`${selfVipPurchasedAt}T00:00:00.000Z`) + 28 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      result = await request(`/members/${steamMember.id}?response=member`, {
        method: 'PUT',
        body: {
          steamInput: '76561198000012348',
          customName: 'Steam Self',
          discordName: 'Steam Discord',
          discordId: '999999999999999999',
          wechatId: 'wechat_forbidden',
          phone: '13900000000',
          notes: 'self note',
          specialty: ['translator'],
          battlemetricsId: 'bm_forbidden',
          squadId: 'squad_test_2',
          vitalVipType: 'queue_skip'
        }
      });
      assert.equal(result.response.status, 400);
      assert.equal(result.payload.error, 'Vital VIP 购买日期必填');
      result = await request(`/members/${steamMember.id}?response=member`, {
        method: 'PUT',
        body: {
          steamInput: '76561198000012348',
          customName: 'Steam Self',
          discordName: 'Steam Discord',
          discordId: '999999999999999999',
          wechatId: 'wechat_forbidden',
          phone: '13900000000',
          notes: 'self note',
          specialty: ['translator'],
          battlemetricsId: 'bm_forbidden',
          squadId: 'squad_test_2',
          vitalVipType: 'queue_skip',
          vitalVipPurchasedAt: selfVipPurchasedAt
        }
      });
      assert.equal(result.response.status, 200);
      const memberEditedStore = await readStore();
      const editedSteamMember = memberEditedStore.members.find((member) => member.id === steamMember.id);
      assert.equal(editedSteamMember.steamId, '76561198000012345');
      assert.equal(editedSteamMember.customName, 'Steam Self');
      assert.equal(editedSteamMember.discordId || '', '');
      assert.equal(editedSteamMember.discordName || '', '');
      assert.equal(editedSteamMember.wechatId || '', '');
      assert.equal(editedSteamMember.phone, '13900000000');
      assert.equal(editedSteamMember.notes, 'self note');
      assert.deepEqual(editedSteamMember.specialty, ['translator']);
      assert.equal(editedSteamMember.battlemetricsId || '', '');
      assert.equal(editedSteamMember.vitalVipType || 'none', 'queue_skip');
      assert.equal(editedSteamMember.vitalVipPurchasedAt, selfVipPurchasedAt);
      assert.equal(editedSteamMember.vitalVipExpiresAt, selfVipExpiresAt);
      assert.equal(memberEditedStore.squadMembers.some((item) => item.memberId === steamMember.id && item.squadId === 'squad_test_2'), false);
      result = await request(`/members/${steamMember.id}`, { method: 'DELETE' });
      assert.equal(result.response.status, 403);
      result = await request('/profile', { method: 'PUT', body: { boundSteamInput: '76561198000012348' } });
      assert.equal(result.response.status, 403);
      assert.equal(result.payload.error, '成员角色不能修改 Steam 绑定');

      cookie = '';
      result = await request('/auth/steam/callback?openid.claimed_id=https%3A%2F%2Fsteamcommunity.com%2Fopenid%2Fid%2F76561198000012350&testVerified=1', { redirect: 'manual' });
      assert.equal(result.response.status, 302);
      result = await request('/auth/me');
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.user.username, 'steam_manager_login');
      assert.equal(result.payload.user.role, 'member_manager');
      const steamManagerLoginStore = await readStore();
      assert.equal(steamManagerLoginStore.users.some((user) => user.username === 'steam_00012350'), false);
      assert.equal(steamManagerLoginStore.users.find((user) => user.id === 'user_steam_manager_login').loginProviders.steam.steamId, '76561198000012350');

      cookie = '';
      result = await request('/auth/steam/callback?openid.claimed_id=https%3A%2F%2Fsteamcommunity.com%2Fopenid%2Fid%2F76561198000012346&testVerified=1', { redirect: 'manual' });
      assert.equal(result.response.status, 302);
      result = await request('/auth/me');
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.user.username, 'steam_admin_login');
      assert.equal(result.payload.user.role, 'admin');

      cookie = '';
      result = await request('/auth/steam/callback?lang=zh&openid.claimed_id=https%3A%2F%2Fsteamcommunity.com%2Fopenid%2Fid%2F76561198000012347&testVerified=1', {
        redirect: 'manual',
        headers: { 'Accept-Language': 'zh-CN' }
      });
      assert.equal(result.response.status, 302);
      assert.match(result.response.headers.get('location') || '', /authError=thirdPartyLoginMemberNotFound/);
      assert.match(result.response.headers.get('location') || '', /authLang=zh/);

      discordOAuthUsers.set('discord_member_code', {
        id: '222222222222222222',
        username: 'discord_member_login',
        global_name: 'Discord Member Login',
        avatar: 'member_avatar_hash'
      });
      result = await request('/auth/discord/start?lang=en', { redirect: 'manual' });
      assert.equal(result.response.status, 302);
      const discordMemberAuthorizeUrl = new URL(result.response.headers.get('location') || '');
      assert.equal(discordMemberAuthorizeUrl.origin, 'https://discord.com');
      assert.equal(discordMemberAuthorizeUrl.searchParams.get('client_id'), 'discord_oauth_client_test');
      assert.equal(discordMemberAuthorizeUrl.searchParams.get('scope'), 'identify');
      const discordMemberState = discordMemberAuthorizeUrl.searchParams.get('state');
      assert.ok(discordMemberState);
      result = await request(`/auth/discord/callback?code=discord_member_code&state=${encodeURIComponent(discordMemberState)}`, { redirect: 'manual' });
      assert.equal(result.response.status, 302);
      assert.equal(discordOAuthTokenRequests.at(-1).body.client_id, 'discord_oauth_client_test');
      result = await request('/auth/me');
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.user.username, 'discord_22222222');
      assert.equal(result.payload.user.role, 'member');
      assert.equal(result.payload.user.boundSteamId, '76561198000012349');

      cookie = '';
      discordOAuthUsers.set('discord_admin_code', {
        id: '333333333333333333',
        username: 'discord_admin_login',
        global_name: 'Discord Admin Login',
        avatar: 'admin_avatar_hash'
      });
      result = await request('/auth/discord/start?lang=en', { redirect: 'manual' });
      assert.equal(result.response.status, 302);
      const discordAdminAuthorizeUrl = new URL(result.response.headers.get('location') || '');
      const discordAdminState = discordAdminAuthorizeUrl.searchParams.get('state');
      result = await request(`/auth/discord/callback?code=discord_admin_code&state=${encodeURIComponent(discordAdminState)}`, { redirect: 'manual' });
      assert.equal(result.response.status, 302);
      result = await request('/auth/me');
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.user.username, 'steam_admin_login');
      assert.equal(result.payload.user.role, 'admin');

      cookie = '';
      discordOAuthUsers.set('discord_unknown_code', {
        id: '444444444444444444',
        username: 'discord_unknown_login',
        global_name: 'Discord Unknown',
        avatar: null
      });
      result = await request('/auth/discord/start?lang=zh', { redirect: 'manual' });
      assert.equal(result.response.status, 302);
      const discordUnknownAuthorizeUrl = new URL(result.response.headers.get('location') || '');
      const discordUnknownState = discordUnknownAuthorizeUrl.searchParams.get('state');
      result = await request(`/auth/discord/callback?code=discord_unknown_code&state=${encodeURIComponent(discordUnknownState)}`, {
        redirect: 'manual',
        headers: { 'Accept-Language': 'zh-CN' }
      });
      assert.equal(result.response.status, 302);
      assert.match(result.response.headers.get('location') || '', /authError=thirdPartyLoginMemberNotFound/);
    } finally {
      globalThis.fetch = steamLoginFetch;
      process.env.NODE_ENV = nodeEnvBeforeSteamLogin;
      cookie = rootCookieBeforeSteamLogin;
    }

    result = await request('/integrations/public-query', {
      method: 'POST',
      ip: '198.51.100.10',
      headers: { 'X-NB-API-Token': publicApiToken },
      body: { steamInput: '76561198000000001' }
    });
    assert.equal(result.response.status, 403);
    assert.equal(result.payload.error, '公开 API Token 尚未配置');

    result = await request('/settings/public-api', { method: 'PUT', body: { token: 'short' } });
    assert.equal(result.response.status, 400);

    result = await request('/settings/public-api', { method: 'PUT', body: { token: publicApiToken } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.publicApi.enabled, true);
    const publicApiStoreSnapshot = await readStore();
    assert.equal(publicApiStoreSnapshot.settings.publicApi.tokenHash.includes(publicApiToken), false);
    assert.equal(publicApiStoreSnapshot.settings.publicApi.tokenHash.startsWith('scrypt$'), true);

    result = await request('/settings/steam-web-api', { method: 'PUT', body: { apiKey: 'short' } });
    assert.equal(result.response.status, 400);
    result = await request('/settings/steam-web-api', { method: 'PUT', body: { apiKey: storedSteamWebApiKey } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.steamWebApi.enabled, true);
    assert.equal(result.payload.steamWebApi.source, 'store');
    assert.equal(result.payload.steamWebApi.storeConfigured, true);
    assert.equal(result.payload.steamWebApi.masked, '********');
    assert.equal(Object.hasOwn(result.payload.steamWebApi, 'apiKey'), false);
    let steamWebApiStoreSnapshot = await readStore();
    assert.equal(steamWebApiStoreSnapshot.settings.steamWebApi.apiKey, storedSteamWebApiKey);
    result = await request('/settings/steam-web-api', { method: 'DELETE' });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.steamWebApi.enabled, true);
    assert.equal(result.payload.steamWebApi.source, 'env');
    assert.equal(result.payload.steamWebApi.storeConfigured, false);
    steamWebApiStoreSnapshot = await readStore();
    assert.equal(steamWebApiStoreSnapshot.settings.steamWebApi.apiKey, '');

    result = await request('/integrations/public-query', {
      method: 'POST',
      ip: '198.51.100.11',
      body: { steamInput: '76561198000000001' }
    });
    assert.equal(result.response.status, 401);
    assert.equal(result.payload.error, '公开 API Token 无效');

    result = await request('/integrations/public-query', {
      method: 'POST',
      ip: '198.51.100.12',
      headers: { Authorization: 'Bearer wrong-token' },
      body: { steamInput: '76561198000000001' }
    });
    assert.equal(result.response.status, 401);

    result = await request('/integrations/public-query', {
      method: 'POST',
      ip: '198.51.100.13',
      headers: { Authorization: `Bearer ${publicApiToken}` },
      body: { steamInput: '76561198000000001' }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.data.isMember, true);
    assert.equal(result.payload.data.query.steamId, '76561198000000001');
    assert.equal(result.payload.data.member.displayName, 'Alpha');
    assert.equal(result.payload.data.member.steamNickname, 'AlphaSteam');
    assert.equal(result.payload.data.member.profileUrl, 'https://steamcommunity.com/profiles/76561198000000001');
    assert.equal(result.payload.data.member.squadName, 'Alpha Squad');
    assert.equal(result.payload.data.member.squad.name, 'Alpha Squad');
    assert.equal(result.payload.data.member.squad.leader.displayName, 'Leader Test');
    assert.equal(result.payload.data.member.squad.leader.steamId, '76561198000009999');
    assert.equal('serverOnline' in result.payload.data.member, false);
    assert.equal('serverOnline' in result.payload.data.currentWipe, false);
    assert.equal('discordId' in result.payload.data.member, false);
    assert.equal('phone' in result.payload.data.member, false);

    for (let index = 0; index < 10; index += 1) {
      result = await request('/integrations/public-query', {
        method: 'POST',
        ip: '198.51.100.14',
        headers: { Authorization: `Bearer ${publicApiToken}` },
        body: { steamInput: '76561198000000001' }
      });
      assert.equal(result.response.status, 200);
    }
    result = await request('/integrations/public-query', {
      method: 'POST',
      ip: '198.51.100.14',
      headers: { Authorization: `Bearer ${publicApiToken}` },
      body: { steamInput: '76561198000000001' }
    });
    assert.equal(result.response.status, 429);
    assert.equal(result.response.headers.get('Retry-After'), '1');

    result = await request('/settings/battlemetrics', { method: 'PUT', body: { apiKey: 'short' } });
    assert.equal(result.response.status, 400);
    result = await request('/settings/battlemetrics', { method: 'PUT', body: { apiKey: 'bm_test_key_12345678901234567890' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.battlemetrics.enabled, true);
    assert.equal(result.payload.battlemetrics.source, 'store');
    assert.equal(result.payload.battlemetrics.keyCount, 1);
    assert.equal(result.payload.battlemetrics.keys[0].masked, '********');
    result = await request('/settings/battlemetrics', {
      method: 'PUT',
      body: { apiKey: 'bm_second_key_12345678901234567890', label: 'Singapore 2' }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.battlemetrics.keyCount, 2);
    assert.equal(result.payload.battlemetrics.keys.some((key) => key.label === 'Singapore 2'), true);
    const secondBattlemetricsKeyId = result.payload.battlemetrics.keys.find((key) => key.label === 'Singapore 2').id;
    let battlemetricsStoreSnapshot = await readStore();
    assert.equal(battlemetricsStoreSnapshot.settings.battlemetrics.apiKeys.length, 2);
    assert.equal(battlemetricsStoreSnapshot.settings.battlemetrics.apiKey, 'bm_test_key_12345678901234567890');
    result = await request('/settings/battlemetrics', { method: 'DELETE', body: { id: secondBattlemetricsKeyId } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.battlemetrics.keyCount, 1);
    battlemetricsStoreSnapshot = await readStore();
    assert.equal(battlemetricsStoreSnapshot.settings.battlemetrics.apiKeys.length, 1);

    result = await request('/users', {
      method: 'POST',
      body: {
        username: 'existing_member_account',
        password: 'MemberPass123!',
        role: 'member_manager',
        boundSteamInput: '76561198000000001'
      }
    });
    assert.equal(result.response.status, 200);
    const existingMemberAccount = result.payload.users.find((user) => user.username === 'existing_member_account');
    assert.equal(existingMemberAccount.boundSteamId, '76561198000000001');
    let storeSnapshot = await readStore();
    const linkedMember = storeSnapshot.members.find((member) => member.id === 'member_test_1');
    assert.equal(linkedMember.invitedByUserId, 'user_leader_test');
    assert.equal(storeSnapshot.members.filter((member) => member.steamId === '76561198000000001').length, 1);

    result = await request('/users', {
      method: 'POST',
      body: {
        username: 'new_bound_member',
        password: 'MemberPass123!',
        role: 'member_manager',
        boundSteamInput: '76561198000007777'
      }
    });
    assert.equal(result.response.status, 200);
    const newBoundMemberAccount = result.payload.users.find((user) => user.username === 'new_bound_member');
    storeSnapshot = await readStore();
    const autoCreatedMember = storeSnapshot.members.find((member) => member.steamId === '76561198000007777');
    assert.equal(Boolean(autoCreatedMember), true);
    assert.equal(autoCreatedMember.invitedByUserId, newBoundMemberAccount.id);
    assert.deepEqual(autoCreatedMember.specialty, []);

    result = await request('/users', {
      method: 'POST',
      body: {
        username: 'duplicate_bound_member',
        password: 'MemberPass123!',
        role: 'member_manager',
        boundSteamInput: '76561198000007777'
      }
    });
    assert.equal(result.response.status, 409);
    assert.equal(result.payload.error, '该 SteamID 已被其他账号绑定');

    const rootCookieForSquad = cookie;
    result = await request('/squads/squad_test_1', {
      method: 'PUT',
      body: {
        name: 'Alpha Squad',
        notes: '',
        leaderUserIds: ['user_leader_test', newBoundMemberAccount.id]
      }
    });
    assert.equal(result.response.status, 200);
    const multiLeaderSquad = result.payload.squads.find((squad) => squad.id === 'squad_test_1');
    assert.deepEqual(new Set(multiLeaderSquad.leaderUserIds), new Set(['user_leader_test', newBoundMemberAccount.id]));
    assert.equal(multiLeaderSquad.leaderNames.length, 2);

    cookie = '';
    result = await request('/auth/login', { method: 'POST', body: { username: 'new_bound_member', password: 'MemberPass123!' } });
    assert.equal(result.response.status, 200);
    result = await request('/squads');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.squads.some((squad) => squad.id === 'squad_test_1'), true);
    result = await request('/wipes/current');
    assert.equal(result.response.status, 200);
    result = await request('/settings/api');
    assert.equal(result.response.status, 403);
    assert.equal(result.payload.error, '无权查看该模块');
    result = await request('/settings/system');
    assert.equal(result.response.status, 403);
    assert.equal(result.payload.error, '无权查看该模块');
    result = await request('/settings/branding');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.system.teamLogoUrl, '');
    assert.equal(Object.hasOwn(result.payload.system, 'storage'), false);
    result = await request('/settings/battlemetrics/queue');
    assert.equal(result.response.status, 403);
    assert.equal(result.payload.error, '无权查看该模块');
    result = await request('/sync/jobs/recent?limit=2');
    assert.equal(result.response.status, 403);
    assert.equal(result.payload.error, '无权查看该模块');
    result = await request('/settings/system', { method: 'PUT', body: { proxyUrl: '', proxyScope: 'global', teamLogoUrl: '' } });
    assert.equal(result.response.status, 403);
    result = await request('/settings/battlemetrics', { method: 'PUT', body: { apiKey: 'bm_member_key_12345678901234567890' } });
    assert.equal(result.response.status, 403);
    cookie = rootCookieForSquad;

    result = await request('/vital-servers');
    assert.equal(result.response.status, 200);
    const usMonthly = result.payload.servers.find((server) => server.vitalServerId === '23');
    assert.equal(usMonthly.name, 'Vital Rust 2X US Monthly');
    assert.equal(usMonthly.directConnect, 'client.connect 168.100.163.73:28014');
    assert.equal(usMonthly.status, 'hidden');
    assert.equal(usMonthly.vipUrl, 'https://store.vitalrust.com/package/vip-us-monthly');
    result = await request('/wipe-server-options');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.servers.some((server) => server.vitalServerId === '23'), false);
    const atlasEu2xOptions = result.payload.servers.filter((server) => server.provider === 'atlas');
    assert.deepEqual(atlasEu2xOptions.map((server) => server.serverPresetId), [
      'atlas-eu-2x-monthly',
      'atlas-eu-2x-medium',
      'atlas-eu-2x-monthly-quad',
      'atlas-us-2x-monthly',
      'atlas-us-2x-medium',
      'atlas-us-2x-monthly-quad'
    ]);
    const atlasEu2xMonthly = atlasEu2xOptions.find((server) => server.serverPresetId === 'atlas-eu-2x-monthly');
    assert.equal(atlasEu2xMonthly.name, 'Atlas - EU 2X Monthly Large');
    assert.equal(atlasEu2xMonthly.vitalServerId, '');
    assert.equal(atlasEu2xMonthly.battlemetricsId, '16741517');
    assert.equal(atlasEu2xMonthly.serverVipProvider, 'atlas');
    assert.equal(atlasEu2xMonthly.kdaProvider, 'manual');
    assert.equal(atlasEu2xMonthly.directConnect, 'client.connect 2xmonthly.atlasrust.uk:28010');
    assert.equal(atlasEu2xMonthly.wipeOptions[0].type, 'current');
    const atlasUsMedium = atlasEu2xOptions.find((server) => server.serverPresetId === 'atlas-us-2x-medium');
    assert.equal(atlasUsMedium.directConnect, 'client.connect 2xmedium.atlasrust.us:28010');
    assert.equal(atlasUsMedium.vitalServerId, '');
    assert.equal(atlasUsMedium.kdaProvider, 'manual');
    assert.equal(atlasUsMedium.wipeOptions[0].type, 'current');
    result = await request('/users', { method: 'POST', body: { username: 'manager_no_steam', password: 'ManagerPass123!', role: 'member_manager' } });
    assert.equal(result.response.status, 200);
    const managerNoSteam = result.payload.users.find((user) => user.username === 'manager_no_steam');
    result = await request(`/users/${managerNoSteam.id}`, { method: 'PUT', body: { role: 'admin' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.users.find((user) => user.id === managerNoSteam.id).role, 'admin');
    result = await request(`/users/${managerNoSteam.id}`, { method: 'PUT', body: { role: 'leader' } });
    assert.equal(result.response.status, 400);
    assert.equal(result.payload.error, '队长必须绑定 Steam ID');

    result = await request('/users', { method: 'POST', body: { username: 'leader_no_steam', password: 'LeaderPass123!', role: 'leader' } });
    assert.equal(result.response.status, 400);
    assert.equal(result.payload.error, '队长必须绑定 Steam ID');

    result = await request('/users', { method: 'POST', body: { username: 'weak_generated', generatedPassword: 'short', role: 'member_manager' } });
    assert.equal(result.response.status, 400);
    assert.equal(result.payload.error, '密码长度需要在 8-128 位之间');

    result = await request('/query', { method: 'POST', ip: '10.10.0.1', body: { steamInput: '76561198000000001', filler: 'x'.repeat(140_000) } });
    assert.equal(result.response.status, 413);

    const rootCookieForLeaderPermissions = cookie;
    cookie = '';
    result = await request('/auth/login', { method: 'POST', body: { username: 'leader_test', password: 'LeaderPass123!' } });
    assert.equal(result.response.status, 200);

    result = await request('/squads');
    assert.equal(result.response.status, 200);
    const leaderVisibleAlpha = result.payload.squads.find((squad) => squad.id === 'squad_test_1');
    const leaderVisibleBravo = result.payload.squads.find((squad) => squad.id === 'squad_test_2');
    assert.equal(Boolean(leaderVisibleAlpha), true);
    assert.equal(Boolean(leaderVisibleBravo), true);
    assert.equal(leaderVisibleAlpha.canManage, true);
    assert.equal(leaderVisibleBravo.canManage, false);

    result = await request('/squads/squad_test_1/members?limit=1&offset=0');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.members.length, 1);
    assert.equal(result.payload.total >= 2, true);
    assert.equal(result.payload.limit, 1);
    assert.equal(result.payload.offset, 0);
    assert.equal(result.payload.hasMore, true);

    result = await request('/squads/squad_test_2/members');
    assert.equal(result.response.status, 200);
    const otherSquadMember = result.payload.members.find((member) => member.id === 'member_test_2');
    assert.equal(Boolean(otherSquadMember), true);
    assert.equal(otherSquadMember.canManage, false);

    result = await request('/members/member_test_2', {
      method: 'PUT',
      body: {
        steamInput: '76561198000000004',
        customName: 'Blocked Bravo',
        specialty: ['farming']
      }
    });
    assert.equal(result.response.status, 403);
    assert.equal(result.payload.error, '无权管理该成员');

    result = await request('/members/member_test_4', {
      method: 'PUT',
      body: {
        steamInput: '76561198000000008',
        customName: 'Unassigned Edited',
        notes: 'claimed by alpha leader',
        specialty: ['logistics'],
        squadId: 'squad_test_1'
      }
    });
    assert.equal(result.response.status, 200);
    const claimedUnassignedMember = result.payload.members.find((member) => member.id === 'member_test_4');
    assert.equal(claimedUnassignedMember.customName, 'Unassigned Edited');
    assert.equal(claimedUnassignedMember.squadId, 'squad_test_1');
    assert.equal(claimedUnassignedMember.canManage, true);
    cookie = rootCookieForLeaderPermissions;

    result = await request('/members');
    assert.equal(result.response.status, 200);
    const leaderSelfMember = result.payload.members.find((member) => member.steamId === '76561198000009999');
    assert.equal(Boolean(leaderSelfMember), true);
    assert.equal(leaderSelfMember.squadId, 'squad_test_1');
    assert.equal(leaderSelfMember.canManage, true);

    result = await request('/members?limit=2&offset=0');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.members.length, 2);
    assert.equal(result.payload.total >= 5, true);
    assert.equal(result.payload.offset, 0);
    assert.equal(result.payload.limit, 2);
    assert.equal(result.payload.hasMore, true);

    const currentVitalVipYear = String(new Date().getUTCFullYear());
    const expectedMemberVipPurchaseDate = `${currentVitalVipYear}-06-16`;
    const expectedMemberVipExpiryDate = `${currentVitalVipYear}-07-14`;
    result = await request('/members/member_test_1', {
      method: 'PUT',
      body: {
        steamInput: '76561198000000001',
        customName: 'Alpha',
        discordId: 'discord-alpha',
        wechatId: 'wechat-alpha',
        phone: '13800000000',
        notes: 'main builder',
        specialty: 'gunner',
        vitalVipType: 'priority',
        squadId: 'squad_test_1'
      }
    });
    assert.equal(result.response.status, 400);
    assert.equal(result.payload.error, 'Vital VIP 购买日期必填');
    result = await request('/members/member_test_1', {
      method: 'PUT',
      body: {
        steamInput: '76561198000000001',
        customName: 'Alpha',
        discordId: 'discord-alpha',
        wechatId: 'wechat-alpha',
        phone: '13800000000',
        notes: 'main builder',
        specialty: 'gunner',
        atlasVipType: 'priority',
        squadId: 'squad_test_1'
      }
    });
    assert.equal(result.response.status, 400);
    assert.equal(result.payload.error, 'Atlas VIP 购买日期必填');
    result = await request('/members/member_test_1', {
      method: 'PUT',
      body: {
        steamInput: '76561198000000001',
        customName: 'Alpha',
        discordId: 'discord-alpha',
        wechatId: 'wechat-alpha',
        phone: '13800000000',
        notes: 'main builder',
        specialty: 'gunner',
        vitalVipType: 'priority',
        vitalVipPurchasedAt: '06-16',
        atlasVipType: 'queue_skip',
        atlasVipPurchasedAt: '06-17',
        squadId: 'squad_test_1'
      }
    });
    assert.equal(result.response.status, 200);
    const updatedMember = result.payload.members.find((member) => member.id === 'member_test_1');
    assert.equal(updatedMember.phone, '13800000000');
    assert.equal(updatedMember.notes, 'main builder');
    assert.deepEqual(updatedMember.specialty, ['pvp']);
    assert.equal(updatedMember.vitalVip.type, 'priority');
    assert.equal(updatedMember.vitalVip.purchasedAt, expectedMemberVipPurchaseDate);
    assert.equal(updatedMember.vitalVip.expiresAt, expectedMemberVipExpiryDate);
    assert.equal(updatedMember.atlasVip.type, 'queue_skip');
    assert.equal(updatedMember.atlasVip.purchasedAt, `${currentVitalVipYear}-06-17`);
    assert.equal(updatedMember.atlasVip.expiresAt, `${currentVitalVipYear}-07-15`);
    assert.equal(updatedMember.squadId, 'squad_test_1');

    result = await request('/members/member_test_1?response=member', {
      method: 'PUT',
      body: {
        steamInput: '76561198000000001',
        customName: 'Alpha',
        discordId: 'discord-alpha',
        wechatId: 'wechat-alpha',
        phone: '13800000000',
        notes: 'main builder',
        specialty: ['pvp'],
        vitalVipType: 'priority',
        vitalVipPurchasedAt: '06-16',
        squadId: 'squad_test_1'
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.member.id, 'member_test_1');
    assert.equal(result.payload.member.phone, '13800000000');
    assert.equal(result.payload.members, undefined);

    result = await request('/members/member_test_3/battlemetrics-id', {
      method: 'PUT',
      body: { battlemetricsId: 'bm_manual_3' }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.member.battlemetricsId, 'bm_manual_3');
    assert.equal(result.payload.member.onlineSummary.battlemetricsPlayerId, 'bm_manual_3');

    result = await request('/members/member_test_3', {
      method: 'PUT',
      body: {
        steamInput: '76561198000000005',
        customName: 'Squad Only',
        discordId: '',
        wechatId: '',
        phone: '',
        notes: '',
        specialty: [],
        squadId: 'squad_test_1'
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.members.find((member) => member.id === 'member_test_3').battlemetricsId, 'bm_manual_3');

    const manualBattlemetricsFetch = globalThis.fetch;
    const battlemetricsIdRefreshRequests = [];
    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      if (!href.startsWith('https://api.battlemetrics.com')) {
        return manualBattlemetricsFetch(url, options);
      }
      battlemetricsIdRefreshRequests.push({ href, authorization: options.headers?.authorization || '' });
      if (href.endsWith('/players/match')) {
        return new Response(JSON.stringify({
          data: [{ type: 'player', id: 'bm_refetched_3', attributes: { name: 'SquadOnlyBM' } }]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (href.includes('/players/bm_refetched_3/servers/36933209')) {
        return new Response(JSON.stringify({
          data: {
            type: 'playerServer',
            id: 'bm_refetched_3-36933209',
            attributes: {
              firstSeen: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
              lastSeen: new Date(Date.now() - 30 * 60_000).toISOString(),
              timePlayed: 5400,
              online: false
            }
          }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ errors: [{ title: 'unexpected url' }] }), { status: 404, headers: { 'content-type': 'application/json' } });
    };
    try {
      result = await request('/members/member_test_3/battlemetrics-id/refresh', {
        method: 'POST',
        ip: '10.10.0.10'
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.queued, true);
      assert.equal(result.payload.operationRun.type, 'battlemetrics_id_refresh');
      assert.equal(result.payload.operationRun.status, 'queued');

      let refreshedProfile = null;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        const detailResult = await request('/members/member_test_3/profile');
        refreshedProfile = detailResult.payload.member;
        if (refreshedProfile?.battlemetricsId === 'bm_refetched_3') break;
      }
      assert.equal(refreshedProfile?.battlemetricsId, 'bm_refetched_3');
      assert.equal(refreshedProfile?.onlineSummary?.battlemetricsPlayerId, 'bm_refetched_3');
      const matchRequest = battlemetricsIdRefreshRequests.find((item) => item.href.includes('/players/match'));
      assert.equal(Boolean(matchRequest), true);
      assert.equal(matchRequest.authorization.startsWith('Bearer '), true);
    } finally {
      globalThis.fetch = manualBattlemetricsFetch;
    }

    result = await request('/members/bulk', {
      method: 'POST',
      body: {
        text: [
          '76561198000000002',
          'https://steamcommunity.com/profiles/76561198000000003',
          '76561198000000001',
          'not-a-steamid'
        ].join('\n'),
        squadId: 'squad_test_1',
        specialty: ['pvp', 'laborer']
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.imported, 2);
    assert.equal(result.payload.skipped, 1);
    assert.equal(result.payload.failed, 1);
    assert.equal(result.payload.syncQueued, 0);
    const bulkMember = result.payload.members.find((member) => member.steamId === '76561198000000002');
    assert.equal(Boolean(bulkMember), true);
    assert.deepEqual(bulkMember.specialty, ['pvp']);
    assert.equal(bulkMember.squadId, 'squad_test_1');

    await updateStore(async (store) => {
      const createdAt = '2020-01-01T00:00:00.000Z';
      const closedAt = '2020-01-01T02:00:00.000Z';
      store.members.push({
        id: 'member_bulk_delete_1',
        steamId: '76561198000000006',
        rawInput: '76561198000000006',
        customName: 'Bulk Delete Actor',
        steamNickname: 'BulkDeleteActor',
        avatar: '',
        discordId: '',
        wechatId: '',
        notes: '',
        specialty: ['actor', 'appearance'],
        invitedByUserId: 'user_root',
        createdAt,
        updatedAt: createdAt
      });
      store.members.push({
        id: 'member_bulk_delete_2',
        steamId: '76561198000000007',
        rawInput: '76561198000000007',
        customName: 'Bulk Delete Horse',
        steamNickname: 'BulkDeleteHorse',
        avatar: '',
        discordId: '',
        wechatId: '',
        notes: '',
        specialty: ['horse', 'pvp'],
        invitedByUserId: 'user_root',
        createdAt,
        updatedAt: createdAt
      });
      store.members.push({
        id: 'member_bulk_delete_minimal',
        steamId: '76561198000000008',
        rawInput: '76561198000000008',
        customName: 'Bulk Delete Minimal',
        steamNickname: 'BulkDeleteMinimal',
        avatar: '',
        discordId: '',
        wechatId: '',
        notes: '',
        specialty: ['pvp'],
        invitedByUserId: 'user_root',
        createdAt,
        updatedAt: createdAt
      });
      store.members.push({
        id: 'member_single_delete_minimal',
        steamId: '76561198999999001',
        rawInput: '76561198999999001',
        customName: 'Single Delete Minimal',
        steamNickname: 'SingleDeleteMinimal',
        avatar: '',
        discordId: '',
        wechatId: '',
        notes: '',
        specialty: ['laborer'],
        invitedByUserId: 'user_root',
        createdAt,
        updatedAt: createdAt
      });
      store.users.push({
        id: 'user_bulk_delete_member_account',
        username: 'bulk_delete_member_account',
        role: 'member',
        passwordHash: await hashPassword('BulkMemberPass123!'),
        boundSteamId: '76561198000000006',
        steamNickname: 'BulkDeletePlane',
        createdAt,
        updatedAt: createdAt,
        createdBy: 'steam_login',
        loginProviders: {
          steam: {
            id: '76561198000000006',
            steamId: '76561198000000006',
            linkedAt: createdAt,
            lastLoginAt: createdAt
          }
        }
      });
      store.users.push({
        id: 'user_bulk_delete_manager_account',
        username: 'bulk_delete_manager_account',
        role: 'member_manager',
        passwordHash: await hashPassword('BulkManagerPass123!'),
        boundSteamId: '76561198000000007',
        steamNickname: 'BulkDeleteHorse',
        createdAt,
        updatedAt: createdAt,
        createdBy: 'user_root',
        loginProviders: {
          steam: {
            id: '76561198000000007',
            steamId: '76561198000000007',
            linkedAt: createdAt,
            lastLoginAt: createdAt
          }
        }
      });
      store.users.push({
        id: 'user_deleted_member_orphan_account',
        username: 'deleted_member_orphan_account',
        role: 'member',
        passwordHash: await hashPassword('DeletedMemberPass123!'),
        boundSteamId: '76561198000000088',
        steamNickname: 'DeletedMemberOrphan',
        createdAt,
        updatedAt: createdAt,
        createdBy: 'steam_login',
        loginProviders: {
          steam: {
            id: '76561198000000088',
            steamId: '76561198000000088',
            linkedAt: createdAt,
            lastLoginAt: createdAt
          }
        }
      });
      store.sessions ||= [];
      store.sessions.push({
        id: 'sess_bulk_delete_member_account',
        userId: 'user_bulk_delete_member_account',
        createdAt,
        expiresAt: '2999-01-01T00:00:00.000Z'
      });
      store.sessions.push({
        id: 'sess_deleted_member_orphan_account',
        userId: 'user_deleted_member_orphan_account',
        createdAt,
        expiresAt: '2999-01-01T00:00:00.000Z'
      });
      const archivedMember1 = store.members.find((member) => member.id === 'member_bulk_delete_1');
      const archivedMember2 = store.members.find((member) => member.id === 'member_bulk_delete_2');
      store.wipes.push(
        {
          id: 'wipe_bulk_delete_active',
          name: 'Bulk Delete Active',
          status: 'planned',
          serverName: 'Bulk Delete Active',
          startedAt: createdAt,
          closedAt: '',
          createdAt,
          updatedAt: createdAt
        },
        {
          id: 'wipe_bulk_delete_closed',
          name: 'Bulk Delete Closed',
          status: 'closed',
          serverName: 'Bulk Delete Closed',
          startedAt: createdAt,
          closedAt,
          createdAt,
          updatedAt: closedAt
        }
      );
      store.squadMembers.push({
        id: 'squad_member_bulk_delete_1',
        squadId: 'squad_test_1',
        memberId: 'member_bulk_delete_1',
        addedByUserId: 'user_root',
        createdAt
      });
      store.wipeParticipants.push({
        id: 'participant_bulk_delete_active_1',
        wipeId: 'wipe_bulk_delete_active',
        squadId: 'squad_test_1',
        memberId: 'member_bulk_delete_1',
        status: 'on_time',
        addedByUserId: 'user_root',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'participant_bulk_delete_active_steam_only_1',
        wipeId: 'wipe_bulk_delete_active',
        squadId: 'squad_test_1',
        memberId: 'legacy_member_bulk_delete_1',
        steamId: '76561198000000006',
        status: 'on_time',
        addedByUserId: 'user_root',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'participant_bulk_delete_closed_1',
        wipeId: 'wipe_bulk_delete_closed',
        squadId: 'squad_test_1',
        squadName: 'Alpha Squad',
        memberId: 'member_bulk_delete_1',
        member: archivedMember1,
        status: 'on_time',
        addedByUserId: 'user_root',
        createdAt,
        updatedAt: closedAt
      }, {
        id: 'participant_bulk_delete_closed_2',
        wipeId: 'wipe_bulk_delete_closed',
        squadId: 'squad_test_1',
        squadName: 'Alpha Squad',
        memberId: 'member_bulk_delete_2',
        member: archivedMember2,
        status: 'late',
        addedByUserId: 'user_root',
        createdAt,
        updatedAt: closedAt
      });
      store.kdaRows.push(
        { id: 'kda_row_bulk_delete_active_1', wipeId: 'wipe_bulk_delete_active', memberId: 'member_bulk_delete_1', steamId: '76561198000000006', kills: 3 },
        { id: 'kda_row_bulk_delete_active_steam_only_1', wipeId: 'wipe_bulk_delete_active', memberId: 'legacy_member_bulk_delete_1', steamId: '76561198000000006', kills: 9 },
        { id: 'kda_row_bulk_delete_closed_1', wipeId: 'wipe_bulk_delete_closed', memberId: 'member_bulk_delete_1', steamId: '76561198000000006', kills: 21, onlineTimeMinutes: 42, member: archivedMember1, squadId: 'squad_test_1', squadName: 'Alpha Squad', capturedAt: closedAt, syncedAt: closedAt },
        { id: 'kda_row_bulk_delete_closed_2', wipeId: 'wipe_bulk_delete_closed', memberId: 'member_bulk_delete_2', steamId: '76561198000000007', kills: 17, member: archivedMember2, squadId: 'squad_test_1', squadName: 'Alpha Squad', capturedAt: closedAt, syncedAt: closedAt }
      );
      store.kdaSnapshots.push(
        { id: 'kda_snapshot_bulk_delete_active_1', wipeId: 'wipe_bulk_delete_active', memberId: 'member_bulk_delete_2', steamId: '76561198000000007', kills: 4, capturedAt: createdAt },
        { id: 'kda_snapshot_bulk_delete_active_steam_only_1', wipeId: 'wipe_bulk_delete_active', memberId: 'legacy_member_bulk_delete_2', steamId: '76561198000000007', kills: 8, capturedAt: createdAt },
        { id: 'kda_snapshot_bulk_delete_closed_0', wipeId: 'wipe_bulk_delete_closed', memberId: 'member_bulk_delete_1', steamId: '76561198000000006', kills: 21, member: archivedMember1, squadId: 'squad_test_1', squadName: 'Alpha Squad', capturedAt: closedAt },
        { id: 'kda_snapshot_bulk_delete_closed_1', wipeId: 'wipe_bulk_delete_closed', memberId: 'member_bulk_delete_2', steamId: '76561198000000007', kills: 17, member: archivedMember2, squadId: 'squad_test_1', squadName: 'Alpha Squad', capturedAt: closedAt }
      );
      store.wipeSettlements.push({
        id: 'settlement_bulk_delete_closed',
        wipeId: 'wipe_bulk_delete_closed',
        generatedByUserId: 'user_root',
        generatedAt: closedAt,
        serverSnapshot: store.wipes.find((wipe) => wipe.id === 'wipe_bulk_delete_closed'),
        participantsSnapshot: store.wipeParticipants.filter((participant) => participant.wipeId === 'wipe_bulk_delete_closed'),
        squadsSnapshot: [],
        kdaSnapshot: store.kdaRows.filter((row) => row.wipeId === 'wipe_bulk_delete_closed'),
        summary: { participantCount: 2 }
      });
      store.memberProfiles.push(
        { id: 'member_profile_bulk_delete_1', memberId: 'member_bulk_delete_2', syncedAt: createdAt },
        {
          id: 'member_profile_bulk_delete_2',
          memberId: 'member_bulk_delete_1',
          battlemetricsWipeId: 'wipe_bulk_delete_closed',
          battlemetricsServerPlayTimeSeconds: 999 * 60,
          syncedAt: createdAt
        }
      );
      store.accountAlertDismissals ||= [];
      store.accountAlertDismissals.push(
        { id: 'member_bulk_delete_1:private-inventory', memberId: 'member_bulk_delete_1', type: 'private-inventory', dismissedAt: createdAt, dismissedByUserId: 'user_root' },
        { id: 'member_bulk_delete_2:no-online-14d', memberId: 'member_bulk_delete_2', type: 'no-online-14d', dismissedAt: createdAt, dismissedByUserId: 'user_root' }
      );
    });

    result = await request('/query', { method: 'POST', ip: '10.10.0.17', body: { steamInput: '76561198000000006' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.member.recentHistoryServerOnline.onlineTimeMinutes, 42);

    result = await request('/members?response=minimal', {
      method: 'DELETE',
      body: { memberIds: ['member_bulk_delete_minimal'] }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.deleted, 1);
    assert.deepEqual(result.payload.deletedMemberIds, ['member_bulk_delete_minimal']);
    assert.equal(Object.hasOwn(result.payload, 'members'), false);

    result = await request('/members/member_single_delete_minimal?response=minimal', { method: 'DELETE' });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.deleted, 1);
    assert.equal(result.payload.deletedMemberId, 'member_single_delete_minimal');
    assert.equal(Object.hasOwn(result.payload, 'members'), false);

    result = await request('/members', {
      method: 'DELETE',
      body: { memberIds: ['member_bulk_delete_1', 'member_bulk_delete_2'] }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.deleted, 2);
    assert.equal(result.payload.members.some((member) => member.id === 'member_bulk_delete_1' || member.id === 'member_bulk_delete_2'), false);
    const bulkDeletedStore = await readStore();
    assert.equal(bulkDeletedStore.members.some((member) => member.id === 'member_bulk_delete_1' || member.id === 'member_bulk_delete_2'), false);
    assert.equal(bulkDeletedStore.squadMembers.some((item) => item.memberId === 'member_bulk_delete_1' || item.memberId === 'member_bulk_delete_2'), false);
    assert.equal(bulkDeletedStore.wipeParticipants.some((item) => item.wipeId === 'wipe_bulk_delete_active' && (item.memberId === 'member_bulk_delete_1' || item.memberId === 'member_bulk_delete_2')), false);
    assert.equal(bulkDeletedStore.kdaRows.some((item) => item.wipeId === 'wipe_bulk_delete_active' && (item.memberId === 'member_bulk_delete_1' || item.memberId === 'member_bulk_delete_2')), false);
    assert.equal(bulkDeletedStore.kdaSnapshots.some((item) => item.wipeId === 'wipe_bulk_delete_active' && (item.memberId === 'member_bulk_delete_1' || item.memberId === 'member_bulk_delete_2')), false);
    assert.equal(bulkDeletedStore.wipeParticipants.some((item) => item.wipeId === 'wipe_bulk_delete_active' && item.steamId === '76561198000000006'), false);
    assert.equal(bulkDeletedStore.kdaRows.some((item) => item.wipeId === 'wipe_bulk_delete_active' && item.steamId === '76561198000000006'), false);
    assert.equal(bulkDeletedStore.kdaSnapshots.some((item) => item.wipeId === 'wipe_bulk_delete_active' && item.steamId === '76561198000000007'), false);
    assert.equal(bulkDeletedStore.wipeParticipants.some((item) => item.wipeId === 'wipe_bulk_delete_closed' && item.memberId === 'member_bulk_delete_1'), true);
    assert.equal(bulkDeletedStore.kdaRows.some((item) => item.wipeId === 'wipe_bulk_delete_closed' && item.memberId === 'member_bulk_delete_1'), true);
    assert.equal(bulkDeletedStore.kdaSnapshots.some((item) => item.wipeId === 'wipe_bulk_delete_closed' && item.memberId === 'member_bulk_delete_2'), true);
    assert.equal(bulkDeletedStore.memberProfiles.some((item) => item.memberId === 'member_bulk_delete_1' || item.memberId === 'member_bulk_delete_2'), false);
    assert.equal(bulkDeletedStore.accountAlertDismissals.some((item) => item.memberId === 'member_bulk_delete_1' || item.memberId === 'member_bulk_delete_2'), false);
    assert.equal(bulkDeletedStore.users.some((user) => user.id === 'user_bulk_delete_member_account'), false);
    assert.equal(bulkDeletedStore.sessions.some((session) => session.userId === 'user_bulk_delete_member_account'), false);
    const preservedBulkManager = bulkDeletedStore.users.find((user) => user.id === 'user_bulk_delete_manager_account');
    assert.equal(Boolean(preservedBulkManager), true);
    assert.equal(preservedBulkManager.boundSteamId, '76561198000000007');
    assert.equal(Boolean(preservedBulkManager.loginProviders?.steam), true);
    assert.equal(bulkDeletedStore.users.some((user) => user.id === 'user_deleted_member_orphan_account'), true);
    result = await request('/users/cleanup-orphan-member-accounts', { method: 'POST' });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.cleanup.deleted, 1);
    assert.equal(result.payload.users.some((user) => user.id === 'user_deleted_member_orphan_account'), false);
    const cleanupStore = await readStore();
    assert.equal(cleanupStore.sessions.some((session) => session.userId === 'user_deleted_member_orphan_account'), false);
    assert.equal(cleanupStore.users.find((user) => user.id === 'user_bulk_delete_manager_account').boundSteamId, '76561198000000007');
    const preservedSettlement = bulkDeletedStore.wipeSettlements.find((settlement) => settlement.wipeId === 'wipe_bulk_delete_closed');
    assert.equal(preservedSettlement.participantsSnapshot.length, 2);
    assert.equal(preservedSettlement.kdaSnapshot.length, 2);
    await updateStore((store) => {
      const createdAt = nowIso();
      store.members.push({
        id: 'member_recreated_same_steam',
        steamId: '76561198000000006',
        rawInput: '76561198000000006',
        customName: 'Current Recreated',
        steamNickname: 'CurrentRecreatedSteam',
        avatar: '',
        discordId: '',
        wechatId: '',
        notes: '',
        specialty: [],
        invitedByUserId: 'user_root',
        createdAt,
        updatedAt: createdAt
      });
    });
    result = await request('/wipes/wipe_bulk_delete_closed?scope=all&sort=kills&order=desc');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.participants.length, 2);
    assert.equal(result.payload.rows.length, 2);
    assert.equal(result.payload.rows[0].kills, 21);
    assert.equal(result.payload.rows[0].member.customName, 'Bulk Delete Actor');
    result = await request('/wipes/wipe_bulk_delete_closed?scope=all&sort=kills&order=desc&from=1970-01-01T00%3A00%3A00.000Z&to=2999-01-01T00%3A00%3A00.000Z');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.rows.length, 2);
    assert.equal(result.payload.rows.some((row) => row.member.steamId === '76561198000000006' && row.kills === 21), true);
    assert.equal(result.payload.rows.find((row) => row.member.steamId === '76561198000000006').member.customName, 'Bulk Delete Actor');
    assert.equal(result.payload.rows.some((row) => row.member.steamId === '76561198000000007' && row.kills === 17), true);
    const bulkDeleteLog = bulkDeletedStore.logs.find((log) => log.type === 'member_bulk_delete' && log.metadata?.deleted === 2);
    assert.equal(bulkDeleteLog.metadata.deleted, 2);

    const rootCookie = cookie;
    cookie = '';
    result = await request('/auth/login', { method: 'POST', body: { username: 'leader_other', password: 'LeaderPass123!' } });
    assert.equal(result.response.status, 200);
    result = await request('/profile', { method: 'PUT', body: { boundSteamInput: '76561198000000002' } });
    assert.equal(result.response.status, 409);
    assert.equal(result.payload.error, '该 SteamID 已被其他成员记录使用');
    cookie = rootCookie;

    result = await request('/wipes', {
      method: 'POST',
      body: {
        serverName: 'VT Workflow Server',
        name: 'VT Workflow Wipe',
        vitalServerId: '23',
        vitalWipeId: 'wipe-test'
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.wipe.serverName, 'Vital Rust Workflow Server');
    assert.equal(result.payload.wipe.name, 'Vital Rust Workflow Wipe');
    assert.equal(result.payload.wipe.battlemetricsId, '36933209');
    const wipeId = result.payload.wipe.id;
    const startedAt = new Date(Date.now() - (3 * 86_400_000)).toISOString();
    await updateStore((store) => {
      const wipe = store.wipes.find((item) => item.id === wipeId);
      if (wipe) {
        wipe.startedAt = startedAt;
        wipe.mapLink = 'https://cdn.example.com/workflow.map';
        wipe.rustMapsLink = 'https://rustmaps.com/map/workflow-map';
        wipe.rustMapsImageUrl = '/uploads/map-files/workflow-map-preview.png';
      }
      store.uploads.unshift({
        id: 'upload_discord_map_preview',
        ownerType: 'wipe',
        ownerId: wipeId,
        kind: 'map_image',
        fileName: 'workflow-map-preview.png',
        originalName: 'workflow-map-preview.png',
        mimeType: 'image/png',
        size: 68,
        url: '/uploads/map-files/workflow-map-preview.png',
        createdBy: 'user_root',
        createdAt: startedAt
      });
    });

    const rootCookieBeforeSelfSignup = cookie;
    cookie = steamMemberCookie;
    result = await request(`/wipes/${wipeId}/my-signup`, { method: 'POST', body: { status: 'on_time' } });
    assert.equal(result.response.status, 200);
    let selfSignup = result.payload.participants.find((participant) => participant.memberId === 'member_steam_login');
    assert.equal(Boolean(selfSignup), true);
    assert.equal(selfSignup.status, 'on_time');
    assert.equal(selfSignup.source, 'web');
    result = await request(`/wipes/${wipeId}/my-signup`, { method: 'POST', body: { status: 'late' } });
    assert.equal(result.response.status, 200);
    selfSignup = result.payload.participants.find((participant) => participant.memberId === 'member_steam_login');
    assert.equal(selfSignup.status, 'join_16h');
    result = await request(`/wipes/${wipeId}/my-signup`, { method: 'POST', body: { status: 'skip' } });
    assert.equal(result.response.status, 200);
    selfSignup = result.payload.participants.find((participant) => participant.memberId === 'member_steam_login');
    assert.equal(selfSignup.status, 'not_attending');
    let selfSignupStore = await readStore();
    let selfSignupMember = selfSignupStore.members.find((member) => member.id === 'member_steam_login');
    assert.equal(selfSignupMember.notAttendingCount, 1);
    assert.equal(selfSignupMember.lastNotAttendingWipeId, wipeId);
    result = await request(`/wipes/${wipeId}/my-signup`, { method: 'POST', body: { status: 'join_16h' } });
    assert.equal(result.response.status, 200);
    selfSignup = result.payload.participants.find((participant) => participant.memberId === 'member_steam_login');
    assert.equal(selfSignup.status, 'join_16h');
    selfSignupStore = await readStore();
    selfSignupMember = selfSignupStore.members.find((member) => member.id === 'member_steam_login');
    assert.equal(selfSignupMember.notAttendingCount, 1);
    cookie = rootCookieBeforeSelfSignup;

    const discordUserId = '123456789012345679';
    const discordPrimaryManageRoleId = '123456789012345674';
    const discordSecondaryManageRoleId = '123456789012345699';
    const discordMemberManageRoleIds = `${discordPrimaryManageRoleId},${discordSecondaryManageRoleId}`;
    const discordKeys = crypto.generateKeyPairSync('ed25519');
    const publicKeyDer = discordKeys.publicKey.export({ type: 'spki', format: 'der' });
    const discordPublicKey = Buffer.from(publicKeyDer).subarray(-32).toString('hex');
    await updateStore((store) => {
      const member = store.members.find((item) => item.id === 'member_test_1');
      if (member) member.discordId = discordUserId;
    });
    const discordSettingsBody = {
      botToken: 'discord_bot_token_123456789012345',
      publicKey: discordPublicKey,
      guildId: '123456789012345670',
      channelId: '123456789012345671',
      memberRegisterChannelId: '123456789012345676',
      memberReviewChannelId: '123456789012345675',
      mapChannelId: '123456789012345686',
      kdaQueryChannelId: '123456789012345677',
      memberRankingChannelId: '123456789012345687',
      applicationId: '123456789012345672',
      memberRegisterRoleId: '123456789012345673',
      memberManageRoleId: discordMemberManageRoleIds,
      memberRegisterSquadName: '57',
      memberRegisterRoleSquadRules: [
        { id: 'alpha_rule', roleId: '123456789012345673', roleName: 'Spoofed role', squadId: 'squad_test_1' },
        { id: 'bravo_rule', roleId: '123456789012345697', roleName: 'Spoofed role', squadId: 'squad_test_2' }
      ],
      commandHint: '/wipe',
      templateTitle: '🚨 {serverName} WIPE 🚨',
      templateBody: [
        '🗓️ {dateLabel}: {wipeDate} 🕖 {timeLabel}: {wipeTime}',
        '',
        '{wipeAttendanceLabel}',
        '{chooseStatus}',
        '',
        '✅ {attendingLabel}',
        '🕒 {lateLabel}',
        '❔ {unsureLabel}',
        '❌ {cancelSignupLabel}',
        '',
        '{vipLegend}',
        '',
        '{squadAttendanceSummary}'
      ].join('\n')
    };
    const rootCookieBeforeDiscordSettings = cookie;
    cookie = '';
    result = await request('/auth/login', { method: 'POST', body: { username: 'logo_admin', password: 'AdminLogo123!' } });
    assert.equal(result.response.status, 200);
    const nonRootAdminCookie = cookie;
    result = await request('/settings/discord', {
      method: 'PUT',
      body: discordSettingsBody
    });
    assert.equal(result.response.status, 200);
    cookie = rootCookieBeforeDiscordSettings;
    assert.equal(result.payload.discord.enabled, true);
    assert.equal(result.payload.discord.commandHint, '/wipe');
    assert.equal(result.payload.discord.memberRegisterChannelId, '123456789012345676');
    assert.equal(result.payload.discord.memberReviewChannelId, '123456789012345675');
    assert.equal(result.payload.discord.mapChannelId, '123456789012345686');
    assert.equal(result.payload.discord.kdaQueryChannelId, '123456789012345677');
    assert.equal(result.payload.discord.memberRankingChannelId, '123456789012345687');
    assert.equal(result.payload.discord.channelName, 'wipe-attendance');
    assert.equal(result.payload.discord.mapChannelName, 'map-push');
    assert.equal(result.payload.discord.memberRankingChannelName, 'member-ranking');
    assert.equal(result.payload.discord.memberManageRoleId, discordMemberManageRoleIds);
    assert.deepEqual(result.payload.discord.memberRegisterRoleSquadRules.map((rule) => [rule.roleId, rule.squadId]), [
      ['123456789012345673', 'squad_test_1'],
      ['123456789012345697', 'squad_test_2']
    ]);
    assert.deepEqual(result.payload.discord.memberRegisterRoleSquadRules.map((rule) => rule.roleName), ['PVP Squad', 'Builder Squad']);
    assert.equal(result.payload.discord.targets.length, 1);
    assert.equal(result.payload.discord.targets[0].id, 'default');
    assert.equal(result.payload.discord.targets[0].channelId, '123456789012345671');
    assert.equal(result.payload.discord.targets[0].mapChannelId, '123456789012345686');
    assert.equal(result.payload.discord.targets[0].channelName, 'wipe-attendance');
    assert.equal(result.payload.discord.targets[0].mapChannelName, 'map-push');
    assert.equal(result.payload.discord.targets[0].memberRankingChannelName, 'member-ranking');
    assert.equal(Boolean(result.payload.discord.targets[0].discordMetadataSyncedAt), true);
    assert.equal(result.payload.discord.targets[0].discordMetadataSyncError, '');
    assert.equal(result.payload.discord.tokenMasked, 'disc********2345');
    assert.equal(result.payload.discord.interactionsEndpoint, '/api/integrations/discord/interactions');
    assert.match(result.payload.discord.templateBody, /\{wipeDate\}/);
    assert.match(result.payload.discord.templateBody, /\{squadAttendanceSummary\}/);
    assert.match(result.payload.discord.templateBody, /\{joinIn8hLabel\}/);
    assert.match(result.payload.discord.templateBody, /\{joinIn16hLabel\}/);
    assert.match(result.payload.discord.templateBody, /\{notAttendingLabel\}/);
    assert.doesNotMatch(result.payload.discord.templateBody, /\{lateLabel\}/);
    assert.doesNotMatch(result.payload.discord.templateBody, /\{unsureLabel\}/);
    assert.doesNotMatch(result.payload.discord.templateBody, /\{cancelSignupLabel\}/);
    assert.deepEqual(result.payload.discord.availableCommands, [
      '/wipe · Push wipe registration card',
      '/kda · Query member KDA data; leave channel empty to allow all channels. Replies auto-delete.',
      'Buttons: Attending / Join in 8h / Join in 16h / Not Attending',
      'Persistent card: Register Member + VIP update',
      'Persistent card: Current server member ranking Top 20',
      'Persistent card: Current server map preview'
    ]);

    discordMetadataUnavailable = true;
    result = await request('/settings/discord', {
      method: 'PUT',
      body: {
        ...discordSettingsBody,
        channelId: '123456789012345688',
        channelName: 'Spoofed channel',
        memberRegisterRoleSquadRules: discordSettingsBody.memberRegisterRoleSquadRules.map((rule) => ({ ...rule, roleName: 'Spoofed role again' }))
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.discord.channelId, '123456789012345688');
    assert.equal(result.payload.discord.channelName, '');
    assert.equal(result.payload.discord.mapChannelName, 'map-push');
    assert.deepEqual(result.payload.discord.memberRegisterRoleSquadRules.map((rule) => rule.roleName), ['PVP Squad', 'Builder Squad']);
    assert.match(result.payload.discord.discordMetadataSyncError, /metadata unavailable/);
    result = await request('/settings/discord', {
      method: 'PUT',
      body: {
        ...discordSettingsBody,
        guildId: '123456789012345689'
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.discord.channelName, '');
    assert.equal(result.payload.discord.mapChannelName, '');
    assert.equal(result.payload.discord.memberRankingChannelName, '');
    assert.deepEqual(result.payload.discord.memberRegisterRoleSquadRules.map((rule) => rule.roleName), ['', '']);
    discordMetadataUnavailable = false;
    result = await request('/settings/discord', { method: 'PUT', body: discordSettingsBody });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.discord.channelName, 'wipe-attendance');
    assert.equal(result.payload.discord.discordMetadataSyncError, '');

    const auditValidDiscordId = '123456789012345681';
    const auditMissingRoleDiscordId = '123456789012345682';
    const auditNotInGuildDiscordId = '123456789012345683';
    const auditMemberIds = ['member_discord_audit_valid', 'member_discord_audit_missing_role', 'member_discord_audit_not_in_guild'];
    await updateStore((store) => {
      const createdAt = new Date().toISOString();
      store.members.push(
        {
          id: auditMemberIds[0],
          steamId: '76561198000007001',
          rawInput: '76561198000007001',
          customName: 'Audit Valid',
          steamNickname: 'AuditValidSteam',
          avatar: '',
          discordId: auditValidDiscordId,
          discordName: 'AuditValid',
          wechatId: '',
          notes: '',
          specialty: [],
          memberStatus: 'active',
          createdAt,
          updatedAt: createdAt
        },
        {
          id: auditMemberIds[1],
          steamId: '76561198000007002',
          rawInput: '76561198000007002',
          customName: 'Audit Missing Role',
          steamNickname: 'AuditMissingRoleSteam',
          avatar: '',
          discordId: auditMissingRoleDiscordId,
          discordName: 'AuditMissingRole',
          wechatId: '',
          notes: '',
          specialty: [],
          memberStatus: 'active',
          createdAt,
          updatedAt: createdAt
        },
        {
          id: auditMemberIds[2],
          steamId: '76561198000007003',
          rawInput: '76561198000007003',
          customName: 'Audit Not In Guild',
          steamNickname: 'AuditNotInGuildSteam',
          avatar: '',
          discordId: auditNotInGuildDiscordId,
          discordName: 'AuditNotInGuild',
          wechatId: '',
          notes: '',
          specialty: [],
          memberStatus: 'active',
          createdAt,
          updatedAt: createdAt
        }
      );
      store.squadMembers.push(
        { id: 'squad_member_discord_audit_valid', squadId: 'squad_test_1', memberId: auditMemberIds[0], addedByUserId: 'user_root', createdAt },
        { id: 'squad_member_discord_audit_missing_role', squadId: 'squad_test_1', memberId: auditMemberIds[1], addedByUserId: 'user_root', createdAt },
        { id: 'squad_member_discord_audit_not_in_guild', squadId: 'squad_test_1', memberId: auditMemberIds[2], addedByUserId: 'user_root', createdAt }
      );
    });
    discordGuildMembers.set(`${discordSettingsBody.guildId}:${auditValidDiscordId}`, {
      username: 'AuditValid',
      nick: 'Audit Valid Nick',
      roles: ['123456789012345673']
    });
    discordGuildMembers.set(`${discordSettingsBody.guildId}:${auditMissingRoleDiscordId}`, {
      username: 'AuditMissingRole',
      globalName: 'Audit Missing Global',
      roles: ['123456789012345698']
    });

    result = await request('/discord/member-audit');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.configuration.configured, true);
    assert.equal(result.payload.candidates.some((item) => auditMemberIds.includes(item.member.id)), false);

    result = await request('/discord/member-audit/run', { method: 'POST', body: {} });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.summary.notInGuild >= 1, true);
    assert.equal(result.payload.summary.missingRole >= 1, true);
    assert.equal(result.payload.summary.currentFlagged >= 2, true);
    assert.equal(discordGuildMemberRequests.some((requestItem) => requestItem.userId === auditValidDiscordId), true);
    const auditCandidates = new Map(result.payload.candidates.map((item) => [item.member.id, item]));
    assert.equal(auditCandidates.get(auditMemberIds[1]).audit.status, 'missing_role');
    assert.equal(auditCandidates.get(auditMemberIds[2]).audit.status, 'not_in_guild');
    assert.deepEqual(auditCandidates.get(auditMemberIds[1]).audit.expectedRoles, [
      { id: '123456789012345673', name: 'PVP Squad' }
    ]);
    assert.deepEqual(auditCandidates.get(auditMemberIds[1]).audit.actualRoles, [
      { id: '123456789012345698', name: 'Unassigned Role' }
    ]);
    assert.deepEqual(auditCandidates.get(auditMemberIds[2]).audit.actualRoles, []);
    assert.equal(auditCandidates.has(auditMemberIds[0]), false);

    let auditStore = await readStore();
    assert.equal(auditStore.members.some((member) => member.id === auditMemberIds[2]), true);
    assert.equal(auditStore.members.find((member) => member.id === auditMemberIds[1]).memberStatus, 'active');
    assert.equal(auditStore.members.find((member) => member.id === auditMemberIds[2]).memberStatus, 'active');
    assert.equal(auditStore.members.find((member) => member.id === auditMemberIds[0]).discordMembershipStatus, 'valid');
    assert.deepEqual(auditStore.members.find((member) => member.id === auditMemberIds[1]).discordMembershipExpectedRoleNames, ['PVP Squad']);
    assert.deepEqual(auditStore.members.find((member) => member.id === auditMemberIds[1]).discordMembershipActualRoleNames, ['Unassigned Role']);
    assert.equal(auditStore.members.find((member) => member.id === auditMemberIds[0]).discordName, 'Audit Valid Nick');
    assert.equal(auditStore.members.find((member) => member.id === auditMemberIds[1]).discordName, 'Audit Missing Global');

    discordGuildRoles = discordGuildRoles.map((role) => role.id === '123456789012345673' ? { ...role, name: 'PVP Squad Renamed' } : role);
    discordGuildMembers.set(`${discordSettingsBody.guildId}:${auditMissingRoleDiscordId}`, {
      username: 'AuditMissingRole',
      nick: 'Audit Missing Nick Renamed',
      roles: ['123456789012345698']
    });
    result = await request('/discord/member-audit/run', { method: 'POST', body: {} });
    assert.equal(result.response.status, 200);
    auditStore = await readStore();
    assert.deepEqual(auditStore.members.find((member) => member.id === auditMemberIds[1]).discordMembershipExpectedRoleNames, ['PVP Squad Renamed']);
    assert.equal(auditStore.members.find((member) => member.id === auditMemberIds[1]).discordName, 'Audit Missing Nick Renamed');

    discordMetadataUnavailable = true;
    discordGuildMembers.set(`${discordSettingsBody.guildId}:${auditMissingRoleDiscordId}`, {
      username: 'AuditMissingRole',
      nick: 'Audit Missing Nick Renamed',
      roles: ['123456789012345697']
    });
    result = await request('/discord/member-audit/run', { method: 'POST', body: {} });
    assert.equal(result.response.status, 200);
    auditStore = await readStore();
    assert.deepEqual(auditStore.members.find((member) => member.id === auditMemberIds[1]).discordMembershipExpectedRoleNames, ['PVP Squad Renamed']);
    assert.deepEqual(auditStore.members.find((member) => member.id === auditMemberIds[1]).discordMembershipActualRoleNames, ['123456789012345697']);
    discordMetadataUnavailable = false;

    result = await request('/members?response=minimal', { method: 'DELETE', body: { memberIds: auditMemberIds } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.deleted, auditMemberIds.length);
    auditStore = await readStore();
    assert.equal(auditStore.members.some((member) => auditMemberIds.includes(member.id)), false);

    const kookSettingsBody = {
      botToken: 'kook_bot_token_1234567890',
      verifyToken: 'kook_verify_token_123456',
      encryptKey: 'kook_encrypt_key_1234567890',
      guildId: 'kook_guild_123',
      channelId: 'kook_wipe_channel_123',
      memberRegisterChannelId: 'kook_register_channel_123',
      kdaQueryChannelId: 'kook_kda_channel_123',
      memberRankingChannelId: 'kook_ranking_channel_123'
    };
    result = await request('/settings/kook', {
      method: 'PUT',
      body: kookSettingsBody
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.kook.enabled, true);
    assert.equal(result.payload.kook.source, 'store');
    assert.equal(result.payload.kook.tokenMasked, 'kook********7890');
    assert.equal(result.payload.kook.encryptKeyMasked, 'kook********7890');
    assert.equal(result.payload.kook.verifyToken, '');
    assert.equal(result.payload.kook.verifyTokenConfigured, true);
    assert.equal(result.payload.kook.verifyTokenMasked, 'kook********3456');
    assert.equal(result.payload.kook.channelId, 'kook_wipe_channel_123');
    assert.equal(result.payload.kook.memberRegisterChannelId, 'kook_register_channel_123');
    assert.equal(result.payload.kook.kdaQueryChannelId, 'kook_kda_channel_123');
    assert.equal(result.payload.kook.memberRankingChannelId, 'kook_ranking_channel_123');
    assert.deepEqual([...result.payload.kook.enabledCommandIds].sort(), ['kookKda', 'kookMember', 'kookRanking', 'kookWipe'].sort());
    assert.equal(result.payload.kook.eventEndpoint, '/api/integrations/kook/events');
    const kookStoreSnapshot = await readStore();
    assert.equal(kookStoreSnapshot.settings.kook.botToken, 'kook_bot_token_1234567890');
    assert.equal(kookStoreSnapshot.settings.kook.encryptKey, 'kook_encrypt_key_1234567890');
    assert.equal(kookStoreSnapshot.logs.some((item) => item.type === 'kook_settings_edit'), true);
    await updateStore((store) => {
      delete store.settings.kook.enabledCommandIds;
    });
    result = await request('/settings/api');
    assert.equal(result.response.status, 200);
    assert.deepEqual([...result.payload.kook.enabledCommandIds].sort(), ['kookKda', 'kookMember', 'kookRanking', 'kookWipe'].sort());

    result = await request('/integrations/kook/events', {
      method: 'POST',
      body: {
        encrypt: encryptKookTestPayload({
          s: 0,
          d: {
            channel_type: 'WEBHOOK_CHALLENGE',
            challenge: 'kook_encrypted_challenge_ok',
            verify_token: 'kook_verify_token_123456'
          }
        }, 'kook_encrypt_key_1234567890')
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.challenge, 'kook_encrypted_challenge_ok');
    assert.equal(result.payload.encrypt, undefined);

    result = await request('/settings/kook', {
      method: 'PUT',
      body: {
        ...kookSettingsBody,
        botToken: '',
        encryptKey: '',
        clearEncryptKey: true,
        verifyToken: 'kook_verify_token_updated'
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.kook.tokenMasked, 'kook********7890');
    assert.equal(result.payload.kook.encryptKeyMasked, '');
    assert.equal(result.payload.kook.verifyToken, '');
    assert.equal(result.payload.kook.verifyTokenConfigured, true);
    assert.equal(result.payload.kook.verifyTokenMasked, 'kook********ated');

    result = await request('/settings/kook', {
      method: 'PUT',
      body: { ...kookSettingsBody, botToken: 'short' }
    });
    assert.equal(result.response.status, 400);
    assert.match(result.payload.error, /KOOK Bot Token length/);

    result = await request('/settings/discord/commands', { method: 'POST', body: {} });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.command.id, '123456789012345679');
    assert.equal(result.payload.command.name, 'wipe');
    assert.equal(result.payload.discord.wipeAttendanceCommandId, '123456789012345679');
    assert.equal(result.payload.discord.kdaCommandId, '123456789012345679');
    assert.equal(result.payload.commands.kda.name, 'kda');
    assert.equal(Boolean(result.payload.discord.lastCommandRegisterAt), true);
    const registeredWipeCommand = discordCommandRequests.find((request) => request.body.name === 'wipe');
    const registeredKdaCommand = discordCommandRequests.find((request) => request.body.name === 'kda');
    assert.equal(registeredWipeCommand.applicationId, '123456789012345672');
    assert.equal(registeredWipeCommand.guildId, '123456789012345670');
    assert.equal(registeredWipeCommand.authorization, 'Bot discord_bot_token_123456789012345');
    assert.equal(registeredWipeCommand.body.type, 1);
    assert.equal(registeredWipeCommand.body.description, 'Push the current Clan Portal wipe registration card.');
    assert.equal(registeredWipeCommand.body.description_localizations.tr, 'Geçerli Clan Portal wipe kayıt kartını gönder.');
    assert.equal(registeredWipeCommand.body.options[0].type, 5);
    assert.equal(registeredWipeCommand.body.options[0].name, 'mention_everyone');
    assert.equal(registeredWipeCommand.body.options[0].description, 'Mention @everyone when sending the wipe registration card.');
    assert.equal(registeredWipeCommand.body.options[0].description_localizations['zh-CN'], '发送 Wipe 登记卡片时是否 @everyone。');
    assert.equal(registeredWipeCommand.body.options[0].required, false);
    assert.equal(registeredWipeCommand.body.default_member_permissions, '8');
    assert.equal(registeredWipeCommand.body.dm_permission, false);
    assert.equal(registeredKdaCommand.applicationId, '123456789012345672');
    assert.equal(registeredKdaCommand.guildId, '123456789012345670');
    assert.equal(registeredKdaCommand.authorization, 'Bot discord_bot_token_123456789012345');
    assert.equal(registeredKdaCommand.body.type, 1);
    assert.equal(registeredKdaCommand.body.description, 'Query Clan Portal member KDA data.');
    assert.equal(registeredKdaCommand.body.description_localizations.tr, 'Clan Portal üye KDA verisini sorgula.');
    assert.equal(registeredKdaCommand.body.options[0].name, 'steam_input');
    assert.equal(registeredKdaCommand.body.options[0].required, true);
    assert.equal(registeredKdaCommand.body.dm_permission, false);

    discordRequest = null;
    result = await request('/wipes/current/discord-attendance/preview', { method: 'POST', body: { language: 'zh' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.language, 'zh');
    assert.equal(discordRequest, null);
    assert.match(result.payload.preview.embeds[0].description, /🗓️ 日期: <t:\d+:F>/);
    assert.match(result.payload.preview.embeds[0].description, /Wipe 报名/);
    assert.equal(result.payload.preview.content, '@everyone');
    assert.deepEqual(result.payload.preview.allowed_mentions, { parse: ['everyone'] });
    assert.equal(result.payload.preview.components[0].components.find((button) => button.custom_id === `nb_wipe_signup:on_time:${wipeId}`).label, '参加');
    assert.equal(result.payload.preview.components[1].components.find((button) => button.custom_id === 'nb_member_register:open').label, '登记成员');

    await updateStore((store) => {
      const createdAt = nowIso();
      store.squads.push(
        { id: 'squad_attendance_break_1', name: 'NB-EU', leaderUserId: '', notes: '', createdBy: 'user_root', createdAt, updatedAt: createdAt, archivedAt: '' },
        { id: 'squad_attendance_break_2', name: 'NB-CN', leaderUserId: '', notes: '', createdBy: 'user_root', createdAt, updatedAt: createdAt, archivedAt: '' }
      );
    });
    result = await request('/wipes/current/discord-attendance/preview', { method: 'POST', body: { language: 'en' } });
    assert.equal(result.response.status, 200);
    assert.doesNotMatch(result.payload.preview.embeds[0].description, /📊 Alpha Squad 0 attending/);
    assert.doesNotMatch(result.payload.preview.embeds[0].description, /📊 NB-EU 0 attending/);
    await updateStore((store) => {
      store.squads = store.squads.filter((squad) => !['squad_attendance_break_1', 'squad_attendance_break_2'].includes(squad.id));
    });

    await updateStore((store) => {
      const createdAt = nowIso();
      for (let index = 0; index < 42; index += 1) {
        const suffix = String(index + 1).padStart(3, '0');
        const steamId = `76561198000600${suffix}`;
        store.members.push({
          id: `member_attendance_balanced_${suffix}`,
          steamId,
          rawInput: steamId,
          customName: `Balanced ${suffix}`,
          steamNickname: `BalancedSteam${suffix}`,
          avatar: '',
          discordId: '',
          wechatId: '',
          notes: '',
          specialty: [],
          invitedByUserId: 'user_root',
          createdAt,
          updatedAt: createdAt
        });
        store.wipeParticipants.push({
          id: `wipe_participant_attendance_balanced_${suffix}`,
          wipeId,
          memberId: `member_attendance_balanced_${suffix}`,
          status: 'on_time',
          source: 'web',
          createdByUserId: 'user_root',
          updatedByUserId: 'user_root',
          createdAt,
          updatedAt: createdAt
        });
      }
    });
    result = await request('/wipes/current/discord-attendance/preview', { method: 'POST', body: { language: 'en', mentionEveryone: false } });
    assert.equal(result.response.status, 200);
    const balancedAttendanceFields = result.payload.preview.embeds[0].fields.filter((field) => field.name.startsWith('✅'));
    assert.equal(balancedAttendanceFields.length, 3);
    assert.equal(discordAttendanceFieldName(balancedAttendanceFields[0]), '✅ Attending (42)');
    assert.equal(balancedAttendanceFields[1].name, '✅');
    assert.equal(balancedAttendanceFields[2].name, '✅');
    assert.match(balancedAttendanceFields[0].value, /Balanced 014/);
    assert.doesNotMatch(balancedAttendanceFields[0].value, /Balanced 015/);
    assert.match(balancedAttendanceFields[1].value, /Balanced 015/);
    assert.match(balancedAttendanceFields[1].value, /Balanced 028/);
    assert.match(balancedAttendanceFields[2].value, /Balanced 029/);
    assert.match(balancedAttendanceFields[2].value, /Balanced 042/);
    assert.equal(result.payload.preview.embeds[0].fields[3].name, '\u200B');
    assert.equal(result.payload.preview.embeds[0].fields[3].inline, false);
    await updateStore((store) => {
      store.members = store.members.filter((member) => !member.id.startsWith('member_attendance_balanced_'));
      store.wipeParticipants = store.wipeParticipants.filter((participant) => !participant.id.startsWith('wipe_participant_attendance_balanced_'));
    });

    await updateStore((store) => {
      const createdAt = nowIso();
      for (let index = 0; index < 165; index += 1) {
        const suffix = String(index + 1).padStart(3, '0');
        const steamId = `76561198000700${suffix}`;
        store.members.push({
          id: `member_attendance_overflow_${suffix}`,
          steamId,
          rawInput: steamId,
          customName: `Overflow ${suffix}`,
          steamNickname: `OverflowSteam${suffix}`,
          avatar: '',
          discordId: '',
          wechatId: '',
          notes: '',
          specialty: [],
          invitedByUserId: 'user_root',
          createdAt,
          updatedAt: createdAt
        });
        store.wipeParticipants.push({
          id: `wipe_participant_attendance_overflow_${suffix}`,
          wipeId,
          memberId: `member_attendance_overflow_${suffix}`,
          status: 'on_time',
          source: 'web',
          createdByUserId: 'user_root',
          updatedByUserId: 'user_root',
          createdAt,
          updatedAt: createdAt
        });
      }
    });
    result = await request('/wipes/current/discord-attendance/preview', { method: 'POST', body: { language: 'en', mentionEveryone: false } });
    assert.equal(result.response.status, 200);
    const overflowAttendanceFields = result.payload.preview.embeds[0].fields.filter((field) => field.name.startsWith('✅'));
    assert.equal(overflowAttendanceFields.length, 3);
    assert.equal(discordAttendanceFieldName(overflowAttendanceFields[0]), '✅ Attending (165)');
    assert.equal(overflowAttendanceFields[1].name, '✅');
    assert.equal(overflowAttendanceFields[2].name, '✅');
    assert.match(overflowAttendanceFields[0].value, /Overflow 040/);
    assert.doesNotMatch(overflowAttendanceFields[0].value, /Overflow 041/);
    assert.match(overflowAttendanceFields[1].value, /Overflow 041/);
    assert.match(overflowAttendanceFields[2].value, /Overflow 081/);
    assert.match(overflowAttendanceFields[2].value, /Overflow 120/);
    assert.match(overflowAttendanceFields[2].value, /\+45 more/);
    assert.doesNotMatch(overflowAttendanceFields[2].value, /Overflow 121/);
    await updateStore((store) => {
      store.members = store.members.filter((member) => !member.id.startsWith('member_attendance_overflow_'));
      store.wipeParticipants = store.wipeParticipants.filter((participant) => !participant.id.startsWith('wipe_participant_attendance_overflow_'));
    });

    result = await request('/wipes/current/discord-attendance/preview', { method: 'POST', body: { language: 'zh', mentionEveryone: false } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.preview.content, '');
    assert.deepEqual(result.payload.preview.allowed_mentions, { parse: [] });

    result = await request('/wipes/current/discord-attendance', { method: 'POST', body: {} });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.message.id, '123456789012345678');
    assert.equal(result.payload.message.url, 'https://discord.com/channels/123456789012345670/123456789012345671/123456789012345678');
    assert.equal(discordRequest.channelId, '123456789012345671');
    assert.equal(discordRequest.authorization, 'Bot discord_bot_token_123456789012345');
    assert.equal(discordRequest.body.content, '@everyone');
    assert.deepEqual(discordRequest.body.allowed_mentions, { parse: ['everyone'] });
    assert.equal(discordRequest.body.embeds[0].title, '🚨 Vital Rust Workflow Server WIPE 🚨');
    assert.doesNotMatch(discordRequest.body.embeds[0].description, /A new wipe is almost here/);
    assert.match(discordRequest.body.embeds[0].description, /🗓️ Date: <t:\d+:F> 🕖 Time: <t:\d+:t>/);
    assert.match(discordRequest.body.embeds[0].description, /Wipe Attendance/);
    assert.match(discordRequest.body.embeds[0].description, /✅ Attending/);
    assert.match(discordRequest.body.embeds[0].description, /🕒 Join in 8h/);
    assert.match(discordRequest.body.embeds[0].description, /🕒 Join in 16h/);
    assert.match(discordRequest.body.embeds[0].description, /❌ Not Attending/);
    assert.doesNotMatch(discordRequest.body.embeds[0].description, /❔/);
    assert.doesNotMatch(discordRequest.body.embeds[0].description, /Unsure/);
    assert.doesNotMatch(discordRequest.body.embeds[0].description, /cancel signup/);
    assert.match(discordRequest.body.embeds[0].description, /VIP : 🟣 = No queue, 🟡 = Priority queue/);
    assert.doesNotMatch(discordRequest.body.embeds[0].description, /Signup Window/);
    assert.doesNotMatch(discordRequest.body.embeds[0].description, /Direct Connect:/);
    assert.doesNotMatch(discordRequest.body.embeds[0].description, /VIP: \[Buy VIP\]/);
    assert.doesNotMatch(discordRequest.body.embeds[0].description, /\[https:\/\/store\.vitalrust\.com\/package\/vip-us-monthly\]\(https:\/\/store\.vitalrust\.com\/package\/vip-us-monthly\)/);
    assert.doesNotMatch(discordRequest.body.embeds[0].description, /📊 Alpha Squad 0 attending/);
    assert.doesNotMatch(discordRequest.body.embeds[0].description, /Team signup:/);
    assert.doesNotMatch(discordRequest.body.embeds[0].description, /Created by root/);
    assert.equal(discordRequest.body.embeds[0].fields[0].name, '✅ Attending (0)');
    assert.equal(discordRequest.body.embeds[0].fields[1].name, '✅');
    assert.equal(discordRequest.body.embeds[0].fields[2].name, '✅');
    assert.equal(discordRequest.body.embeds[0].fields[3].name, '\u200B');
    assert.equal(discordRequest.body.embeds[0].fields[3].inline, false);
    assert.equal(discordRequest.body.embeds[0].fields[4].name, '🕒 Join in 8h (0)');
    assert.equal(discordRequest.body.embeds[0].fields[5].name, '🕒 Join in 16h (1)');
    assert.equal(discordRequest.body.embeds[0].fields[6].name, '❌ Not Attending (0)');
    assert.equal(findDiscordAttendanceField(discordRequest.body.embeds[0].fields, '✅ Attending (0)').value, '-');
    assert.equal(findDiscordAttendanceField(discordRequest.body.embeds[0].fields, '🕒 Join in 8h (0)').value, '-');
    const webSignupJoin16hField = findDiscordAttendanceField(discordRequest.body.embeds[0].fields, '🕒 Join in 16h (1)');
    assert.equal(Boolean(webSignupJoin16hField), true);
    assert.match(webSignupJoin16hField.value, /Steam Self/);
    assert.equal(findDiscordAttendanceField(discordRequest.body.embeds[0].fields, '❌ Not Attending (0)').value, '-');
    assert.equal(discordRequest.body.embeds[0].fields.at(-1).value, '\u200B');
    assert.equal(discordRequest.body.embeds[0].footer.text, 'Clan Portal Wipe Attendance\nCreated by root');
    assert.equal(discordRequest.body.components[0].components.find((button) => button.custom_id === `nb_wipe_signup:on_time:${wipeId}`).label, 'Attending');
    assert.equal(discordRequest.body.components[0].components.find((button) => button.custom_id === `nb_wipe_signup:join_8h:${wipeId}`).label, 'Join in 8h');
    assert.equal(discordRequest.body.components[0].components.find((button) => button.custom_id === `nb_wipe_signup:join_16h:${wipeId}`).label, 'Join in 16h');
    assert.equal(discordRequest.body.components[0].components.find((button) => button.custom_id === `nb_wipe_signup:not_attending:${wipeId}`).label, 'Not Attending');
    assert.equal(discordRequest.body.components[0].components.some((button) => button.custom_id === `nb_wipe_signup:late:${wipeId}`), false);
    assert.equal(discordRequest.body.components[0].components.some((button) => button.custom_id === `nb_wipe_signup:skip:${wipeId}`), false);
    assert.equal(discordRequest.body.components[0].components.some((button) => button.custom_id === `nb_wipe_signup:cancel:${wipeId}`), false);
    assert.equal(discordRequest.body.components[1].components.find((button) => button.custom_id === `nb_wipe_signup:connect:${wipeId}`).label, 'Copy Direct Connect');
    assert.equal(discordRequest.body.components[1].components.find((button) => button.custom_id === 'nb_member_register:open').label, 'Register Member');
    assert.equal(discordRequest.body.components[1].components.find((button) => button.label === 'Buy VIP').url, 'https://store.vitalrust.com/package/vip-us-monthly');

    const rustinityVipPurchaseDate = `${new Date().getUTCFullYear()}-06-20`;
    const rustinityVipExpiryDate = new Date(Date.now() + 28 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const rustinitySnapshot = {};
    await updateStore((store) => {
      const wipe = store.wipes.find((item) => item.id === wipeId);
      const member = store.members.find((item) => item.id === 'member_steam_login');
      rustinitySnapshot.wipe = {
        name: wipe.name,
        serverName: wipe.serverName,
        vitalServerId: wipe.vitalServerId,
        serverVipProvider: wipe.serverVipProvider,
        vipUrl: wipe.vipUrl
      };
      rustinitySnapshot.member = {
        vitalVipType: member.vitalVipType,
        vitalVipPurchasedAt: member.vitalVipPurchasedAt,
        vitalVipExpiresAt: member.vitalVipExpiresAt,
        rustinityVipType: member.rustinityVipType,
        rustinityVipPurchasedAt: member.rustinityVipPurchasedAt,
        rustinityVipExpiresAt: member.rustinityVipExpiresAt
      };
      wipe.name = 'Rustinity Workflow Wipe';
      wipe.serverName = 'Rustinity Workflow Server';
      wipe.vitalServerId = '';
      wipe.serverVipProvider = 'rustinity';
      wipe.vipUrl = 'https://rustinity.example/vip';
      member.vitalVipType = 'priority';
      member.vitalVipPurchasedAt = rustinityVipPurchaseDate;
      member.vitalVipExpiresAt = rustinityVipExpiryDate;
      member.rustinityVipType = 'queue_skip';
      member.rustinityVipPurchasedAt = rustinityVipPurchaseDate;
      member.rustinityVipExpiresAt = rustinityVipExpiryDate;
    });
    result = await request('/wipes/current/discord-attendance/preview', { method: 'POST', body: { language: 'en', mentionEveryone: false } });
    assert.equal(result.response.status, 200);
    assert.match(result.payload.preview.embeds[0].description, /VIP : 🟣 = No queue/);
    assert.doesNotMatch(result.payload.preview.embeds[0].description, /Priority queue/);
    const rustinityJoin16hField = findDiscordAttendanceField(result.payload.preview.embeds[0].fields, '🕒 Join in 16h (1)');
    assert.equal(Boolean(rustinityJoin16hField), true);
    assert.match(rustinityJoin16hField.value, /Steam Self 🟣/);
    assert.doesNotMatch(rustinityJoin16hField.value, /🟣VIP|🟡VIP/);
    result = await request(`/wipes/${wipeId}/participants`);
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.summary.vipProvider, 'rustinity');
    assert.equal(result.payload.summary.vipLabel, 'Rustinity VIP');
    assert.equal(result.payload.summary.prioritySupported, false);
    assert.equal(result.payload.summary.vip, 1);
    assert.equal(result.payload.summary.priority, 0);
    assert.equal(result.payload.summary.queueSkip, 1);
    const rustinityParticipant = result.payload.participants.find((participant) => participant.memberId === 'member_steam_login');
    assert.equal(rustinityParticipant.currentServerVip.provider, 'rustinity');
    assert.equal(rustinityParticipant.currentServerVip.type, 'queue_skip');
    assert.equal(rustinityParticipant.currentServerVip.active, true);
    await updateStore((store) => {
      const wipe = store.wipes.find((item) => item.id === wipeId);
      const member = store.members.find((item) => item.id === 'member_steam_login');
      Object.assign(wipe, rustinitySnapshot.wipe);
      Object.assign(member, rustinitySnapshot.member);
    });

    discordRequest = null;
    result = await request('/wipes/current/discord-attendance', { method: 'POST', body: { language: 'zh', mentionEveryone: false } });
    assert.equal(result.response.status, 200);
    assert.equal(discordRequest.channelId, '123456789012345671');
    assert.equal(discordRequest.body.content, '');
    assert.deepEqual(discordRequest.body.allowed_mentions, { parse: [] });
    assert.doesNotMatch(discordRequest.body.embeds[0].description, /创建人 root/);
    assert.match(discordRequest.body.embeds[0].description, /VIP：🟣 = 免排队，🟡 = 优先队列/);
    assert.doesNotMatch(discordRequest.body.embeds[0].description, /VIP: \[购买 VIP\]/);
    assert.doesNotMatch(discordRequest.body.embeds[0].description, /\[https:\/\/store\.vitalrust\.com\/package\/vip-us-monthly\]\(https:\/\/store\.vitalrust\.com\/package\/vip-us-monthly\)/);
    assert.doesNotMatch(discordRequest.body.embeds[0].description, /📊 Alpha Squad 0人参加/);
    assert.doesNotMatch(discordRequest.body.embeds[0].description, /队伍报名：/);
    assert.equal(discordRequest.body.embeds[0].footer.text, 'Clan Portal Wipe 报名\n创建人 root');
    assert.equal(discordRequest.body.components[0].components.find((button) => button.custom_id === `nb_wipe_signup:on_time:${wipeId}`).label, '参加');
    assert.equal(result.payload.discord.lastMessageLanguage, 'zh');

    result = await request('/settings/discord', {
      method: 'PUT',
      body: {
        ...discordSettingsBody,
        botToken: '',
        targets: [
          {
            id: 'default',
            name: 'Default Discord',
            guildId: '123456789012345670',
            channelId: '123456789012345671',
            memberRegisterChannelId: '123456789012345676',
            memberReviewChannelId: '123456789012345675',
            mapChannelId: '123456789012345686',
            kdaQueryChannelId: '123456789012345677',
            memberRankingChannelId: '123456789012345687',
            memberRegisterRoleId: '123456789012345673',
            memberManageRoleId: discordMemberManageRoleIds,
            memberRegisterSquadName: '57',
            memberRegisterRoleSquadRules: [
              { id: 'alpha_rule', roleId: '123456789012345673', squadId: 'squad_test_1' },
              { id: 'bravo_rule', roleId: '123456789012345697', squadId: 'squad_test_2' }
            ]
          },
          {
            id: 'secondary',
            name: 'Secondary Discord',
            guildId: '123456789012345690',
            channelId: '123456789012345691',
            memberRegisterChannelId: '123456789012345692',
            memberReviewChannelId: '123456789012345693',
            mapChannelId: '123456789012345698',
            kdaQueryChannelId: '123456789012345694',
            memberRankingChannelId: '123456789012345695',
            memberRegisterRoleId: '123456789012345696',
            memberManageRoleId: '123456789012345697',
            memberRegisterSquadName: '57',
            memberRegisterRoleSquadRules: [
              { id: 'secondary_rule', roleId: '123456789012345696', squadId: 'squad_test_2' }
            ]
          }
        ]
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.discord.channelId, '123456789012345671');
    assert.equal(result.payload.discord.targets.length, 2);
    assert.equal(result.payload.discord.targets[1].name, 'Secondary Discord');

    discordRequest = null;
    result = await request('/wipes/current/discord-attendance', { method: 'POST', body: { targetId: 'secondary' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.message.url, 'https://discord.com/channels/123456789012345690/123456789012345691/123456789012345678');
    assert.equal(discordRequest.channelId, '123456789012345691');
    assert.equal(result.payload.discord.targets.find((target) => target.id === 'secondary').lastMessageId, '123456789012345678');

    await updateStore((store) => {
      const createdAt = nowIso();
      store.discordMemberApplications.unshift({
        id: 'discord_member_application_missing_review_card_secondary_test',
        discordUserId: '123456789012345688',
        discordUsername: 'SecondaryMissingReview',
        displayName: 'SecondaryMissingReview',
        discordLanguage: 'en',
        adminReviewLanguage: 'en',
        discordTargetId: 'secondary',
        discordGuildId: '123456789012345690',
        discordChannelId: '123456789012345692',
        steamId: '76561198000007776',
        steamInput: '76561198000007776',
        rawInput: '76561198000007776',
        steamNickname: 'SecondaryMissingSteam',
        steamAvatar: '',
        specialties: ['pvp'],
        squadId: 'squad_test_2',
        squadName: 'Bravo Squad',
        status: 'pending',
        adminNote: '',
        reviewNote: '',
        reviewedByUserId: '',
        reviewedAt: '',
        memberId: '',
        createdAt,
        updatedAt: createdAt
      });
    });
    const missingReviewBackfill = await syncMissingDiscordMemberReviewCards({
      ids: ['discord_member_application_missing_review_card_secondary_test'],
      silent: false
    });
    assert.equal(missingReviewBackfill.checked, 1);
    assert.equal(missingReviewBackfill.pushed, 1);
    assert.equal(missingReviewBackfill.failed, 0);
    const missingReviewCard = await waitForDiscordRequest((request) => (
      request.channelId === '123456789012345693' &&
      request.body.embeds?.[0]?.fields?.some((field) => field.name === 'SteamID' && field.value === '76561198000007776')
    ));
    assert.equal(missingReviewCard.authorization, 'Bot discord_bot_token_123456789012345');
    assert.equal(missingReviewCard.body.embeds[0].fields.find((field) => field.name === 'Status').value, 'Pending');
    const backfilledReviewApplication = await waitForDiscordApplication((application) => (
      application.id === 'discord_member_application_missing_review_card_secondary_test' &&
      application.adminReviewChannelId === '123456789012345693' &&
      application.adminReviewMessageId === '123456789012345678' &&
      Boolean(application.adminReviewPushedAt)
    ));
    assert.equal(backfilledReviewApplication.adminReviewTargetId, 'secondary');
    await updateStore((store) => {
      store.discordMemberApplications = (store.discordMemberApplications || [])
        .filter((application) => application.id !== 'discord_member_application_missing_review_card_secondary_test');
    });

    async function postDiscordInteraction(body) {
      const rawBody = JSON.stringify(body);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = crypto
        .sign(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(rawBody)]), discordKeys.privateKey)
        .toString('hex');
      return fetch(`${baseUrl}/integrations/discord/interactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature-ed25519': signature,
          'x-signature-timestamp': timestamp
        },
        body: rawBody
      });
    }

    const unregisteredSignupResponse = await postDiscordInteraction({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_unregistered_signup',
      locale: 'zh-CN',
      member: { roles: ['123456789012345673'], user: { id: '123456789012345699', username: 'NoMemberYet' } },
      message: discordInteractionMessageFromRecord(discordRequest),
      data: { custom_id: `nb_wipe_signup:on_time:${wipeId}` }
    });
    assert.equal(unregisteredSignupResponse.status, 200);
    const unregisteredSignupPayload = await unregisteredSignupResponse.json();
    assert.equal(unregisteredSignupPayload.type, 6);
    const unregisteredSignupFollowup = await waitForDiscordFollowup((message) => message.token === 'interaction_token_unregistered_signup');
    assert.equal(unregisteredSignupFollowup.body.flags, 64);
    assert.match(unregisteredSignupFollowup.body.content, /还没有绑定成员资料/);
    assert.equal(unregisteredSignupFollowup.body.embeds[0].title, 'Clan Portal 成员登记 & VIP');
    assert.equal(unregisteredSignupFollowup.body.components[0].components.find((button) => button.custom_id === 'nb_member_register:open').label, '登记成员');
    const unregisteredSignupCustomId = `nb_wipe_signup:on_time:${wipeId}`;
    const unregisteredSignupOperationRun = await waitForStoreCondition((store) => (
      (store.operationRuns || []).find((run) => (
        run.type === 'discord_wipe_signup_interaction' &&
        run.platform === 'discord' &&
        run.status === 'succeeded' &&
        run.targetId === wipeId &&
        run.createdBy === 'discord:123456789012345699' &&
        run.metadata?.customId === unregisteredSignupCustomId &&
        run.metadata?.delivery === 'followup'
      ))
    ), { label: 'Discord signup deferred operation run succeeded' });
    const unregisteredSignupIntegrationEvent = await waitForStoreCondition((store) => (
      (store.integrationEvents || []).find((event) => (
        event.platform === 'discord' &&
        event.eventType === 'message_component' &&
        event.status === 'processed' &&
        event.operationRunId === unregisteredSignupOperationRun.id &&
        event.metadata?.customId === unregisteredSignupCustomId &&
        event.metadata?.backgroundResult === 'succeeded'
      ))
    ), { label: 'Discord signup deferred integration event processed' });
    assert.equal(unregisteredSignupIntegrationEvent.errorSummary, '');

    let commandResponse = await postDiscordInteraction({
      type: 2,
      application_id: '123456789012345672',
      token: 'interaction_token_command_denied',
      channel_id: '123456789012345671',
      guild_id: '123456789012345670',
      locale: 'en-US',
      member: { permissions: '0', roles: [], user: { id: '123456789012345683', username: 'DeniedCommand' } },
      data: { type: 1, name: 'wipe' }
    });
    assert.equal(commandResponse.status, 200);
    let commandPayload = await commandResponse.json();
    assert.equal(commandPayload.type, 4);
    assert.match(commandPayload.data.content, /member management permission/);

    discordRequest = null;
    commandResponse = await postDiscordInteraction({
      type: 2,
      application_id: '123456789012345672',
      token: 'interaction_token_command_admin',
      channel_id: '123456789012345671',
      guild_id: '123456789012345670',
      locale: 'en-US',
      member: { permissions: '8', roles: [], user: { id: '123456789012345684', username: 'AdminCommand' } },
      data: { type: 1, name: 'wipe' }
    });
    assert.equal(commandResponse.status, 200);
    commandPayload = await commandResponse.json();
    assert.equal(commandPayload.type, 4);
    assert.match(commandPayload.data.content, /Wipe registration card sent/);
    assert.equal(discordRequest.channelId, '123456789012345671');
    assert.equal(discordRequest.body.embeds[0].title, '🚨 Vital Rust Workflow Server WIPE 🚨');
    assert.equal(discordRequest.body.embeds[0].footer.text, 'Clan Portal Wipe Attendance\nCreated by AdminCommand');

    discordRequest = null;
    commandResponse = await postDiscordInteraction({
      type: 2,
      application_id: '123456789012345672',
      token: 'interaction_token_command_admin_no_mention',
      channel_id: '123456789012345671',
      guild_id: '123456789012345670',
      locale: 'en-US',
      member: { permissions: '8', roles: [], user: { id: '123456789012345684', username: 'AdminCommand' } },
      data: {
        type: 1,
        name: 'wipe',
        options: [{ type: 5, name: 'mention_everyone', value: false }]
      }
    });
    assert.equal(commandResponse.status, 200);
    commandPayload = await commandResponse.json();
    assert.equal(commandPayload.type, 4);
    assert.match(commandPayload.data.content, /Wipe registration card sent/);
    assert.equal(discordRequest.channelId, '123456789012345671');
    assert.equal(discordRequest.body.content, '');
    assert.deepEqual(discordRequest.body.allowed_mentions, { parse: [] });
    assert.equal(discordRequest.body.embeds[0].footer.text, 'Clan Portal Wipe Attendance\nCreated by AdminCommand');
    const wipeAttendanceDiscordRequest = discordRequest;

    await updateStore((store) => {
      store.members.push({
        id: 'member_discord_remove_test',
        steamId: '76561198000009999',
        rawInput: '76561198000009999',
        customName: 'Remove Target',
        steamNickname: 'RemoveTargetSteam',
        avatar: '',
        discordId: '123456789012345682',
        wechatId: '',
        notes: '',
        specialty: [],
        invitedByUserId: 'user_root',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    });

    discordRequest = null;
    result = await request('/settings/discord/member-registration-card/preview', { method: 'POST', body: { language: 'zh' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.language, 'zh');
    assert.equal(discordRequest, null);
    assert.equal(result.payload.preview.embeds[0].title, 'Clan Portal 成员登记 & VIP');
    assert.equal(result.payload.preview.components[0].components.find((button) => button.custom_id === 'nb_member_register:open').label, '登记成员');

    discordRequest = null;
    const rootCookieBeforeMemberRegistrationCard = cookie;
    cookie = nonRootAdminCookie;
    result = await request('/settings/discord/member-registration-card', { method: 'POST', body: {} });
    assert.equal(result.response.status, 200);
    cookie = rootCookieBeforeMemberRegistrationCard;
    assert.equal(result.payload.message.url, 'https://discord.com/channels/123456789012345670/123456789012345676/123456789012345678');
    assert.equal(discordRequest.channelId, '123456789012345676');
    assert.equal(discordRequest.body.embeds[0].title, 'Clan Portal Registration & VIP');
    assert.match(discordRequest.body.embeds[0].description, /SteamID and VIP/);
    assert.match(discordRequest.body.embeds[0].description, /3 days before VIP expiry/);
    assert.equal(discordRequest.body.embeds[0].footer.text, 'Clan Portal Member System');
    assert.equal(discordRequest.body.components[0].components.find((button) => button.custom_id === 'nb_member_register:open').label, 'Register Member');
    assert.equal(discordRequest.body.components[0].components.find((button) => button.custom_id === 'nb_vital_vip:open').label, 'Update info');
    assert.equal(discordRequest.body.components[0].components.some((button) => button.custom_id === 'nb_member_register:remove_open'), false);

    let vipResponse = await postDiscordInteraction({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_vip_unbound',
      locale: 'zh-CN',
      member: { roles: [], permissions: '0', user: { id: '123456789012345688', username: 'VipUnbound' } },
      message: discordRequest.body,
      data: { custom_id: 'nb_vital_vip:open' }
    });
    assert.equal(vipResponse.status, 200);
    let vipPayload = await vipResponse.json();
    assert.equal(vipPayload.type, 4);
    assert.match(vipPayload.data.content, /Registration Member/);

    vipResponse = await postDiscordInteraction({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_vip_open',
      locale: 'zh-CN',
      member: { roles: [], permissions: '0', user: { id: discordUserId, username: 'VipBound' } },
      message: discordRequest.body,
      data: { custom_id: 'nb_vital_vip:open' }
    });
    assert.equal(vipResponse.status, 200);
    vipPayload = await vipResponse.json();
    assert.equal(vipPayload.type, 4);
    assert.match(vipPayload.data.content, /请选择要更新的 VIP 平台/);
    assert.match(vipPayload.data.content, /Vital VIP/);
    assert.match(vipPayload.data.content, /Rustinity VIP/);
    assert.match(vipPayload.data.content, /Atlas VIP/);
    assert.equal(vipPayload.data.components[0].components[0].custom_id, 'nb_vital_vip:provider');
    assert.deepEqual(vipPayload.data.components[0].components[0].options.map((option) => option.value), ['vital', 'rustinity', 'atlas']);
    vipResponse = await postDiscordInteraction({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_vip_provider_rustinity',
      locale: 'zh-CN',
      member: { roles: [], permissions: '0', user: { id: discordUserId, username: 'VipBound' } },
      message: discordRequest.body,
      data: { custom_id: 'nb_vital_vip:provider', values: ['rustinity'] }
    });
    assert.equal(vipResponse.status, 200);
    vipPayload = await vipResponse.json();
    assert.equal(vipPayload.type, 4);
    assert.match(vipPayload.data.content, /Rustinity VIP/);
    assert.equal(vipPayload.data.components[0].components[0].custom_id, 'nb_vital_vip:type:rustinity');
    assert.deepEqual(vipPayload.data.components[0].components[0].options.map((option) => option.value), ['none', 'queue_skip']);
    vipResponse = await postDiscordInteraction({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_vip_type_rustinity',
      locale: 'zh-CN',
      member: { roles: [], permissions: '0', user: { id: discordUserId, username: 'VipBound' } },
      message: discordRequest.body,
      data: { custom_id: 'nb_vital_vip:type:rustinity', values: ['queue_skip'] }
    });
    assert.equal(vipResponse.status, 200);
    vipPayload = await vipResponse.json();
    assert.equal(vipPayload.type, 9);
    assert.equal(vipPayload.data.custom_id, 'nb_vital_vip:submit:rustinity:queue_skip');
    assert.equal(vipPayload.data.title, 'Rustinity VIP 信息更新');
    vipResponse = await postDiscordInteraction({
      type: 5,
      application_id: '123456789012345672',
      token: 'interaction_token_vip_submit_rustinity',
      locale: 'zh-CN',
      member: { roles: [], permissions: '0', user: { id: discordUserId, username: 'VipBound' } },
      data: {
        custom_id: 'nb_vital_vip:submit:rustinity:queue_skip',
        components: [
          { type: 18, component: { type: 3, custom_id: 'date_month', values: ['08'] } },
          { type: 18, component: { type: 4, custom_id: 'date_day', value: '2' } }
        ]
      }
    });
    assert.equal(vipResponse.status, 200);
    vipPayload = await vipResponse.json();
    assert.equal(vipPayload.type, 4);
    assert.match(vipPayload.data.content, /已更新 Rustinity VIP：免排队/);
    let vipStore = await readStore();
    let vipMember = vipStore.members.find((member) => member.id === 'member_test_1');
    assert.equal(vipMember.rustinityVipType, 'queue_skip');
    assert.equal(vipMember.rustinityVipPurchasedAt, `${new Date().getUTCFullYear()}-08-02`);
    assert.equal(vipStore.logs.some((item) => item.type === 'discord_rustinity_vip_update'), true);
    vipResponse = await postDiscordInteraction({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_vip_type',
      locale: 'zh-CN',
      member: { roles: [], permissions: '0', user: { id: discordUserId, username: 'VipBound' } },
      message: discordRequest.body,
      data: { custom_id: 'nb_vital_vip:type', values: ['queue_skip'] }
    });
    assert.equal(vipResponse.status, 200);
    vipPayload = await vipResponse.json();
    assert.equal(vipPayload.type, 9);
    assert.equal(vipPayload.data.custom_id, 'nb_vital_vip:submit:vital:queue_skip');
    assert.equal(vipPayload.data.title, 'Vital VIP 信息更新');
    assert.equal(vipPayload.data.components.length, 2);
    assert.equal(vipPayload.data.components[0].label, '购买月份');
    assert.equal(vipPayload.data.components[0].component.custom_id, 'date_month');
    assert.equal(vipPayload.data.components[1].label, '购买日期');
    assert.equal(vipPayload.data.components[1].component.custom_id, 'date_day');
    assert.equal(vipPayload.data.components[1].component.placeholder, '1-31');
    const currentVipYear = String(new Date().getUTCFullYear());
    const vipPurchaseDate = `${currentVipYear}-09-01`;
    const vipExpiryDate = `${currentVipYear}-09-29`;

    const invalidVipResponse = await postDiscordInteraction({
      type: 5,
      application_id: '123456789012345672',
      token: 'interaction_token_vip_submit_invalid_day',
      locale: 'zh-CN',
      member: { roles: [], permissions: '0', user: { id: discordUserId, username: 'VipBound' } },
      data: {
        custom_id: 'nb_vital_vip:submit:queue_skip',
        components: [
          { type: 18, component: { type: 3, custom_id: 'date_month', values: ['09'] } },
          { type: 18, component: { type: 4, custom_id: 'date_day', value: '32' } }
        ]
      }
    });
    assert.equal(invalidVipResponse.status, 200);
    const invalidVipPayload = await invalidVipResponse.json();
    assert.equal(invalidVipPayload.type, 4);
    assert.match(invalidVipPayload.data.content, /有效的购买月份和日期/);

    vipResponse = await postDiscordInteraction({
      type: 5,
      application_id: '123456789012345672',
      token: 'interaction_token_vip_submit',
      locale: 'zh-CN',
      member: { roles: [], permissions: '0', user: { id: discordUserId, username: 'VipBound' } },
      data: {
        custom_id: 'nb_vital_vip:submit:queue_skip',
        components: [
          { type: 18, component: { type: 3, custom_id: 'date_month', values: ['09'] } },
          { type: 18, component: { type: 4, custom_id: 'date_day', value: '1' } }
        ]
      }
    });
    assert.equal(vipResponse.status, 200);
    vipPayload = await vipResponse.json();
    assert.equal(vipPayload.type, 4);
    assert.match(vipPayload.data.content, /免排队/);
    vipStore = await readStore();
    vipMember = vipStore.members.find((member) => member.id === 'member_test_1');
    assert.equal(vipMember.vitalVipType, 'queue_skip');
    assert.equal(vipMember.vitalVipPurchasedAt, vipPurchaseDate);
    assert.equal(vipMember.vitalVipExpiresAt, vipExpiryDate);
    assert.equal(vipStore.logs.some((item) => item.type === 'discord_vital_vip_update'), true);
    vipResponse = await postDiscordInteraction({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_vip_type_none',
      locale: 'zh-CN',
      member: { roles: [], permissions: '0', user: { id: discordUserId, username: 'VipBound' } },
      message: discordRequest.body,
      data: { custom_id: 'nb_vital_vip:type', values: ['none'] }
    });
    assert.equal(vipResponse.status, 200);
    vipPayload = await vipResponse.json();
    assert.match(vipPayload.data.content, /无/);
    vipStore = await readStore();
    const clearedVipMember = vipStore.members.find((member) => member.id === 'member_test_1');
    assert.equal(clearedVipMember.vitalVipType, 'none');
    assert.equal(clearedVipMember.vitalVipPurchasedAt, '');
    assert.equal(clearedVipMember.vitalVipExpiresAt, '');
    const activePriorityVipPurchasedAt = new Date().toISOString().slice(0, 10);
    const activePriorityVipExpiresAt = new Date(Date.parse(`${activePriorityVipPurchasedAt}T00:00:00.000Z`) + 28 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await updateStore((store) => {
      const member = store.members.find((item) => item.id === 'member_test_1');
      if (member) {
        member.vitalVipType = 'priority';
        member.vitalVipPurchasedAt = activePriorityVipPurchasedAt;
        member.vitalVipExpiresAt = activePriorityVipExpiresAt;
      }
    });

    await updateStore((store) => {
      const createdAt = nowIso();
      store.kdaRows = store.kdaRows.filter((row) => row.id !== 'kda_discord_login_member_ranking');
      store.kdaRows.push({
        id: 'kda_discord_login_member_ranking',
        wipeId,
        memberId: 'member_discord_login',
        steamId: '76561198000012349',
        kills: 42,
        deaths: 2,
        assists: 5,
        t3Kills: 42,
        rockets: 4,
        sulfur: 42000,
        metalOre: 12000,
        building: 300,
        playTimeMinutes: 360,
        raw: {},
        source: 'manual',
        capturedAt: createdAt,
        syncedAt: createdAt
      });
    });

    discordRequest = null;
    result = await request('/settings/discord/member-ranking-card/preview', { method: 'POST', body: { language: 'tr' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.language, 'tr');
    assert.equal(discordRequest, null);
    assert.match(result.payload.preview.embeds[0].title, /Güncel sunucu üye sıralaması/);
    assert.equal(result.payload.preview.components.flatMap((row) => row.components).find((button) => button.custom_id === 'nb_member_ranking:mine').label, 'Benim sıralamam');

    discordRequest = null;
    result = await request('/settings/discord/member-ranking-card', { method: 'POST', body: {} });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.message.url, 'https://discord.com/channels/123456789012345670/123456789012345687/123456789012345678');
    assert.equal(discordRequest.channelId, '123456789012345687');
    assert.equal(discordRequest.body.embeds[0].title, 'Current server member ranking · T3 Kills Top 10');
    assert.doesNotMatch(discordRequest.body.embeds[0].description, /No ranking data/);
    assert.equal(discordRequest.body.embeds[0].fields.some((field) => /Discord Login Member/.test(field.name)), true);
    assert.equal(discordRequest.body.components[0].components.find((button) => button.custom_id === 'nb_member_ranking:metric:t3Kills').style, 1);
    assert.equal(discordRequest.body.components.flatMap((row) => row.components).find((button) => button.custom_id === 'nb_member_ranking:mine').label, 'My ranking');

    discordRequest = null;
    result = await request('/settings/discord/member-ranking-card', { method: 'POST', body: { language: 'tr' } });
    assert.equal(result.response.status, 200);
    assert.equal(discordRequest.channelId, '123456789012345687');
    assert.match(discordRequest.body.embeds[0].title, /Güncel sunucu üye sıralaması/);
    assert.equal(discordRequest.body.components.flatMap((row) => row.components).find((button) => button.custom_id === 'nb_member_ranking:mine').label, 'Benim sıralamam');
    assert.equal(result.payload.discord.lastMemberRankingLanguage, 'tr');

    const discordPostCountBeforeRankingRefresh = discordRequests.length;
    const discordEditCountBeforeRankingRefresh = discordMessageEdits.length;
    result = await request('/settings/discord/member-ranking-card/refresh', { method: 'POST', body: {} });
    assert.equal(result.response.status, 200);
    assert.equal(discordRequests.length, discordPostCountBeforeRankingRefresh);
    assert.equal(discordMessageEdits.length, discordEditCountBeforeRankingRefresh + 1);
    assert.equal(discordMessageEdits.at(-1).channelId, '123456789012345687');
    assert.equal(discordMessageEdits.at(-1).messageId, '123456789012345678');
    assert.match(discordMessageEdits.at(-1).body.embeds[0].title, /Güncel sunucu üye sıralaması/);
    assert.equal(result.payload.refresh.skipped, false);
    assert.equal(result.payload.refresh.results[0].skipped, false);
    assert.equal(result.payload.discord.lastMemberRankingRefreshError, '');
    let discordMessageRefStore = await readStore();
    const discordRankingRef = (discordMessageRefStore.integrationMessageRefs || []).find((ref) => (
      ref.platform === 'discord' &&
      ref.kind === 'member_ranking_card' &&
      ref.targetType === 'discord_target' &&
      ref.channelId === '123456789012345687' &&
      ref.messageId === '123456789012345678'
    ));
    assert.equal(Boolean(discordRankingRef), true);
    assert.equal(discordRankingRef.source, 'discord_member_ranking_card_refresh');

    const kookPostCountBeforeRanking = kookPosts.length;
    await updateStore((store) => {
      const member = store.members.find((item) => item.id === 'member_discord_login');
      if (member) member.customName = 'Dictator';
    });
    result = await request('/settings/kook/member-ranking-card/preview', { method: 'POST', body: { language: 'zh' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.language, 'zh');
    assert.equal(result.payload.preview.type, 10);
    assert.equal(result.payload.preview.cards[0].type, 'card');
    assert.match(result.payload.preview.cards[0].modules[0].text.content, /当前服务器成员数据排行/);
    assert.match(JSON.stringify(result.payload.preview.cards), /D\*\*\*ator/);
    assert.doesNotMatch(JSON.stringify(result.payload.preview.cards), /Dictator/);
    assert.equal(kookPosts.length, kookPostCountBeforeRanking);

    result = await request('/settings/kook/member-ranking-card', { method: 'POST', body: { language: 'zh' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.message.id, 'kook_message_1');
    assert.equal(result.payload.kook.lastMemberRankingLanguage, 'zh');
    assert.equal(result.payload.kook.lastMemberRankingMessageId, 'kook_message_1');
    let kookMessageRefStore = await readStore();
    let kookRankingRef = (kookMessageRefStore.integrationMessageRefs || []).find((ref) => (
      ref.platform === 'kook' &&
      ref.kind === 'member_ranking_card' &&
      ref.targetType === 'kook_target' &&
      ref.targetId === 'kook_ranking_channel_123' &&
      ref.channelId === 'kook_ranking_channel_123' &&
      ref.messageId === 'kook_message_1'
    ));
    assert.equal(Boolean(kookRankingRef), true);
    assert.equal(kookRankingRef.source, 'kook_member_ranking_card_push');
    assert.equal(kookPosts.at(-1).authorization, 'Bot kook_bot_token_1234567890');
    assert.equal(kookPosts.at(-1).body.type, 10);
    assert.equal(kookPosts.at(-1).body.target_id, 'kook_ranking_channel_123');
    const kookRankingCards = JSON.parse(kookPosts.at(-1).body.content);
    assert.equal(kookRankingCards[0].type, 'card');
    assert.match(JSON.stringify(kookRankingCards), /D\*\*\*ator/);
    assert.doesNotMatch(JSON.stringify(kookRankingCards), /Dictator/);
    assert.doesNotMatch(JSON.stringify(kookRankingCards), /#\d+\s+#\d+/);
    const kookRankingRowModules = kookRankingCards[0].modules.filter((module) => (
      module.type === 'section' &&
      /#\d+/.test(module.text?.content || '')
    ));
    assert.equal(kookRankingRowModules.length > 0, true);
    assert.equal(kookRankingRowModules.every((module) => !Object.hasOwn(module, 'mode')), true);
    assert.equal(kookRankingRowModules.every((module) => !Object.hasOwn(module, 'accessory')), true);
    const kookRankingButtons = kookRankingCards[0].modules.flatMap((module) => Array.isArray(module.elements) ? module.elements : []);
    const kookMetricButtons = kookRankingButtons.filter((button) => /^nb_kook_member_ranking:metric:/.test(button.value || ''));
    assert.equal(kookMetricButtons.length > 0, true);
    assert.equal(kookMetricButtons.every((button) => button.click === 'return-val'), true);
    assert.equal(kookRankingButtons.some((button) => button.value === 'nb_kook_member_ranking:mine'), false);
    const disabledKookMineButton = kookRankingButtons.find((button) => button.value === 'nb_kook_member_ranking:mine_disabled');
    assert.equal(disabledKookMineButton?.theme, 'secondary');
    assert.equal(disabledKookMineButton?.click, undefined);
    assert.match(disabledKookMineButton?.text?.content || '', /我的排名暂不可用/);

    const kookPostCountBeforeRankingRefresh = kookPosts.length;
    const kookUpdateCountBeforeRankingRefresh = kookUpdates.length;
    result = await request('/settings/kook/member-ranking-card/refresh', { method: 'POST', body: {} });
    assert.equal(result.response.status, 200);
    assert.equal(kookPosts.length, kookPostCountBeforeRankingRefresh);
    assert.equal(kookUpdates.length, kookUpdateCountBeforeRankingRefresh + 1);
    assert.equal(kookUpdates.at(-1).body.msg_id, 'kook_message_1');
    assert.equal(result.payload.refresh.skipped, false);
    assert.equal(result.payload.refresh.action, 'updated');
    assert.equal(result.payload.refresh.messageId, 'kook_message_1');
    assert.equal(result.payload.kook.lastMemberRankingRefreshError, '');
    kookMessageRefStore = await readStore();
    kookRankingRef = (kookMessageRefStore.integrationMessageRefs || []).find((ref) => (
      ref.platform === 'kook' &&
      ref.kind === 'member_ranking_card' &&
      ref.messageId === 'kook_message_1'
    ));
    assert.equal(kookRankingRef.source, 'kook_member_ranking_card_refresh');
    assert.equal(kookRankingRef.metadata.metric, 't3Kills');

    kookMessages.push({
      id: 'kook_old_ranking_duplicate',
      msg_id: 'kook_old_ranking_duplicate',
      target_id: 'kook_ranking_channel_123',
      type: 10,
      content: JSON.stringify(kookRankingCards),
      create_at: Date.now() - 10_000
    });
    const kookPostCountBeforeSecondRanking = kookPosts.length;
    const kookUpdateCountBeforeSecondRanking = kookUpdates.length;
    const kookDeleteCountBeforeSecondRanking = kookDeletes.length;
    result = await request('/settings/kook/member-ranking-card', { method: 'POST', body: { language: 'zh', metric: 'sulfur' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.message.id, 'kook_message_1');
    assert.equal(result.payload.message.action, 'updated');
    assert.equal(kookPosts.length, kookPostCountBeforeSecondRanking);
    assert.equal(kookUpdates.length, kookUpdateCountBeforeSecondRanking + 1);
    assert.equal(kookUpdates.at(-1).body.msg_id, 'kook_message_1');
    assert.equal(
      kookDeletes.slice(kookDeleteCountBeforeSecondRanking).some((item) => item.body.msg_id === 'kook_old_ranking_duplicate'),
      true
    );
    kookMessageRefStore = await readStore();
    const successfulCleanupRun = (kookMessageRefStore.operationRuns || []).find((run) => (
      run.type === 'kook_member_ranking_card_cleanup' &&
        run.platform === 'kook' &&
        run.status === 'succeeded' &&
        run.targetId === 'kook_ranking_channel_123' &&
        run.metadata?.deleted === '1'
    ));
    assert.equal(Boolean(successfulCleanupRun), true);
    const deletedDuplicateRef = (kookMessageRefStore.integrationMessageRefs || []).find((ref) => (
      ref.platform === 'kook' &&
        ref.kind === 'member_ranking_card' &&
        ref.targetType === 'kook_target' &&
        ref.targetId === 'kook_ranking_channel_123' &&
        ref.messageId === 'kook_old_ranking_duplicate' &&
        ref.status === 'deleted' &&
        ref.source === 'kook_member_ranking_card_cleanup'
    ));
    assert.equal(Boolean(deletedDuplicateRef), true);

    const failingDuplicateMessageId = 'kook_old_ranking_delete_fails';
    kookMessages.push({
      id: failingDuplicateMessageId,
      msg_id: failingDuplicateMessageId,
      target_id: 'kook_ranking_channel_123',
      type: 10,
      content: JSON.stringify(kookRankingCards),
      create_at: Date.now() - 9_000
    });
    failingKookDeleteMessageIds.add(failingDuplicateMessageId);
    result = await request('/settings/kook/member-ranking-card/refresh', { method: 'POST', body: {} });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.refresh.action, 'updated');
    kookMessageRefStore = await readStore();
    const failedCleanupRun = (kookMessageRefStore.operationRuns || []).find((run) => (
      run.type === 'kook_member_ranking_card_cleanup' &&
        run.platform === 'kook' &&
        run.status === 'failed' &&
        run.targetId === 'kook_ranking_channel_123' &&
        run.metadata?.failed === '1' &&
        /injected delete failure/.test(run.errorSummary || '')
    ));
    assert.equal(Boolean(failedCleanupRun), true);
    assert.equal(failedCleanupRun.retryable, true);
    const failedDuplicateRef = (kookMessageRefStore.integrationMessageRefs || []).find((ref) => (
      ref.platform === 'kook' &&
        ref.kind === 'member_ranking_card' &&
        ref.targetType === 'kook_target' &&
        ref.targetId === 'kook_ranking_channel_123' &&
        ref.messageId === failingDuplicateMessageId &&
        ref.status === 'failed' &&
        ref.source === 'kook_member_ranking_card_cleanup'
    ));
    assert.equal(Boolean(failedDuplicateRef), true);
    assert.equal(failedDuplicateRef.metadata.deleteFailed, true);
    assert.match(failedDuplicateRef.metadata.error, /injected delete failure/);
    failingKookDeleteMessageIds.clear();
    const failingDuplicateIndex = kookMessages.findIndex((message) => message.id === failingDuplicateMessageId || message.msg_id === failingDuplicateMessageId);
    if (failingDuplicateIndex >= 0) kookMessages.splice(failingDuplicateIndex, 1);
    await updateStore((store) => {
      store.kdaRows = store.kdaRows.filter((row) => row.id !== 'kda_discord_login_member_ranking');
    });

    discordRequest = null;
    result = await request('/settings/discord/map-card/preview', { method: 'POST', body: { language: 'zh' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.language, 'zh');
    assert.equal(discordRequest, null);
    assert.equal(result.payload.preview.embeds[0].title, '🗺️ Map Vital Rust Workflow Server');
    assert.equal(result.payload.preview.embeds[0].url, 'https://rustmaps.com/map/workflow-map');
    assert.match(result.payload.preview.embeds[0].description, /地图链接: https:\/\/rustmaps\.com\/map\/workflow-map/);
    assert.match(result.payload.preview.embeds[0].image.url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/uploads/map-files/workflow-map-preview\\.png$`));

    discordRequest = null;
    result = await request('/settings/discord/map-card', { method: 'POST', body: { language: 'zh' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.message.url, 'https://discord.com/channels/123456789012345670/123456789012345686/123456789012345678');
    assert.equal(discordRequest.channelId, '123456789012345686');
    assert.equal(discordRequest.body.embeds[0].title, '🗺️ Map Vital Rust Workflow Server');
    assert.equal(discordRequest.body.embeds[0].url, 'https://rustmaps.com/map/workflow-map');
    assert.match(discordRequest.body.embeds[0].image.url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/uploads/map-files/workflow-map-preview\\.png$`));
    assert.equal(result.payload.discord.lastMapLanguage, 'zh');
    assert.equal(Boolean(result.payload.discord.lastMapPushAt), true);

    let rankingResponse = await postDiscordInteraction({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_ranking_unbound',
      locale: 'zh-CN',
      member: { roles: [], permissions: '0', user: { id: '123456789012345689', username: 'RankUnbound' } },
      message: discordRequest.body,
      data: { custom_id: 'nb_member_ranking:mine' }
    });
    assert.equal(rankingResponse.status, 200);
    let rankingPayload = await rankingResponse.json();
    assert.equal(rankingPayload.type, 4);
    assert.match(rankingPayload.data.content, /没有成员绑定这个 Discord ID/);

    let removeResponse = await postDiscordInteraction({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_remove_denied',
      locale: 'en-US',
      member: { roles: [], permissions: '0', user: { id: '123456789012345680', username: 'DeniedRemove' } },
      message: discordRequest.body,
      data: { custom_id: 'nb_member_register:remove_open' }
    });
    assert.equal(removeResponse.status, 200);
    let removePayload = await removeResponse.json();
    assert.equal(removePayload.type, 4);
    assert.match(removePayload.data.content, /member management permission/);

    removeResponse = await postDiscordInteraction({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_remove_open',
      locale: 'en-US',
      member: { roles: ['123456789012345674'], permissions: '0', user: { id: '123456789012345680', username: 'AdminRemove' } },
      message: discordRequest.body,
      data: { custom_id: 'nb_member_register:remove_open' }
    });
    assert.equal(removeResponse.status, 200);
    removePayload = await removeResponse.json();
    assert.equal(removePayload.type, 9);
    assert.equal(removePayload.data.custom_id, 'nb_member_register:remove_submit');
    assert.equal(removePayload.data.title, 'Remove Member');
    assert.equal(removePayload.data.components[0].components[0].label, 'Discord user ID');
    assert.equal(removePayload.data.components[0].components[0].custom_id, 'discord_id_input');

    removeResponse = await postDiscordInteraction({
      type: 5,
      application_id: '123456789012345672',
      token: 'interaction_token_remove_submit',
      locale: 'en-US',
      member: { roles: ['123456789012345674'], permissions: '0', user: { id: '123456789012345680', username: 'AdminRemove' } },
      data: {
        custom_id: 'nb_member_register:remove_submit',
        components: [
          {
            type: 1,
            components: [
              { type: 4, custom_id: 'discord_id_input', value: '123456789012345682' }
            ]
          }
        ]
      }
    });
    assert.equal(removeResponse.status, 200);
    removePayload = await removeResponse.json();
    assert.equal(removePayload.type, 4);
    assert.match(removePayload.data.content, /Member removed/);
    let removeStore = await readStore();
    assert.equal(removeStore.members.some((member) => member.id === 'member_discord_remove_test'), false);
    assert.equal(removeStore.logs.some((item) => item.type === 'discord_member_remove'), true);

    result = await request(`/wipes/${wipeId}/screenshots`, {
      method: 'POST',
      body: {
        originalName: 'one-pixel.png',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
      }
    });
    assert.equal(result.response.status, 200);
    const uploadId = result.payload.wipe.screenshots[0].id;

    result = await request(`/wipes/${wipeId}/screenshots/${uploadId}`, { method: 'DELETE' });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.wipe.screenshots.length, 0);

    result = await request(`/wipes/${wipeId}/map-files`, {
      method: 'POST',
      body: {
        originalName: 'test.map',
        mimeType: 'application/octet-stream',
        kind: 'map_file',
        dataUrl: 'data:application/octet-stream;base64,dGVzdA=='
      }
    });
    assert.equal(result.response.status, 200);
    const mapUploadId = result.payload.wipe.mapFiles[0].id;

    result = await request(`/wipes/${wipeId}/map-files/${mapUploadId}`, { method: 'DELETE' });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.wipe.mapFiles.some((item) => item.id === mapUploadId), false);

    result = await request(`/wipes/${wipeId}/map-files`, {
      method: 'POST',
      body: {
        originalName: 'evil.html',
        mimeType: 'text/html',
        kind: 'map_file',
        dataUrl: 'data:text/html;base64,PGh0bWw+PC9odG1sPg=='
      }
    });
    assert.equal(result.response.status, 200);
    assert.match(result.payload.wipe.mapFiles[0].url, /\.map$/);
    const htmlNamedMapUploadId = result.payload.wipe.mapFiles[0].id;

    result = await request(`/wipes/${wipeId}/map-files/${htmlNamedMapUploadId}`, { method: 'DELETE' });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.wipe.mapFiles.some((item) => item.id === htmlNamedMapUploadId), false);

    result = await request(`/wipes/${wipeId}/screenshots`, {
      method: 'POST',
      body: {
        originalName: 'retained.png',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.wipe.screenshots.length, 1);

    result = await request(`/wipes/${wipeId}/participants`, { method: 'POST', body: { memberIds: ['member_test_1'] } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.participants.length, 2);
    assert.equal(result.payload.participants.some((participant) => participant.memberId === 'member_steam_login'), true);
    assert.equal(result.payload.kdaRefreshQueued, false);
    assert.equal(result.payload.syncQueued, 0);

    const connectBody = JSON.stringify({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_connect',
      locale: 'en-US',
      member: { user: { id: discordUserId } },
      data: { custom_id: `nb_wipe_signup:connect:${wipeId}` }
    });
    const connectTimestamp = String(Math.floor(Date.now() / 1000));
    const connectSignature = crypto
      .sign(null, Buffer.concat([Buffer.from(connectTimestamp), Buffer.from(connectBody)]), discordKeys.privateKey)
      .toString('hex');
    const connectResponse = await fetch(`${baseUrl}/integrations/discord/interactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature-ed25519': connectSignature,
        'x-signature-timestamp': connectTimestamp
      },
      body: connectBody
    });
    assert.equal(connectResponse.status, 200);
    const connectPayload = await connectResponse.json();
    assert.equal(connectPayload.type, 6);
    const connectFollowup = await waitForDiscordFollowup((message) => message.token === 'interaction_token_connect');
    assert.match(connectFollowup.body.content, /Direct Connect/);
    assert.match(connectFollowup.body.content, /client\.connect 168\.100\.163\.73:28014/);

    let registerResponse = await postDiscordInteraction({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_register_denied',
      locale: 'en-US',
      member: { roles: [], user: { id: '123456789012345681', username: 'DeniedRegister' } },
      message: discordRequest.body,
      data: { custom_id: 'nb_member_register:open' }
    });
    assert.equal(registerResponse.status, 200);
    let registerPayload = await registerResponse.json();
    assert.equal(registerPayload.type, 4);
    assert.equal(registerPayload.data.flags, 64);
    assert.match(registerPayload.data.content, /configured member registration role/);

    registerResponse = await postDiscordInteraction({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_register_open',
      member: { roles: ['123456789012345673'], user: { id: '123456789012345681', username: 'RegisterUser', avatar: 'register_avatar_hash' } },
      message: discordRequest.body,
      data: { custom_id: 'nb_member_register:open' }
    });
    assert.equal(registerResponse.status, 200);
    registerPayload = await registerResponse.json();
    assert.equal(registerPayload.type, 4);
    assert.equal(registerPayload.data.content, 'Choose a specialty for member registration.');
    assert.equal(registerPayload.data.components[0].components[0].custom_id, 'nb_member_register:specialty');
    assert.equal(registerPayload.data.components[0].components[0].placeholder, 'Choose specialty');
    assert.equal(registerPayload.data.components[0].components[0].options.find((option) => option.value === 'building').label, 'Building');
    assert.equal(registerPayload.data.components[0].components[0].options.find((option) => option.value === 'translator').label, 'Translator');
    assert.equal(registerPayload.data.components[0].components[0].options.some((option) => option.value === 'rich'), false);
    assert.equal(registerPayload.data.components[0].components[0].options.some((option) => option.value === 'pvp' && option.label === 'PVP'), true);

    registerResponse = await postDiscordInteraction({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_register_open_fallback',
      locale: 'fr-FR',
      member: { roles: ['123456789012345673'], user: { id: '123456789012345681', username: 'RegisterUser', avatar: 'register_avatar_hash' } },
      message: discordRequest.body,
      data: { custom_id: 'nb_member_register:open' }
    });
    assert.equal(registerResponse.status, 200);
    const fallbackRegisterPayload = await registerResponse.json();
    assert.equal(fallbackRegisterPayload.data.content, 'Choose a specialty for member registration.');
    assert.equal(fallbackRegisterPayload.data.components[0].components[0].placeholder, 'Choose specialty');

    registerResponse = await postDiscordInteraction({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_register_open_zh',
      locale: 'zh-CN',
      member: { roles: ['123456789012345673'], user: { id: '123456789012345681', username: 'RegisterUser' } },
      message: discordRequest.body,
      data: { custom_id: 'nb_member_register:open' }
    });
    assert.equal(registerResponse.status, 200);
    const zhRegisterPayload = await registerResponse.json();
    assert.equal(zhRegisterPayload.data.content, '请选择成员登记专长。');
    assert.equal(zhRegisterPayload.data.components[0].components[0].placeholder, '选择专长');
    assert.equal(zhRegisterPayload.data.components[0].components[0].options.find((option) => option.value === 'building').label, '建筑');
    assert.equal(zhRegisterPayload.data.components[0].components[0].options.find((option) => option.value === 'translator').label, '翻译官');
    assert.equal(zhRegisterPayload.data.components[0].components[0].options.some((option) => option.value === 'rich'), false);

    registerResponse = await postDiscordInteraction({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_register_specialty_zh',
      locale: 'zh-CN',
      member: { roles: ['123456789012345673'], user: { id: '123456789012345681', username: 'RegisterUser' } },
      message: discordRequest.body,
      data: { custom_id: 'nb_member_register:specialty', values: ['building'] }
    });
    assert.equal(registerResponse.status, 200);
    let zhModalPayload = await registerResponse.json();
    assert.equal(zhModalPayload.type, 4);
    assert.match(zhModalPayload.data.content, /VIP 信息/);
    assert.equal(zhModalPayload.data.components[0].components[0].placeholder, '选择 VIP 类型');
    registerResponse = await postDiscordInteraction({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_register_vip_type_zh',
      locale: 'zh-CN',
      member: { roles: ['123456789012345673'], user: { id: '123456789012345681', username: 'RegisterUser' } },
      message: discordRequest.body,
      data: { custom_id: 'nb_member_register:vip_type:building', values: ['none'] }
    });
    assert.equal(registerResponse.status, 200);
    zhModalPayload = await registerResponse.json();
    assert.equal(zhModalPayload.type, 9);
    assert.equal(zhModalPayload.data.title, '登记成员');
    assert.equal(zhModalPayload.data.components[0].label, 'SteamID / Steam 主页链接');
    assert.equal(zhModalPayload.data.components.length, 1);

    const localizedDiscordRegisterCases = [
      {
        locale: 'ru',
        content: 'Выберите специализацию для регистрации участника.',
        placeholder: 'Выберите специализацию',
        building: 'Строительство',
        modalTitle: 'Регистрация участника',
        modalLabel: 'SteamID / ссылка на профиль Steam'
      },
      {
        locale: 'tr',
        content: 'Üye kaydı için bir uzmanlık seç.',
        placeholder: 'Uzmanlık seç',
        building: 'İnşaat',
        modalTitle: 'Üye kaydı',
        modalLabel: 'SteamID / Steam profil bağlantısı'
      },
      {
        locale: 'th',
        content: 'เลือกความถนัดสำหรับการลงทะเบียนสมาชิก',
        placeholder: 'เลือกความถนัด',
        building: 'ก่อสร้าง',
        modalTitle: 'ลงทะเบียนสมาชิก',
        modalLabel: 'SteamID / Steam profile URL'
      },
      {
        locale: 'ko',
        content: '멤버 등록용 전문 분야를 선택하세요.',
        placeholder: '전문 분야 선택',
        building: '건축',
        modalTitle: '멤버 등록',
        modalLabel: 'SteamID / Steam 프로필 URL'
      }
    ];
    for (const item of localizedDiscordRegisterCases) {
      registerResponse = await postDiscordInteraction({
        type: 3,
        application_id: '123456789012345672',
        token: `interaction_token_register_open_${item.locale}`,
        locale: item.locale,
        member: { roles: ['123456789012345673'], user: { id: '123456789012345681', username: 'RegisterUser' } },
        message: discordRequest.body,
        data: { custom_id: 'nb_member_register:open' }
      });
      assert.equal(registerResponse.status, 200);
      const localizedRegisterPayload = await registerResponse.json();
      assert.equal(localizedRegisterPayload.data.content, item.content);
      assert.equal(localizedRegisterPayload.data.components[0].components[0].placeholder, item.placeholder);
      assert.equal(localizedRegisterPayload.data.components[0].components[0].options.find((option) => option.value === 'building').label, item.building);

      registerResponse = await postDiscordInteraction({
        type: 3,
        application_id: '123456789012345672',
        token: `interaction_token_register_specialty_${item.locale}`,
        locale: item.locale,
        member: { roles: ['123456789012345673'], user: { id: '123456789012345681', username: 'RegisterUser' } },
        message: discordRequest.body,
        data: { custom_id: 'nb_member_register:specialty', values: ['building'] }
      });
      assert.equal(registerResponse.status, 200);
      let localizedModalPayload = await registerResponse.json();
      assert.equal(localizedModalPayload.type, 4);
      registerResponse = await postDiscordInteraction({
        type: 3,
        application_id: '123456789012345672',
        token: `interaction_token_register_vip_type_${item.locale}`,
        locale: item.locale,
        member: { roles: ['123456789012345673'], user: { id: '123456789012345681', username: 'RegisterUser' } },
        message: discordRequest.body,
        data: { custom_id: 'nb_member_register:vip_type:building', values: ['none'] }
      });
      assert.equal(registerResponse.status, 200);
      localizedModalPayload = await registerResponse.json();
      assert.equal(localizedModalPayload.type, 9);
      assert.equal(localizedModalPayload.data.title, item.modalTitle);
      assert.equal(localizedModalPayload.data.components[0].label, item.modalLabel);
      assert.equal(localizedModalPayload.data.components.length, 1);
    }

    registerResponse = await postDiscordInteraction({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_register_specialty',
      locale: 'en-US',
      member: { roles: ['123456789012345673'], user: { id: '123456789012345681', username: 'RegisterUser', avatar: 'register_avatar_hash' } },
      message: discordRequest.body,
      data: { custom_id: 'nb_member_register:specialty', values: ['pvp'] }
    });
    assert.equal(registerResponse.status, 200);
    registerPayload = await registerResponse.json();
    assert.equal(registerPayload.type, 4);
    registerResponse = await postDiscordInteraction({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_register_vip_type',
      locale: 'en-US',
      member: { roles: ['123456789012345673'], user: { id: '123456789012345681', username: 'RegisterUser', avatar: 'register_avatar_hash' } },
      message: discordRequest.body,
      data: { custom_id: 'nb_member_register:vip_type:pvp', values: ['none'] }
    });
    assert.equal(registerResponse.status, 200);
    registerPayload = await registerResponse.json();
    assert.equal(registerPayload.type, 9);
    assert.equal(registerPayload.data.custom_id, 'nb_member_register:submit:pvp:none');
    assert.equal(registerPayload.data.title, 'Register Member');
    assert.equal(registerPayload.data.components[0].label, 'SteamID / Steam profile URL');
    assert.equal(registerPayload.data.components[0].component.custom_id, 'steam_input');
    assert.equal(registerPayload.data.components.length, 1);
    registerResponse = await postDiscordInteraction({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_register_vip_type_priority',
      locale: 'en-US',
      member: { roles: ['123456789012345673'], user: { id: '123456789012345681', username: 'RegisterUser', avatar: 'register_avatar_hash' } },
      message: discordRequest.body,
      data: { custom_id: 'nb_member_register:vip_type:pvp', values: ['priority'] }
    });
    assert.equal(registerResponse.status, 200);
    registerPayload = await registerResponse.json();
    assert.equal(registerPayload.type, 9);
    assert.equal(registerPayload.data.custom_id, 'nb_member_register:submit:pvp:priority');
    assert.equal(registerPayload.data.components.length, 3);
    assert.equal(registerPayload.data.components[0].component.custom_id, 'steam_input');
    assert.equal(registerPayload.data.components[1].component.custom_id, 'date_month');
    assert.equal(registerPayload.data.components[2].component.custom_id, 'date_day');
    const registerVipPurchaseDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const registerVipExpiryDate = new Date(Date.parse(`${registerVipPurchaseDate}T00:00:00.000Z`) + 28 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const registerVipReminderDate = new Date(Date.parse(`${registerVipExpiryDate}T00:00:00.000Z`) - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const registerVipPurchaseDisplay = registerVipPurchaseDate.slice(5);
    const registerVipExpiryDisplay = `<t:${Math.floor(Date.parse(registerVipExpiryDate + 'T16:00:00.000Z') / 1000)}:F>`;

    await updateStore((store) => {
      store.memberProfiles ||= [];
      store.memberProfiles = store.memberProfiles.filter((profile) => profile.memberId !== 'member_test_2');
      store.memberProfiles.push({
        memberId: 'member_test_2',
        steamId: '76561198000000004',
        playTimeMinutes: 6120,
        playTimeKnown: true,
        inventoryValue: 88.5,
        inventoryCurrency: 'USD',
        inventoryPublic: true,
        profilePublic: true,
        officialKda: {
          kills: 144,
          deaths: 205,
          assists: 0,
          kda: 0.7,
          rockets: 73,
          sulfur: 160500,
          metalOre: 236700,
          playTimeMinutes: 2316
        },
        officialKdaFetchedAt: new Date().toISOString(),
        officialKdaError: '',
        source: 'test',
        fetchedAt: new Date().toISOString()
      });
    });

    const discordRegisterSteamId = '76561198000007782';
    registerResponse = await postDiscordInteraction({
      type: 5,
      application_id: '123456789012345672',
      token: 'interaction_token_register_submit',
      locale: 'en-US',
      member: { roles: ['123456789012345697'], user: { id: '123456789012345681', username: 'RegisterUser', avatar: 'register_avatar_hash' } },
      data: {
        custom_id: 'nb_member_register:submit:pvp:priority',
        components: [
          { type: 18, component: { type: 4, custom_id: 'steam_input', value: discordRegisterSteamId } },
          { type: 18, component: { type: 3, custom_id: 'date_month', values: [registerVipPurchaseDate.slice(5, 7)] } },
          { type: 18, component: { type: 4, custom_id: 'date_day', value: registerVipPurchaseDate.slice(8, 10) } }
        ]
      }
    });
    assert.equal(registerResponse.status, 200);
    registerPayload = await registerResponse.json();
    assert.equal(registerPayload.type, 4);
    assert.match(registerPayload.data.content, /Registration completed automatically/);
    const reviewDiscordRequest = await waitForDiscordRequest((request) => (
      request.channelId === '123456789012345675' &&
      request.body.embeds?.[0]?.title === 'Clan Portal Member Registration'
    ));
    assert.equal(reviewDiscordRequest.channelId, '123456789012345675');
    assert.equal(reviewDiscordRequest.authorization, 'Bot discord_bot_token_123456789012345');
    assert.equal(reviewDiscordRequest.body.embeds[0].title, 'Clan Portal Member Registration');
    assert.match(reviewDiscordRequest.body.embeds[0].description, /remains here as an audit record/);
    assert.equal(reviewDiscordRequest.body.embeds[0].fields.find((field) => field.name === 'Steam profile').value, `[Open Steam profile](https://steamcommunity.com/profiles/${discordRegisterSteamId})`);
    assert.equal(reviewDiscordRequest.body.embeds[0].fields.find((field) => field.name === 'Status').value, 'Approved');
    assert.equal(reviewDiscordRequest.body.embeds[0].fields.find((field) => field.name === 'VIP').value, `Priority queue\nPurchase: ${registerVipPurchaseDisplay}\nExpiry: ${registerVipExpiryDisplay}`);
    const accountInfo = reviewDiscordRequest.body.embeds[0].fields.find((field) => field.name === 'Account information').value;
    assert.match(accountInfo, /Steam profile: Private/);
    assert.match(accountInfo, /Steam time: Private/);
    assert.match(accountInfo, /BM wipe time: -/);
    assert.match(accountInfo, /BM total time: -/);
    assert.match(accountInfo, /Inventory: Private/);
    assert.match(accountInfo, /Official KDA/);
    assert.match(accountInfo, /No data/);
    assert.equal(reviewDiscordRequest.body.components[0].components[0].label, 'Language');
    assert.equal(reviewDiscordRequest.body.components[1].components[0].custom_id.startsWith('nb_member_review:remove:'), true);
    assert.equal(reviewDiscordRequest.body.components[1].components[0].style, 4);
    await waitForDiscordApplication((application) => (
      application.discordUserId === '123456789012345681' &&
      application.adminReviewMessageId === '123456789012345678'
    ));

    result = await request('/third-party/admin/discord-member-applications?status=approved');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.counts.approved, 1);
    const discordApplication = result.payload.applications.find((application) => application.discordUserId === '123456789012345681');
    assert.equal(Boolean(discordApplication), true);
    assert.equal(discordApplication.steamId, discordRegisterSteamId);
    assert.deepEqual(discordApplication.specialties, ['pvp']);
    assert.equal(discordApplication.vitalVipType, 'priority');
    assert.equal(discordApplication.vitalVipPurchasedAt, registerVipPurchaseDate);
    assert.equal(discordApplication.vitalVipExpiresAt, registerVipExpiryDate);
    assert.equal(discordApplication.squadId, 'squad_test_2');
    assert.equal(discordApplication.squadName, 'Bravo Squad');
    assert.equal(discordApplication.discordAvatarUrl, 'https://cdn.discordapp.com/avatars/123456789012345681/register_avatar_hash.png?size=128');
    assert.equal(discordApplication.adminReviewChannelId, '123456789012345675');
    assert.equal(discordApplication.adminReviewMessageId, '123456789012345678');
    assert.equal(Boolean(discordApplication.adminReviewPushedAt), true);
    assert.equal(
      reviewDiscordRequest.body.components[0].components[0].custom_id,
      `nb_member_review:language:${discordApplication.id}:auto`
    );
    assert.equal(
      reviewDiscordRequest.body.components[1].components[0].custom_id,
      `nb_member_review:remove:${discordApplication.id}`
    );

    const reviewCardPostCountBeforeDuplicateSubmit = discordRequests.filter((request) => (
      request.channelId === '123456789012345675' &&
      request.body.embeds?.[0]?.title === 'Clan Portal Member Registration'
    )).length;
    const reviewCardEditCountBeforeDuplicateSubmit = discordMessageEdits.length;
    registerResponse = await postDiscordInteraction({
      type: 5,
      application_id: '123456789012345672',
      token: 'interaction_token_register_submit_duplicate',
      locale: 'en-US',
      member: { roles: ['123456789012345697'], user: { id: '123456789012345681', username: 'RegisterUser', avatar: 'register_avatar_hash' } },
      data: {
        custom_id: 'nb_member_register:submit:pvp:priority',
        components: [
          { type: 18, component: { type: 4, custom_id: 'steam_input', value: discordRegisterSteamId } },
          { type: 18, component: { type: 3, custom_id: 'date_month', values: [registerVipPurchaseDate.slice(5, 7)] } },
          { type: 18, component: { type: 4, custom_id: 'date_day', value: registerVipPurchaseDate.slice(8, 10) } }
        ]
      }
    });
    assert.equal(registerResponse.status, 200);
    registerPayload = await registerResponse.json();
    assert.equal(registerPayload.type, 4);
    assert.match(registerPayload.data.content, /already bound/);
    assert.equal(discordRequests.filter((request) => (
      request.channelId === '123456789012345675' &&
      request.body.embeds?.[0]?.title === 'Clan Portal Member Registration'
    )).length, reviewCardPostCountBeforeDuplicateSubmit);
    assert.equal(discordMessageEdits.length, reviewCardEditCountBeforeDuplicateSubmit);
    let languageResponse = await postDiscordInteraction({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_review_language_en',
      locale: 'en-US',
      member: { roles: [discordSecondaryManageRoleId], permissions: '0', user: { id: '123456789012345691', username: 'AdminReview' } },
      message: reviewDiscordRequest.body,
      data: { custom_id: `nb_member_review:language:${discordApplication.id}:auto` }
    });
    assert.equal(languageResponse.status, 200);
    const languagePayload = await languageResponse.json();
    assert.equal(languagePayload.type, 7);
    assert.equal(languagePayload.data.embeds[0].title, 'Clan Portal Member Registration');
    assert.equal(languagePayload.data.embeds[0].fields.find((field) => field.name === 'Status').value, 'Approved');
    assert.equal(languagePayload.data.components[0].components[0].label, 'Language');
    assert.equal(languagePayload.data.components[0].components[0].custom_id, `nb_member_review:language:${discordApplication.id}:auto`);
    assert.equal(languagePayload.data.components[1].components[0].custom_id, `nb_member_review:remove:${discordApplication.id}`);

    let reviewResponse = await postDiscordInteraction({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_review_denied',
      locale: 'en-US',
      member: { roles: [], permissions: '0', user: { id: '123456789012345690', username: 'DeniedReview' } },
      message: languagePayload.data,
      data: { custom_id: `nb_member_review:approved:${discordApplication.id}` }
    });
    assert.equal(reviewResponse.status, 200);
    let reviewPayload = await reviewResponse.json();
    assert.equal(reviewPayload.type, 4);
    assert.match(reviewPayload.data.content, /member management permission/);

    reviewResponse = await postDiscordInteraction({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_review_approve',
      member: { roles: [discordSecondaryManageRoleId], permissions: '0', user: { id: '123456789012345691', username: 'AdminReview' } },
      message: languagePayload.data,
      data: { custom_id: `nb_member_review:approved:${discordApplication.id}` }
    });
    assert.equal(reviewResponse.status, 200);
    reviewPayload = await reviewResponse.json();
    assert.equal(reviewPayload.type, 7);
    assert.equal(reviewPayload.data.embeds[0].title, 'Clan Portal Member Registration');
    assert.equal(reviewPayload.data.embeds[0].fields.find((field) => field.name === 'Status').value, 'Approved');
    assert.equal(reviewPayload.data.components.length, 2);
    assert.equal(reviewPayload.data.components[0].components[0].label, 'Language');
    assert.equal(reviewPayload.data.components[1].components[0].custom_id, `nb_member_review:remove:${discordApplication.id}`);
    const approvedDm = await waitForDiscordDirectMessage((message) => message.channelId === 'dm_123456789012345681');
    assert.equal(approvedDm.authorization, 'Bot discord_bot_token_123456789012345');
    assert.equal(approvedDm.body.embeds[0].title, 'Clan Portal Member Registration Approved');
    assert.match(approvedDm.body.embeds[0].description, /approved/);
    assert.equal(approvedDm.body.embeds[0].fields.find((field) => field.name === 'VIP').value, `Priority queue\nPurchase: ${registerVipPurchaseDisplay}\nExpiry: ${registerVipExpiryDisplay}`);
    let registeredStore = await readStore();
    const reviewedApplication = registeredStore.discordMemberApplications.find((application) => application.id === discordApplication.id);
    assert.equal(reviewedApplication.status, 'approved');
    assert.equal(reviewedApplication.reviewedByUserId, 'system');
    assert.equal(reviewedApplication.reviewedByName, 'system');
    assert.equal(reviewedApplication.adminReviewLanguage, 'en');
    const registeredMember = registeredStore.members.find((member) => member.steamId === discordRegisterSteamId);
    assert.equal(registeredMember.discordId, '123456789012345681');
    assert.equal(registeredMember.invitedByUserId, 'system');
    assert.equal(registeredMember.invitedByName, 'system');
    assert.equal(registeredMember.discordAvatarUrl, 'https://cdn.discordapp.com/avatars/123456789012345681/register_avatar_hash.png?size=128');
    assert.deepEqual(registeredMember.specialty, ['pvp']);
    assert.equal(registeredMember.vitalVipType, 'priority');
    assert.equal(registeredMember.vitalVipPurchasedAt, registerVipPurchaseDate);
    assert.equal(registeredMember.vitalVipExpiresAt, registerVipExpiryDate);
    result = await request('/query', { method: 'POST', body: { steamInput: discordRegisterSteamId } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.member.inviterName, 'system');
    await waitForDiscordMessageEdit((edit) => (
      edit.channelId === '123456789012345675' &&
      edit.messageId === '123456789012345678' &&
      edit.body.embeds?.[0]?.fields?.find((field) => field.name === 'Status')?.value === 'Approved'
    ));
    const reviewCardEditCountBeforeRepeatApprove = discordMessageEdits.length;
    const repeatApproveResponse = await postDiscordInteraction({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_review_approve_repeat',
      member: { roles: ['123456789012345674'], permissions: '0', user: { id: '123456789012345691', username: 'AdminReview' } },
      message: languagePayload.data,
      data: { custom_id: `nb_member_review:approved:${discordApplication.id}` }
    });
    assert.equal(repeatApproveResponse.status, 200);
    const repeatApprovePayload = await repeatApproveResponse.json();
    assert.equal(repeatApprovePayload.type, 7);
    assert.equal(repeatApprovePayload.data.embeds[0].fields.find((field) => field.name === 'Status').value, 'Approved');
    assert.equal(repeatApprovePayload.data.components.length, 2);
    await waitForDiscordMessageEdit((edit, index) => (
      index >= reviewCardEditCountBeforeRepeatApprove &&
      edit.channelId === '123456789012345675' &&
      edit.messageId === '123456789012345678' &&
      edit.body.embeds?.[0]?.fields?.find((field) => field.name === 'Status')?.value === 'Approved'
    ));
    const reviewCardPostCountBeforeAlreadyRegisteredSubmit = discordRequests.filter((request) => (
      request.channelId === '123456789012345675' &&
      request.body.embeds?.[0]?.title === 'Clan Portal Member Registration'
    )).length;
    const reviewCardEditCountBeforeAlreadyRegisteredSubmit = discordMessageEdits.length;
    registerResponse = await postDiscordInteraction({
      type: 5,
      application_id: '123456789012345672',
      token: 'interaction_token_register_submit_already_bound',
      locale: 'en-US',
      member: { roles: ['123456789012345697'], user: { id: '123456789012345681', username: 'RegisterUser', avatar: 'register_avatar_hash' } },
      data: {
        custom_id: 'nb_member_register:submit:pvp:priority',
        components: [
          { type: 18, component: { type: 4, custom_id: 'steam_input', value: discordRegisterSteamId } },
          { type: 18, component: { type: 3, custom_id: 'date_month', values: [registerVipPurchaseDate.slice(5, 7)] } },
          { type: 18, component: { type: 4, custom_id: 'date_day', value: registerVipPurchaseDate.slice(8, 10) } }
        ]
      }
    });
    assert.equal(registerResponse.status, 200);
    registerPayload = await registerResponse.json();
    assert.equal(registerPayload.type, 4);
    assert.match(registerPayload.data.content, /already bound/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(discordRequests.filter((request) => (
      request.channelId === '123456789012345675' &&
      request.body.embeds?.[0]?.title === 'Clan Portal Member Registration'
    )).length, reviewCardPostCountBeforeAlreadyRegisteredSubmit);
    assert.equal(discordMessageEdits.length, reviewCardEditCountBeforeAlreadyRegisteredSubmit);
    const directMessageCountBeforeReminder = discordDirectMessages.length;
    const reminderResult = await sendDueDiscordVitalVipReminders({
      nowMs: Date.parse(`${registerVipReminderDate}T08:00:00.000Z`),
      silent: true
    });
    assert.equal(reminderResult.sent, 1);
    const vipReminderDm = await waitForDiscordDirectMessage((message) => (
      message.channelId === 'dm_123456789012345681' &&
      message.body.embeds?.[0]?.title === 'Vital VIP expiry reminder'
    ));
    assert.match(vipReminderDm.body.embeds[0].description, new RegExp(`expires on ${registerVipExpiryDisplay}`));
    assert.equal(vipReminderDm.body.components[0].components[0].custom_id, 'nb_vital_vip:open');
    registeredStore = await readStore();
    const remindedMember = registeredStore.members.find((member) => member.steamId === discordRegisterSteamId);
    assert.equal(remindedMember.vitalVipReminderExpiresAt, registerVipExpiryDate);
    assert.equal(Boolean(remindedMember.vitalVipReminderSentAt), true);
    const duplicateReminderResult = await sendDueDiscordVitalVipReminders({
      nowMs: Date.parse(`${registerVipReminderDate}T09:00:00.000Z`),
      silent: true
    });
    assert.equal(duplicateReminderResult.sent, 0);
    assert.equal(discordDirectMessages.length, directMessageCountBeforeReminder + 1);
    const registeredSquad = registeredStore.squads.find((squad) => squad.id === 'squad_test_2');
    assert.equal(Boolean(registeredSquad), true);
    assert.equal(registeredStore.squadMembers.some((item) => item.memberId === registeredMember.id && item.squadId === 'squad_test_2'), true);
    await updateStore((store) => {
      store.squadMembers = store.squadMembers.filter((item) => item.memberId !== registeredMember.id);
      store.squadMembers.push({
        id: 'squad_member_restore_after_discord_register',
        squadId: 'squad_test_2',
        memberId: registeredMember.id,
        addedByUserId: 'user_root',
        createdAt: new Date().toISOString()
      });
    });

    const deleteDeniedResponse = await postDiscordInteraction({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_review_delete_denied',
      locale: 'en-US',
      member: { roles: [], permissions: '0', user: { id: '123456789012345690', username: 'DeniedDelete' } },
      message: languagePayload.data,
      data: { custom_id: `nb_member_review:remove:${discordApplication.id}` }
    });
    assert.equal(deleteDeniedResponse.status, 200);
    const deleteDeniedPayload = await deleteDeniedResponse.json();
    assert.equal(deleteDeniedPayload.type, 4);
    assert.match(deleteDeniedPayload.data.content, /member management permission/);

    const deleteResponse = await postDiscordInteraction({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_review_delete',
      locale: 'en-US',
      member: { roles: [discordSecondaryManageRoleId], permissions: '0', user: { id: '123456789012345691', username: 'AdminReview' } },
      message: languagePayload.data,
      data: { custom_id: `nb_member_review:remove:${discordApplication.id}` }
    });
    assert.equal(deleteResponse.status, 200);
    const deletePayload = await deleteResponse.json();
    assert.equal(deletePayload.type, 7);
    assert.equal(deletePayload.data.embeds[0].fields.find((field) => field.name === 'Status').value, 'Approved');
    assert.equal(deletePayload.data.components[1].components[0].custom_id, `nb_member_review:remove:${discordApplication.id}`);
    assert.equal(deletePayload.data.components[1].components[0].disabled, true);
    await waitForStoreCondition((store) => {
      const application = store.discordMemberApplications.find((item) => item.id === discordApplication.id);
      return application?.memberDeletedAt && !store.members.some((item) => item.id === registeredMember.id);
    }, { label: 'automatic Discord member delete' });
    await waitForDiscordMessageEdit((edit) => (
      edit.channelId === '123456789012345675' &&
      edit.messageId === '123456789012345678' &&
      edit.body.components?.[1]?.components?.[0]?.disabled === true
    ));

    await updateStore((store) => {
      store.discordMemberApplications.unshift({
        id: 'discord_member_application_reject_test',
        discordUserId: '123456789012345692',
        discordUsername: 'RejectUser',
        displayName: 'RejectUser',
        discordLanguage: 'en',
        steamId: '76561198000007777',
        steamInput: '76561198000007777',
        rawInput: '76561198000007777',
        steamNickname: 'RejectSteam',
        steamAvatar: '',
        specialties: ['pipe'],
        squadName: '57',
        status: 'pending',
        adminNote: '',
        reviewNote: '',
        reviewedByUserId: '',
        reviewedAt: '',
        memberId: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    });
    reviewResponse = await postDiscordInteraction({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_review_reject',
      member: { roles: ['123456789012345674'], permissions: '0', user: { id: '123456789012345691', username: 'AdminReview' } },
      message: reviewDiscordRequest.body,
      data: { custom_id: 'nb_member_review:rejected:discord_member_application_reject_test' }
    });
    assert.equal(reviewResponse.status, 200);
    reviewPayload = await reviewResponse.json();
    assert.equal(reviewPayload.type, 7);
    assert.equal(reviewPayload.data.embeds[0].fields.find((field) => field.name === 'Status').value, 'Rejected');
    const rejectedDm = await waitForDiscordDirectMessage((message) => message.channelId === 'dm_123456789012345692');
    assert.equal(rejectedDm.body.embeds[0].title, 'Clan Portal Member Registration Rejected');
    assert.match(rejectedDm.body.embeds[0].description, /rejected/);
    const repeatRejectResponse = await postDiscordInteraction({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_review_reject_repeat',
      member: { roles: ['123456789012345674'], permissions: '0', user: { id: '123456789012345691', username: 'AdminReview' } },
      message: reviewDiscordRequest.body,
      data: { custom_id: 'nb_member_review:rejected:discord_member_application_reject_test' }
    });
    assert.equal(repeatRejectResponse.status, 200);
    const repeatRejectPayload = await repeatRejectResponse.json();
    assert.equal(repeatRejectPayload.type, 7);
    assert.equal(repeatRejectPayload.data.embeds[0].fields.find((field) => field.name === 'Status').value, 'Rejected');
    const staleApproveRejectedResponse = await postDiscordInteraction({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_review_reject_then_approve',
      locale: 'en-US',
      member: { roles: ['123456789012345674'], permissions: '0', user: { id: '123456789012345691', username: 'AdminReview' } },
      message: reviewDiscordRequest.body,
      data: { custom_id: 'nb_member_review:approved:discord_member_application_reject_test' }
    });
    assert.equal(staleApproveRejectedResponse.status, 200);
    const staleApproveRejectedPayload = await staleApproveRejectedResponse.json();
    assert.equal(staleApproveRejectedPayload.type, 4);
    assert.match(staleApproveRejectedPayload.data.content, /cannot be reviewed/);

    const untrackedDuplicateApplicationCreatedAt = new Date().toISOString();
    await updateStore((store) => {
      store.discordMemberApplications.unshift({
        id: 'discord_member_application_untracked_duplicate_click_test',
        discordUserId: '123456789012345706',
        discordUsername: 'UntrackedDuplicateClickUser',
        displayName: 'UntrackedDuplicateClickUser',
        discordLanguage: 'en',
        adminReviewLanguage: 'en',
        steamId: '76561198000007783',
        steamInput: '76561198000007783',
        rawInput: '76561198000007783',
        steamNickname: 'UntrackedDuplicateSteam',
        steamAvatar: '',
        specialties: ['farmer'],
        squadName: '57',
        status: 'pending',
        adminNote: '',
        reviewNote: '',
        reviewedByUserId: '',
        reviewedAt: '',
        memberId: '',
        adminReviewChannelId: '123456789012345675',
        adminReviewMessageId: '123456789012345704',
        adminReviewPushedAt: untrackedDuplicateApplicationCreatedAt,
        createdAt: untrackedDuplicateApplicationCreatedAt,
        updatedAt: untrackedDuplicateApplicationCreatedAt
      });
    });
    const reviewCardEditCountBeforeUntrackedDuplicateClick = discordMessageEdits.length;
    reviewResponse = await postDiscordInteraction({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_review_untracked_duplicate_click',
      locale: 'en-US',
      member: { roles: ['123456789012345674'], permissions: '0', user: { id: '123456789012345691', username: 'AdminReview' } },
      message: {
        id: '123456789012345705',
        channel_id: '123456789012345675',
        ...reviewDiscordRequest.body
      },
      data: { custom_id: 'nb_member_review:approved:discord_member_application_untracked_duplicate_click_test' }
    });
    assert.equal(reviewResponse.status, 200);
    reviewPayload = await reviewResponse.json();
    assert.equal(reviewPayload.type, 7);
    assert.equal(reviewPayload.data.embeds[0].fields.find((field) => field.name === 'Status').value, 'Approved');
    for (const messageId of ['123456789012345704', '123456789012345705']) {
      const untrackedDuplicateEdit = await waitForDiscordMessageEdit((edit, index) => (
        index >= reviewCardEditCountBeforeUntrackedDuplicateClick &&
        edit.channelId === '123456789012345675' &&
        edit.messageId === messageId
      ));
      assert.equal(untrackedDuplicateEdit.body.embeds[0].fields.find((field) => field.name === 'Status').value, 'Approved');
      assert.equal(untrackedDuplicateEdit.body.components.length, 2);
    }
    const untrackedDuplicateLog = await waitForStoreCondition((store) => store.logs.find((log) => (
      log.targetId === 'discord_member_application_untracked_duplicate_click_test' &&
      log.type === 'discord_member_review_card_update'
    )), { label: 'untracked duplicate review card update log' });
    assert.equal(untrackedDuplicateLog.metadata.updatedMessages.some((message) => (
      message.channelId === '123456789012345675' &&
      message.messageId === '123456789012345705'
    )), true);

    const webReviewApplicationPushedAt = new Date().toISOString();
    await updateStore((store) => {
      store.discordMemberApplications.unshift({
        id: 'discord_member_application_web_review_update_test',
        discordUserId: '123456789012345693',
        discordUsername: 'WebReviewUser',
        displayName: 'WebReviewUser',
        discordLanguage: 'en',
        adminReviewLanguage: 'en',
        steamId: '76561198000007778',
        steamInput: '76561198000007778',
        rawInput: '76561198000007778',
        steamNickname: 'WebReviewSteam',
        steamAvatar: '',
        specialties: ['pvp'],
        squadName: '57',
        status: 'pending',
        adminNote: '',
        reviewNote: '',
        reviewedByUserId: '',
        reviewedAt: '',
        memberId: '',
        adminReviewChannelId: '123456789012345675',
        adminReviewMessageId: '123456789012345699',
        adminReviewPushedAt: webReviewApplicationPushedAt,
        createdAt: webReviewApplicationPushedAt,
        updatedAt: webReviewApplicationPushedAt
      });
      store.logs ||= [];
      store.logs.unshift({
        id: 'log_discord_member_application_web_review_update_duplicate_1',
        type: 'discord_member_review_card_push',
        actorUserId: 'discord:123456789012345693',
        actorUsername: 'WebReviewUser',
        ip: 'test',
        steamId: '76561198000007778',
        targetId: 'discord_member_application_web_review_update_test',
        summary: 'Pushed duplicate Discord member registration approval card',
        metadata: {
          applicationId: 'discord_member_application_web_review_update_test',
          channelId: '123456789012345675',
          messageId: '123456789012345701'
        },
        createdAt: '2026-01-01T00:00:00.000Z'
      });
      store.logs.unshift({
        id: 'log_discord_member_application_web_review_update_duplicate_2',
        type: 'discord_member_review_card_push',
        actorUserId: 'discord:123456789012345693',
        actorUsername: 'WebReviewUser',
        ip: 'test',
        steamId: '76561198000007778',
        targetId: 'discord_member_application_web_review_update_test',
        summary: 'Pushed duplicate Discord member registration approval card',
        metadata: {
          applicationId: 'discord_member_application_web_review_update_test',
          channelId: '123456789012345675',
          messageId: '123456789012345702'
        },
        createdAt: '2026-01-01T00:00:01.000Z'
      });
      store.discordMemberApplications.unshift({
        id: 'discord_member_application_web_review_repost_test',
        discordUserId: '123456789012345694',
        discordUsername: 'WebRepostUser',
        displayName: 'WebRepostUser',
        discordLanguage: 'en',
        adminReviewLanguage: 'en',
        steamId: '76561198000007779',
        steamInput: '76561198000007779',
        rawInput: '76561198000007779',
        steamNickname: 'WebRepostSteam',
        steamAvatar: '',
        specialties: ['pipe'],
        squadName: '57',
        status: 'pending',
        adminNote: '',
        reviewNote: '',
        reviewedByUserId: '',
        reviewedAt: '',
        memberId: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      store.discordMemberApplications.unshift({
        id: 'discord_member_application_web_review_missing_message_test',
        discordUserId: '123456789012345695',
        discordUsername: 'WebMissingMessageUser',
        displayName: 'WebMissingMessageUser',
        discordLanguage: 'en',
        adminReviewLanguage: 'en',
        steamId: '76561198000007780',
        steamInput: '76561198000007780',
        rawInput: '76561198000007780',
        steamNickname: 'WebMissingMessageSteam',
        steamAvatar: '',
        specialties: ['pvp'],
        squadName: '57',
        status: 'pending',
        adminNote: '',
        reviewNote: '',
        reviewedByUserId: '',
        reviewedAt: '',
        memberId: '',
        adminReviewChannelId: '123456789012345675',
        adminReviewMessageId: '123456789012345700',
        adminReviewPushedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      store.members.push({
        id: 'member_existing_discord_application_test',
        steamId: '76561198000007781',
        rawInput: '76561198000007781',
        customName: 'Existing Discord Application Member',
        steamNickname: 'ExistingDiscordSteam',
        avatar: '',
        discordId: '',
        wechatId: '',
        notes: '',
        specialty: [],
        invitedByUserId: 'user_root',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      store.discordMemberApplications.unshift({
        id: 'discord_member_application_existing_member_test',
        discordUserId: '123456789012345696',
        discordUsername: 'ExistingDiscordApplicationUser',
        displayName: 'ExistingDiscordApplicationUser',
        discordAvatarHash: 'existing_discord_application_avatar',
        discordAvatarUrl: 'https://cdn.discordapp.com/avatars/123456789012345696/existing_discord_application_avatar.png?size=128',
        discordLanguage: 'en',
        adminReviewLanguage: 'en',
        steamId: '76561198000007781',
        steamInput: '76561198000007781',
        rawInput: '76561198000007781',
        steamNickname: 'ExistingDiscordSteam',
        steamAvatar: '',
        specialties: ['pvp'],
        squadName: '57',
        status: 'pending',
        adminNote: '',
        reviewNote: '',
        reviewedByUserId: '',
        reviewedAt: '',
        memberId: '',
        adminReviewChannelId: '123456789012345675',
        adminReviewMessageId: '123456789012345703',
        adminReviewPushedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    });
    result = await request('/third-party/admin/discord-member-applications/discord_member_application_web_review_update_test/review', {
      method: 'POST',
      body: { status: 'approved', adminNote: 'Approved in web admin.' }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.application.status, 'approved');
    const webReviewEdit = await waitForDiscordMessageEdit((edit) => (
      edit.channelId === '123456789012345675' &&
      edit.messageId === '123456789012345699'
    ));
    assert.equal(webReviewEdit.authorization, 'Bot discord_bot_token_123456789012345');
    assert.equal(webReviewEdit.body.embeds[0].fields.find((field) => field.name === 'Status').value, 'Approved');
    assert.equal(webReviewEdit.body.embeds[0].fields.find((field) => field.name === 'Review note').value, 'Approved in web admin.');
    assert.equal(webReviewEdit.body.components.length, 2);
    for (const messageId of ['123456789012345701', '123456789012345702']) {
      const duplicateWebReviewEdit = await waitForDiscordMessageEdit((edit) => (
        edit.channelId === '123456789012345675' &&
        edit.messageId === messageId
      ));
      assert.equal(duplicateWebReviewEdit.body.embeds[0].fields.find((field) => field.name === 'Status').value, 'Approved');
      assert.equal(duplicateWebReviewEdit.body.components.length, 2);
    }
    const webReviewStore = await readStore();
    assert.equal(webReviewStore.members.find((item) => item.steamId === '76561198000007778').discordName, 'WebReviewUser');
    await waitForDiscordApplication((application) => (
      application.id === 'discord_member_application_web_review_update_test' &&
      Boolean(application.adminReviewSyncedAt) &&
      !application.adminReviewSyncError
    ));

    result = await request('/third-party/admin/discord-member-applications?status=approved&q=ExistingDiscordApplicationUser');
    assert.equal(result.response.status, 200);
    const existingMemberApplication = result.payload.applications.find((application) => application.id === 'discord_member_application_existing_member_test');
    assert.equal(Boolean(existingMemberApplication), true);
    assert.equal(existingMemberApplication.status, 'approved');
    assert.equal(existingMemberApplication.memberId, 'member_existing_discord_application_test');
    const existingMemberAutoReviewEdit = await waitForDiscordMessageEdit((edit) => (
      edit.channelId === '123456789012345675' &&
      edit.messageId === '123456789012345703'
    ));
    assert.equal(existingMemberAutoReviewEdit.body.embeds[0].fields.find((field) => field.name === 'Status').value, 'Approved');
    assert.equal(existingMemberAutoReviewEdit.body.components.length, 2);
    const existingMemberAutoReviewStore = await readStore();
    assert.equal(existingMemberAutoReviewStore.members.find((member) => member.id === 'member_existing_discord_application_test').discordId, '123456789012345696');

    result = await request('/third-party/admin/discord-member-applications/discord_member_application_web_review_repost_test/review', {
      method: 'POST',
      body: { status: 'rejected', adminNote: 'Rejected in web admin.' }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.application.status, 'rejected');
    const webReviewRepost = await waitForDiscordRequest((request) => (
      request.channelId === '123456789012345675' &&
      request.body.embeds?.[0]?.fields?.some((field) => field.name === 'SteamID' && field.value === '76561198000007779')
    ));
    assert.equal(webReviewRepost.body.embeds[0].fields.find((field) => field.name === 'Status').value, 'Rejected');
    assert.equal(webReviewRepost.body.embeds[0].fields.find((field) => field.name === 'Review note').value, 'Rejected in web admin.');
    await waitForDiscordApplication((application) => (
      application.id === 'discord_member_application_web_review_repost_test' &&
      application.adminReviewMessageId === '123456789012345678' &&
      Boolean(application.adminReviewSyncedAt) &&
      !application.adminReviewSyncError
    ));

    result = await request('/third-party/admin/discord-member-applications/discord_member_application_web_review_missing_message_test/review', {
      method: 'POST',
      body: { status: 'approved', adminNote: 'Original Discord message is gone.' }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.application.status, 'approved');
    const missingMessageRepost = await waitForDiscordRequest((request) => (
      request.channelId === '123456789012345675' &&
      request.body.embeds?.[0]?.fields?.some((field) => field.name === 'SteamID' && field.value === '76561198000007780')
    ));
    assert.equal(missingMessageRepost.body.embeds[0].fields.find((field) => field.name === 'Status').value, 'Approved');
    await waitForDiscordApplication((application) => (
      application.id === 'discord_member_application_web_review_missing_message_test' &&
      application.adminReviewMessageId === '123456789012345678' &&
      Boolean(application.adminReviewSyncedAt) &&
      !application.adminReviewSyncError
    ));

    const interactionBody = JSON.stringify({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_late',
      locale: 'zh-CN',
      member: { user: { id: discordUserId, username: 'AlphaDiscord' } },
      message: discordInteractionMessageFromRecord(wipeAttendanceDiscordRequest),
      data: { custom_id: `nb_wipe_signup:late:${wipeId}` }
    });
    const interactionTimestamp = String(Math.floor(Date.now() / 1000));
    const interactionSignature = crypto
      .sign(null, Buffer.concat([Buffer.from(interactionTimestamp), Buffer.from(interactionBody)]), discordKeys.privateKey)
      .toString('hex');
    const interactionResponse = await fetch(`${baseUrl}/integrations/discord/interactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature-ed25519': interactionSignature,
        'x-signature-timestamp': interactionTimestamp
      },
      body: interactionBody
    });
    assert.equal(interactionResponse.status, 200);
    const interactionPayload = await interactionResponse.json();
    assert.equal(interactionPayload.type, 6);
    const lateEdit = await waitForDiscordMessageEdit((edit) => (
      findDiscordAttendanceField(edit.body.embeds?.[0]?.fields, '🕒 Join in 16h (2)')?.value.includes(`<@${discordUserId}>`)
    ));
    assert.equal(findDiscordAttendanceField(lateEdit.body.embeds[0].fields, '✅ Attending (0)').value, '-');
    assert.equal(findDiscordAttendanceField(lateEdit.body.embeds[0].fields, '🕒 Join in 8h (0)').value, '-');
    const discordJoin16hField = findDiscordAttendanceField(lateEdit.body.embeds[0].fields, '🕒 Join in 16h (2)');
    assert.equal(Boolean(discordJoin16hField), true);
    assert.match(discordJoin16hField.value, /Steam Self/);
    assert.match(discordJoin16hField.value, new RegExp(`<@${discordUserId}> 🟡`));
    assert.doesNotMatch(discordJoin16hField.value, /🟣VIP|🟡VIP/);
    assert.equal(findDiscordAttendanceField(lateEdit.body.embeds[0].fields, '❌ Not Attending (0)').value, '-');
    assert.equal(lateEdit.body.content || '', '');
    assert.deepEqual(lateEdit.body.allowed_mentions, { parse: [] });
    const lateFollowup = await waitForDiscordFollowup((message) => message.token === 'interaction_token_late');
    assert.equal(lateFollowup.body.content, '报名已记录。');
    assert.equal(lateFollowup.body.flags, 64);

    const skipBody = JSON.stringify({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_skip',
      locale: 'tr',
      member: { user: { id: discordUserId, username: 'AlphaDiscord' } },
      message: discordInteractionMessageFromRecord(lateEdit),
      data: { custom_id: `nb_wipe_signup:skip:${wipeId}` }
    });
    const skipTimestamp = String(Math.floor(Date.now() / 1000));
    const skipSignature = crypto
      .sign(null, Buffer.concat([Buffer.from(skipTimestamp), Buffer.from(skipBody)]), discordKeys.privateKey)
      .toString('hex');
    const skipResponse = await fetch(`${baseUrl}/integrations/discord/interactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature-ed25519': skipSignature,
        'x-signature-timestamp': skipTimestamp
      },
      body: skipBody
    });
    assert.equal(skipResponse.status, 200);
    const skipPayload = await skipResponse.json();
    assert.equal(skipPayload.type, 6);
    const skipEdit = await waitForDiscordMessageEdit((edit) => (
      findDiscordAttendanceField(edit.body.embeds?.[0]?.fields, '❌ Not Attending (1)')?.value.includes(`<@${discordUserId}>`)
    ));
    assert.equal(findDiscordAttendanceField(skipEdit.body.embeds[0].fields, '✅ Attending (0)').value, '-');
    assert.equal(findDiscordAttendanceField(skipEdit.body.embeds[0].fields, '🕒 Join in 8h (0)').value, '-');
    assert.match(findDiscordAttendanceField(skipEdit.body.embeds[0].fields, '🕒 Join in 16h (1)').value, /Steam Self/);
    assert.match(findDiscordAttendanceField(skipEdit.body.embeds[0].fields, '❌ Not Attending (1)').value, new RegExp(`<@${discordUserId}> 🟡`));
    const skipFollowup = await waitForDiscordFollowup((message) => message.token === 'interaction_token_skip');
    assert.equal(skipFollowup.body.content, 'Katılım kaydedildi.');

    const onTimeBody = JSON.stringify({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_on_time',
      locale: 'tr',
      member: { user: { id: discordUserId, username: 'AlphaDiscord' } },
      message: discordInteractionMessageFromRecord(skipEdit),
      data: { custom_id: `nb_wipe_signup:on_time:${wipeId}` }
    });
    const onTimeTimestamp = String(Math.floor(Date.now() / 1000));
    const onTimeSignature = crypto
      .sign(null, Buffer.concat([Buffer.from(onTimeTimestamp), Buffer.from(onTimeBody)]), discordKeys.privateKey)
      .toString('hex');
    const onTimeResponse = await fetch(`${baseUrl}/integrations/discord/interactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature-ed25519': onTimeSignature,
        'x-signature-timestamp': onTimeTimestamp
      },
      body: onTimeBody
    });
    assert.equal(onTimeResponse.status, 200);
    const onTimePayload = await onTimeResponse.json();
    assert.equal(onTimePayload.type, 6);
    const onTimeEdit = await waitForDiscordMessageEdit((edit) => (
      findDiscordAttendanceField(edit.body.embeds?.[0]?.fields, '✅ Attending (1)')?.value.includes(`<@${discordUserId}>`)
    ));
    assert.match(findDiscordAttendanceField(onTimeEdit.body.embeds[0].fields, '✅ Attending (1)').value, new RegExp(`<@${discordUserId}> 🟡`));
    assert.equal(findDiscordAttendanceField(onTimeEdit.body.embeds[0].fields, '🕒 Join in 8h (0)').value, '-');
    assert.match(findDiscordAttendanceField(onTimeEdit.body.embeds[0].fields, '🕒 Join in 16h (1)').value, /Steam Self/);
    assert.equal(findDiscordAttendanceField(onTimeEdit.body.embeds[0].fields, '❌ Not Attending (0)').value, '-');
    assert.match(onTimeEdit.body.embeds[0].description, /📊 Alpha Squad 1 attending/);
    assert.doesNotMatch(onTimeEdit.body.embeds[0].description, /📊 .*Join in 8h/);
    assert.doesNotMatch(onTimeEdit.body.embeds[0].description, /📊 .*Join in 16h/);
    assert.doesNotMatch(onTimeEdit.body.embeds[0].description, /📊 .*Not Attending/);
    assert.doesNotMatch(onTimeEdit.body.embeds[0].description, /📊 Bravo Squad 0 attending/);
    assert.equal(onTimeEdit.body.embeds[0].footer.text, 'Clan Portal Wipe Attendance\nCreated by AdminCommand');
    const onTimeFollowup = await waitForDiscordFollowup((message) => message.token === 'interaction_token_on_time');
    assert.equal(onTimeFollowup.body.content, 'Katılım kaydedildi.');

    const cancelBody = JSON.stringify({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_cancel',
      locale: 'tr',
      member: { user: { id: discordUserId, username: 'AlphaDiscord' } },
      message: discordInteractionMessageFromRecord(onTimeEdit),
      data: { custom_id: `nb_wipe_signup:cancel:${wipeId}` }
    });
    const cancelTimestamp = String(Math.floor(Date.now() / 1000));
    const cancelSignature = crypto
      .sign(null, Buffer.concat([Buffer.from(cancelTimestamp), Buffer.from(cancelBody)]), discordKeys.privateKey)
      .toString('hex');
    const cancelResponse = await fetch(`${baseUrl}/integrations/discord/interactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature-ed25519': cancelSignature,
        'x-signature-timestamp': cancelTimestamp
      },
      body: cancelBody
    });
    assert.equal(cancelResponse.status, 200);
    const cancelPayload = await cancelResponse.json();
    assert.equal(cancelPayload.type, 6);
    const cancelEdit = await waitForDiscordMessageEdit((edit) => (
      findDiscordAttendanceField(edit.body.embeds?.[0]?.fields, '✅ Attending (0)')?.value === '-' &&
      findDiscordAttendanceField(edit.body.embeds?.[0]?.fields, '❌ Not Attending (1)')?.value.includes(`<@${discordUserId}>`) &&
      findDiscordAttendanceField(edit.body.embeds?.[0]?.fields, '🕒 Join in 16h (1)')?.value.includes('Steam Self')
    ));
    assert.equal(findDiscordAttendanceField(cancelEdit.body.embeds[0].fields, '✅ Attending (0)').value, '-');
    assert.match(findDiscordAttendanceField(cancelEdit.body.embeds[0].fields, '🕒 Join in 16h (1)').value, /Steam Self/);
    assert.match(findDiscordAttendanceField(cancelEdit.body.embeds[0].fields, '❌ Not Attending (1)').value, new RegExp(`<@${discordUserId}> 🟡`));
    const cancelFollowup = await waitForDiscordFollowup((message) => message.token === 'interaction_token_cancel');
    assert.equal(cancelFollowup.body.content, 'Katılım kaydedildi.');
    await updateStore((store) => {
      const member = store.members.find((item) => item.id === 'member_test_1');
      if (member) member.vitalVipType = 'queue_skip';
    });

    const restoreOnTimeBody = JSON.stringify({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_restore_on_time',
      locale: 'tr',
      member: { user: { id: discordUserId, username: 'AlphaDiscord' } },
      message: discordInteractionMessageFromRecord(cancelEdit),
      data: { custom_id: `nb_wipe_signup:on_time:${wipeId}` }
    });
    const restoreOnTimeTimestamp = String(Math.floor(Date.now() / 1000));
    const restoreOnTimeSignature = crypto
      .sign(null, Buffer.concat([Buffer.from(restoreOnTimeTimestamp), Buffer.from(restoreOnTimeBody)]), discordKeys.privateKey)
      .toString('hex');
    const restoreOnTimeResponse = await fetch(`${baseUrl}/integrations/discord/interactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature-ed25519': restoreOnTimeSignature,
        'x-signature-timestamp': restoreOnTimeTimestamp
      },
      body: restoreOnTimeBody
    });
    assert.equal(restoreOnTimeResponse.status, 200);
    const restoreOnTimePayload = await restoreOnTimeResponse.json();
    assert.equal(restoreOnTimePayload.type, 6);
    const restoreOnTimeEdit = await waitForDiscordMessageEdit((edit) => (
      findDiscordAttendanceField(edit.body.embeds?.[0]?.fields, '✅ Attending (1)')?.value.includes(`<@${discordUserId}> 🟣`)
    ));
    assert.match(findDiscordAttendanceField(restoreOnTimeEdit.body.embeds[0].fields, '✅ Attending (1)').value, new RegExp(`<@${discordUserId}> 🟣`));
    assert.doesNotMatch(findDiscordAttendanceField(restoreOnTimeEdit.body.embeds[0].fields, '✅ Attending (1)').value, /🟣VIP|🟡VIP/);
    const restoreOnTimeFollowup = await waitForDiscordFollowup((message) => message.token === 'interaction_token_restore_on_time');
    assert.equal(restoreOnTimeFollowup.body.content, 'Katılım kaydedildi.');

    const webLateRefreshEditCount = discordMessageEdits.length;
    result = await request(`/wipes/${wipeId}/participants/member_test_1`, { method: 'PUT', body: { status: 'late' } });
    assert.equal(result.response.status, 200);
    const webLateRefreshEdit = await waitForDiscordMessageEdit((edit, index) => (
      index >= webLateRefreshEditCount &&
      edit.channelId === '123456789012345671' &&
      edit.messageId === '123456789012345678' &&
      findDiscordAttendanceField(edit.body.embeds?.[0]?.fields, '🕒 Join in 16h (2)')?.value.includes(`<@${discordUserId}> 🟣`)
    ));
    assert.equal(findDiscordAttendanceField(webLateRefreshEdit.body.embeds[0].fields, '✅ Attending (0)').value, '-');
    assert.deepEqual(webLateRefreshEdit.body.allowed_mentions, { parse: [] });

    const webOnTimeRefreshEditCount = discordMessageEdits.length;
    result = await request(`/wipes/${wipeId}/participants/member_test_1`, { method: 'PUT', body: { status: 'on_time' } });
    assert.equal(result.response.status, 200);
    const webOnTimeRefreshEdit = await waitForDiscordMessageEdit((edit, index) => (
      index >= webOnTimeRefreshEditCount &&
      edit.channelId === '123456789012345671' &&
      edit.messageId === '123456789012345678' &&
      findDiscordAttendanceField(edit.body.embeds?.[0]?.fields, '✅ Attending (1)')?.value.includes(`<@${discordUserId}> 🟣`)
    ));
    assert.match(findDiscordAttendanceField(webOnTimeRefreshEdit.body.embeds[0].fields, '🕒 Join in 16h (1)').value, /Steam Self/);

    const discordSignupStore = await readStore();
    assert.equal(discordSignupStore.wipeParticipants.some((participant) => (
      participant.wipeId === wipeId &&
      participant.memberId === 'member_test_1' &&
      participant.status === 'on_time'
    )), true);
    const discordSignupMember = discordSignupStore.members.find((member) => member.id === 'member_test_1');
    assert.equal(discordSignupMember.notAttendingCount, 1);
    assert.equal(discordSignupMember.lastNotAttendingWipeId, wipeId);
    await updateStore((store) => {
      const member = store.members.find((item) => item.id === 'member_test_1');
      if (member) member.discordId = 'discord-alpha';
    });

    const manualIdSyncFetch = globalThis.fetch;
    const manualIdSessionStart = new Date(Date.now() - 80 * 60_000).toISOString();
    const manualIdSessionStop = new Date(Date.now() - 20 * 60_000).toISOString();
    const manualIdSyncRequests = [];
    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      if (!href.startsWith('https://api.battlemetrics.com')) {
        return manualIdSyncFetch(url, options);
      }
      manualIdSyncRequests.push({ href, authorization: options.headers?.authorization || '' });
      if (href.includes('/players/bm_manual_playtime_3/servers/36933209')) {
        return new Response(JSON.stringify({
          data: {
            type: 'playerServer',
            id: 'bm_manual_playtime_3-36933209',
            attributes: {
              firstSeen: manualIdSessionStart,
              lastSeen: manualIdSessionStop,
              timePlayed: 3600,
              online: false
            }
          }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (href.includes('/players/bm_manual_playtime_3/relationships/sessions')) {
        return new Response(JSON.stringify({
          data: [
            { type: 'session', id: 'manual_id_session_1', attributes: { start: manualIdSessionStart, stop: manualIdSessionStop, name: 'ManualBM', firstTime: false } }
          ],
          links: {}
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ errors: [{ title: 'unexpected url' }] }), { status: 404, headers: { 'content-type': 'application/json' } });
    };
    try {
      result = await request('/members/member_test_3/battlemetrics-id', {
        method: 'PUT',
        body: { battlemetricsId: 'bm_manual_playtime_3' }
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.member.battlemetricsId, 'bm_manual_playtime_3');
      const manualIdSyncState = await waitForSyncState('battlemetricsManualId');
      assert.equal(manualIdSyncState.status, 'complete', JSON.stringify(manualIdSyncState));
      assert.equal(manualIdSyncState.completed, 1);
      assert.equal(manualIdSyncState.updated, 1);
      assert.equal(manualIdSyncRequests.every((item) => item.authorization.startsWith('Bearer ')), true);
      assert.equal(manualIdSyncRequests.filter((item) => item.href.includes('/players/bm_manual_playtime_3/servers/36933209')).length, 1);
      assert.equal(manualIdSyncRequests.filter((item) => item.href.includes('/players/bm_manual_playtime_3/relationships/sessions')).length, 2);
      const manualIdSyncedStore = await readStore();
      const manualIdSyncedProfile = manualIdSyncedStore.memberProfiles.find((profile) => profile.memberId === 'member_test_3');
      assert.equal(manualIdSyncedProfile.battlemetricsPlayerId, 'bm_manual_playtime_3');
      assert.equal(manualIdSyncedProfile.battlemetricsServerId, '36933209');
      assert.equal(manualIdSyncedProfile.battlemetricsLastOnlineAt, manualIdSessionStart);
      assert.equal(manualIdSyncedProfile.battlemetricsLastOfflineAt, manualIdSessionStop);
      assert.equal(manualIdSyncedProfile.battlemetricsServerPlayTimeSeconds, 3600);
      assert.equal(manualIdSyncedProfile.battlemetricsTotalPlayTimeSeconds, 3600);
    } finally {
      globalThis.fetch = manualIdSyncFetch;
    }

    const autoSyncSteamId = '76561198000000111';
    const autoSyncSessionStart = new Date(Date.now() - 90 * 60_000).toISOString();
    const autoSyncSessionStop = new Date(Date.now() - 15 * 60_000).toISOString();
    const autoSyncRequests = [];
    const autoSyncFetch = globalThis.fetch;
    process.env.NB_DISABLE_EXTERNAL_VITAL = '0';
    process.env.NB_DISABLE_BACKGROUND_JOBS = '0';
    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      autoSyncRequests.push({ href, body: options.body ? JSON.parse(options.body) : null });
      if (href === `https://steamcommunity.com/profiles/${autoSyncSteamId}?xml=1`) {
        return new Response([
          '<profile>',
          `<steamID64>${autoSyncSteamId}</steamID64>`,
          '<steamID>Auto Sync Steam</steamID>',
          '<avatarFull>https://cdn.example.com/auto-sync.jpg</avatarFull>',
          '</profile>'
        ].join(''), { status: 200, headers: { 'content-type': 'text/xml' } });
      }
      if (href === `https://steamcommunity.com/broadcast/getbroadcastmpd/?steamid=${autoSyncSteamId}`) {
        return new Response(JSON.stringify({
          success: 'unavailable',
          retry: 30000,
          broadcastid: 0,
          eresult: 1
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (href === `https://rust-kda.anlonely.me/api/player/${autoSyncSteamId}`) {
        return new Response(JSON.stringify({
          name: 'Auto Sync KDA',
          avatar: 'https://cdn.example.com/auto-sync-kda.jpg',
          profileUrl: `https://steamcommunity.com/profiles/${autoSyncSteamId}`,
          playTimeHours: 22
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (href === `https://rust-kda.anlonely.me/api/inventory/${autoSyncSteamId}`) {
        return new Response(JSON.stringify({
          inventoryAvailable: true,
          totalSummary: { totalValue: 48.5, currency: 'USD' }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (href === `https://rust-kda.anlonely.me/api/kda/${autoSyncSteamId}`) {
        return new Response(JSON.stringify({
          summary: {
            kills: 18,
            deaths: 6,
            headshots: 9,
            bulletsHitPlayer: 80,
            bulletsFired: 200,
            kdRatio: 3,
            accuracy: 40,
            headshotRate: 11.25,
            rocketsFired: 4
          },
          resources: {
            sulfurOre: 1234,
            metalOre: 5678,
            wood: 910,
            stone: 1112
          },
          sections: [{
            id: 'pvp',
            title: 'PVP',
            emoji: '⚔️',
            items: [{ id: 'kills', label: '击杀', value: 18, icon: '💀' }]
          }]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (href.startsWith('https://api.battlemetrics.com') && href.endsWith('/players/match')) {
        return new Response(JSON.stringify({
          data: [],
          included: []
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const parsedBattlemetricsUrl = href.startsWith('https://api.battlemetrics.com') ? new URL(href) : null;
      if (
        parsedBattlemetricsUrl?.pathname === '/players' &&
        parsedBattlemetricsUrl.searchParams.get('filter[search]') === 'Auto Sync Member' &&
        parsedBattlemetricsUrl.searchParams.get('filter[servers]') === '36933209'
      ) {
        return new Response(JSON.stringify({
          data: [{ type: 'player', id: 'bm_auto_sync_1', attributes: { name: 'Auto Sync Member' } }]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (href.includes('/players/bm_auto_sync_1/servers/36933209')) {
        return new Response(JSON.stringify({
          data: {
            type: 'playerServer',
            id: 'bm_auto_sync_1-36933209',
            attributes: {
              firstSeen: autoSyncSessionStart,
              lastSeen: autoSyncSessionStop,
              timePlayed: 4500,
              online: false
            }
          }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (href.includes('/players/bm_auto_sync_1/relationships/sessions')) {
        return new Response(JSON.stringify({
          data: [
            { type: 'session', id: 'auto_sync_session_1', attributes: { start: autoSyncSessionStart, stop: autoSyncSessionStop, name: 'AutoSyncBM', firstTime: false } }
          ],
          links: {}
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return autoSyncFetch(url, options);
    };
    try {
      result = await request('/members', {
        method: 'POST',
        body: { steamInput: autoSyncSteamId, customName: 'Auto Sync Member', squadId: 'squad_test_1' }
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.syncQueued, 1);
      const autoSyncMember = result.payload.members.find((member) => member.steamId === autoSyncSteamId);
      assert.equal(Boolean(autoSyncMember), true);
      await waitForSyncState('battlemetricsNewMember');
      const { savedMember, savedProfile } = await waitForStoreCondition((store) => {
        const member = store.members.find((item) => item.steamId === autoSyncSteamId);
        const profile = member ? store.memberProfiles.find((item) => item.memberId === member.id) : null;
        if (profile?.battlemetricsServerId === '36933209' && profile.accountRestrictionStatus) {
          return { savedMember: member, savedProfile: profile };
        }
        return null;
      }, { attempts: 160, delayMs: 50, label: 'auto synced new member profile' });
      assert.equal(savedMember.battlemetricsId, 'bm_auto_sync_1');
      assert.equal(savedProfile.playTimeMinutes, 1320);
      assert.equal(savedProfile.playTimeVisibility, 'public');
      assert.equal(savedProfile.inventoryValue, 48.5);
      assert.equal(savedProfile.inventoryVisibility, 'public');
      assert.equal(savedProfile.accountRestricted, false);
      assert.equal(savedProfile.accountRestrictionStatus, 'unavailable');
      assert.equal(savedProfile.battlemetricsServerId, '36933209');
      assert.equal(savedProfile.battlemetricsServerPlayTimeSeconds, 4500);
      assert.equal(savedProfile.battlemetricsLastOnlineAt, autoSyncSessionStart);
      assert.equal(savedProfile.battlemetricsLastOfflineAt, autoSyncSessionStop);
      assert.equal(savedProfile.battlemetricsMatchConfidence, 'exact-active-name');
      assert.equal(savedProfile.battlemetricsMatchAlias, 'Auto Sync Member');
      assert.equal(autoSyncRequests.some((item) => item.href.endsWith('/players/match')), true);
      assert.equal(autoSyncRequests.some((item) => item.href.includes('/players?') && item.href.includes('filter%5Bsearch%5D=Auto+Sync+Member')), true);
      assert.equal(autoSyncRequests.some((item) => item.href.includes('/relationships/sessions')), true);
    } finally {
      globalThis.fetch = autoSyncFetch;
      process.env.NB_DISABLE_EXTERNAL_VITAL = '1';
      process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
    }

    const realFetch = globalThis.fetch;
    process.env.NB_DISABLE_EXTERNAL_VITAL = '0';
    const vitalBatchSizes = [];
    let latestVitalSyncPlayerIds = [];
    let latestVitalLookupBody = null;
    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      if (href === 'https://playerstatistics.vitalgamenetwork.com/servers/23/wipes') {
        return new Response(JSON.stringify({
          statusCode: 200,
          data: [{
            gameServerId: 23,
            id: 'wipe-test',
            startTime: startedAt
          }]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (href.startsWith('https://rust-kda.anlonely.me/')) {
        return new Response(JSON.stringify({ error: 'rust-kda disabled in test' }), { status: 503, headers: { 'content-type': 'application/json' } });
      }
      if (href === 'https://steamcommunity.com/profiles/76561198000000001?xml=1') {
        return new Response([
          '<profile>',
          '<steamID64>76561198000000001</steamID64>',
          '<steamID>AlphaSteam</steamID>',
          '<avatarFull>https://avatars.steamstatic.com/alpha-member_full.jpg</avatarFull>',
          '</profile>'
        ].join(''), { status: 200, headers: { 'content-type': 'text/xml' } });
      }
      if (href === 'https://playerstatistics.vitalgamenetwork.com/players/overview') {
        const body = JSON.parse(options.body || '{}');
        assert.ok(body.playerIds.length <= 10);
        if (body.playerIds.length === 1 && body.playerIds[0] === '76561198000000001' && !Object.hasOwn(body, 'wipeId')) {
          latestVitalLookupBody = body;
          return new Response(JSON.stringify({
            statusCode: 200,
            data: [{
              context: { userId: '76561198000000001' },
              player: { name: 'AlphaSteam' },
              statistics: {
                combat: { kills: '31', killsT3: '5', deaths: '10', headshots: '7', hits: '99', shots: '250', wounds: '3', suicides: '1' },
                raiding: { rockets: '4', rocketsHighVelocity: '2', explosivesTimed: '1', ammoExplosive: '64' },
                pve: {
                  killsNPC: { scientistnpc_oilrig: '11', npc_tunneldweller: '6', patrolhelicopter: '1', wolf: '4' },
                  cratesHackedRig: '3',
                  scrapRecycled: '880',
                  scrapWheelWagered: '100',
                  scrapSlotsWagered: '20',
                  scrapWheelWon: '160',
                  scrapSlotsWon: '0'
                },
                farming: { gathered: { 'sulfur.ore': '50000', 'metal.ore': '25000', 'hq.metal.ore': '500', wood: '75000' }, looted: { scrap: '1200' } },
                building: { buildings: { wall: '40', foundation: '10', floor: '15', 'wall.doorway': '5' } }
              }
            }]
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (body.wipeId === 'wipe-batch-limit') {
          vitalBatchSizes.push(body.playerIds.length);
          assert.equal(body.serverId, 23);
          return new Response(JSON.stringify({
            statusCode: 200,
            data: body.playerIds.slice(0, -1).map((steamId, index) => ({
              context: { userId: steamId },
              player: { name: `Batch ${index}` },
              statistics: {
                combat: { kills: String(index + 1), killsT3: '0', deaths: '1' },
                raiding: { rockets: '0' },
                farming: { gathered: { 'sulfur.ore': '0', 'metal.ore': '0' } },
                building: { buildings: {} }
              }
            }))
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        latestVitalSyncPlayerIds.push(...body.playerIds);
        assert.equal(body.serverId, 23);
        assert.equal(body.wipeId, 'wipe-test');
        return new Response(JSON.stringify({
          statusCode: 200,
          data: body.playerIds.map((steamId) => steamId === '76561198000000001'
            ? {
                context: { userId: steamId },
                player: { name: 'AlphaSteam' },
                statistics: {
                  combat: { kills: '19', killsT3: '0', deaths: '68' },
                  raiding: { rockets: '0' },
                  farming: { gathered: { 'sulfur.ore': '25800', 'metal.ore': '39600' } },
                  building: { buildings: { wall: '1089', foundation: '315', floor: '620' } }
                }
              }
            : {
                context: { userId: steamId },
                player: { name: `Vital ${steamId.slice(-4)}` },
                statistics: {
                  combat: { kills: '0', killsT3: '0', deaths: '0' },
                  raiding: { rockets: '0' },
                  farming: { gathered: { 'sulfur.ore': '0', 'metal.ore': '0' } },
                  building: { buildings: {} }
                }
              })
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return realFetch(url, options);
    };
    try {
      const batchWipeId = 'wipe_batch_limit';
      const batchMemberIds = Array.from({ length: 12 }, (_, index) => `member_batch_limit_${index}`);
      await updateStore((store) => {
        const createdAt = nowIso();
        store.wipes.push({
          id: batchWipeId,
          serverName: 'Vital Rust Batch Limit',
          name: 'Vital Rust Batch Limit',
          status: 'active',
          startedAt,
          vitalServerId: '23',
          vitalWipeId: 'wipe-batch-limit',
          createdAt,
          updatedAt: createdAt,
          createdByUserId: 'user_root'
        });
        batchMemberIds.forEach((memberId, index) => {
          const steamId = String(76561198000100000n + BigInt(index));
          store.members.push({
            id: memberId,
            steamId,
            rawInput: steamId,
            customName: `Batch Limit ${index}`,
            steamNickname: `Batch Limit ${index}`,
            createdAt,
            updatedAt: createdAt
          });
          store.wipeParticipants.push({
            id: `participant_batch_limit_${index}`,
            wipeId: batchWipeId,
            memberId,
            status: 'on_time',
            addedByUserId: 'user_root',
            createdAt,
            updatedAt: createdAt
          });
        });
      });
      result = await request(`/wechat/admin/wipes/${batchWipeId}/sync-kda`, { method: 'POST', ip: '10.10.0.201' });
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.requested, 12);
      assert.equal(result.payload.imported, 10);
      assert.equal(result.payload.missing, 2);
      assert.equal(result.payload.ignored, 2);
      assert.equal(result.payload.completed, 12);
      assert.equal(result.payload.job.doneCount, 12);
      assert.equal(result.payload.job.skippedCount, 2);
      assert.equal(result.payload.job.targetVitalWipeId, 'wipe-batch-limit');
      assert.deepEqual(vitalBatchSizes, [10, 2]);
      await updateStore((store) => {
        store.wipes = store.wipes.filter((wipe) => wipe.id !== batchWipeId);
        store.members = store.members.filter((member) => !batchMemberIds.includes(member.id));
        store.wipeParticipants = store.wipeParticipants.filter((participant) => participant.wipeId !== batchWipeId);
        store.kdaRows = store.kdaRows.filter((row) => row.wipeId !== batchWipeId);
        store.kdaSnapshots = store.kdaSnapshots.filter((row) => row.wipeId !== batchWipeId);
      });
      vitalBatchSizes.length = 0;

      result = await request('/kda/sync', { method: 'POST', body: { wipeId, scope: 'all', sort: 'kda', order: 'desc' } });
      assert.equal(result.response.status, 200);
      assert.equal(latestVitalSyncPlayerIds.includes('76561198000000001'), true);
      assert.equal(latestVitalSyncPlayerIds.includes('76561198000000004'), true);
      assert.equal(latestVitalSyncPlayerIds.includes('76561198000000008'), true);
      assert.equal(latestVitalSyncPlayerIds.includes('76561198000012345'), true);
      assert.equal(result.payload.source, 'vital');
      assert.equal(result.payload.requested, latestVitalSyncPlayerIds.length);
      assert.equal(result.payload.completed, latestVitalSyncPlayerIds.length);
      assert.equal(Number.isFinite(result.payload.estimatedSeconds), true);
      assert.equal(result.payload.imported, latestVitalSyncPlayerIds.length);
      assert.equal(result.payload.rows[0].kills, 19);
      assert.equal(result.payload.rows[0].deaths, 68);
      assert.equal(result.payload.rows[0].t3Kills, 0);
      assert.equal(result.payload.rows[0].rockets, 0);
      assert.equal(result.payload.rows[0].sulfur, 25800);
      assert.equal(result.payload.rows[0].metalOre, 39600);
      assert.equal(result.payload.rows[0].building, 2024);
      assert.equal(result.payload.rows[0].playTimeMinutes, 0);
      assert.equal(result.payload.rows[0].source, 'vital');
      const fullMemberKdaStore = await readStore();
      assert.equal(fullMemberKdaStore.kdaRows.some((row) => row.wipeId === wipeId && row.memberId === 'member_test_4' && row.source === 'vital'), true);
      assert.equal(result.payload.rows.some((row) => row.memberId === 'member_test_4' && row.source === 'vital'), true);
      assert.equal(result.payload.job.type, 'kda');
      assert.equal(result.payload.job.targetVitalWipeId, 'wipe-test');
      assert.equal(result.payload.job.status, 'completed');

      result = await request('/rust-kda/vital', {
        method: 'POST',
        body: { steamInput: '76561198000000001', vitalServerId: '23', vitalWipeId: '' }
      });
      assert.equal(result.response.status, 200);
      assert.equal(Object.hasOwn(latestVitalLookupBody, 'wipeId'), false);
      assert.equal(latestVitalLookupBody.serverId, 23);
      assert.equal(latestVitalLookupBody.includes.includes('pve::scrapRecycled'), true);
      assert.equal(latestVitalLookupBody.includes.includes('raiding::explosivesTimed'), true);
      assert.equal(result.payload.vital.wipeId, '');
      assert.equal(result.payload.vital.wipeName, 'All Wipes');
      assert.equal(result.payload.vital.stats.metrics.some((metric) => metric.key === 'pve.scrapRecycled' && metric.value === 880), true);

      const manualKdaWipeId = 'wipe_manual_kda_skip';
      await updateStore((store) => {
        const createdAt = nowIso();
        store.wipes.push({
          id: manualKdaWipeId,
          serverName: 'Custom Rust Server',
          name: 'Custom Rust Server 2026-06-24',
          status: 'active',
          startedAt: createdAt,
          vitalServerId: '',
          vitalWipeId: '',
          battlemetricsId: '',
          createdAt,
          updatedAt: createdAt,
          createdByUserId: 'user_root'
        });
        store.wipeParticipants.push({
          id: 'participant_manual_kda_skip',
          wipeId: manualKdaWipeId,
          memberId: 'member_test_1',
          squadId: 'squad_test_1',
          status: 'on_time',
          addedByUserId: 'user_root',
          createdAt,
          updatedAt: createdAt
        });
      });
      result = await request('/kda/sync', {
        method: 'POST',
        ip: '10.44.0.3',
        body: { wipeId: manualKdaWipeId, scope: 'all', sort: 'kda', order: 'desc' }
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.source, 'manual');
      assert.equal(result.payload.kdaSyncSkipped, true);
      assert.equal(result.payload.kdaProvider, 'manual');
      assert.equal(result.payload.kdaSyncAvailable, false);
      assert.equal(result.payload.kdaSyncUnavailableReason, 'manual_provider');
      assert.match(result.payload.kdaSyncMessage, /暂不支持自动 KDA/);
      assert.equal(result.payload.completed, 1);
      assert.equal(result.payload.imported, 0);
      assert.equal(result.payload.rows.length, 0);
      assert.equal(result.payload.dataFreshness.kdaProvider, 'manual');
      assert.equal(result.payload.job.status, 'completed');
      await updateStore((store) => {
        store.wipes = store.wipes.filter((wipe) => wipe.id !== manualKdaWipeId);
        store.wipeParticipants = store.wipeParticipants.filter((participant) => participant.wipeId !== manualKdaWipeId);
        store.kdaRows = store.kdaRows.filter((row) => row.wipeId !== manualKdaWipeId);
        store.kdaSnapshots = store.kdaSnapshots.filter((row) => row.wipeId !== manualKdaWipeId);
      });
    } finally {
      globalThis.fetch = realFetch;
      process.env.NB_DISABLE_EXTERNAL_VITAL = '1';
    }
    result = await request('/sync/jobs/recent?limit=5');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.recent.some((job) => job.type === 'kda' && job.status === 'completed'), true);

    await updateStore((store) => {
      const member = store.members.find((item) => item.id === 'member_test_1');
      if (member) member.discordId = discordUserId;
    });
    discordRequest = null;
    result = await request('/settings/discord/member-ranking-card', { method: 'POST', body: {} });
    assert.equal(result.response.status, 200);
    assert.equal(discordRequest.channelId, '123456789012345687');
    assert.equal(discordRequest.body.embeds[0].title, 'Current server member ranking · T3 Kills Top 10');
    assert.equal(discordRequest.body.embeds.length, 1);
    assert.match(discordRequest.body.embeds[0].description, /Server:/);
    assert.match(discordRequest.body.embeds[0].thumbnail.url, /^https:\/\//);
    assert.match(discordRequest.body.embeds[0].fields[0].name, /#1 Alpha · Alpha Squad/);
    assert.match(discordRequest.body.embeds[0].fields[0].value, /\*\*T3 Kills: 0\*\*/);
    assert.equal(discordRequest.body.components[0].components.find((button) => button.custom_id === 'nb_member_ranking:metric:t3Kills').style, 1);
    assert.equal(discordRequest.body.components[1].components.find((button) => button.custom_id === 'nb_member_ranking:metric:sulfur').label, 'Sulfur');
    rankingResponse = await postDiscordInteraction({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_ranking_sulfur',
      locale: 'tr',
      member: { roles: [], permissions: '0', user: { id: discordUserId, username: 'RankBound' } },
      message: discordRequest.body,
      data: { custom_id: 'nb_member_ranking:metric:sulfur' }
    });
    assert.equal(rankingResponse.status, 200);
    rankingPayload = await rankingResponse.json();
    assert.equal(rankingPayload.type, 7);
    assert.equal('flags' in rankingPayload.data, false);
    assert.equal(rankingPayload.data.embeds.length, 1);
    assert.match(rankingPayload.data.embeds[0].title, /Sulfur Top 10/);
    assert.match(rankingPayload.data.embeds[0].fields[0].name, /#1 Alpha · Alpha Squad/);
    assert.match(rankingPayload.data.embeds[0].description, /Server:/);
    assert.match(rankingPayload.data.embeds[0].description, /Synced:/);
    assert.match(rankingPayload.data.embeds[0].fields[0].value, /\*\*Sulfur: 2\.58w\*\*/);
    assert.equal(rankingPayload.data.components[1].components.find((button) => button.custom_id === 'nb_member_ranking:metric:sulfur').style, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    rankingResponse = await postDiscordInteraction({
      type: 3,
      application_id: '123456789012345672',
      token: 'interaction_token_ranking_mine',
      locale: 'zh-CN',
      member: { roles: [], permissions: '0', user: { id: discordUserId, username: 'RankBound' } },
      message: discordRequest.body,
      data: { custom_id: 'nb_member_ranking:mine' }
    });
    assert.equal(rankingResponse.status, 200);
    rankingPayload = await rankingResponse.json();
    assert.equal(rankingPayload.type, 4);
    assert.equal(rankingPayload.data.flags, 64);
    assert.match(rankingPayload.data.embeds[0].title, /Alpha · Alpha Squad/);
    assert.match(rankingPayload.data.embeds[0].description, /队伍：Alpha Squad/);
    assert.match(rankingPayload.data.embeds[0].description, /KDA/);
    assert.match(rankingPayload.data.embeds[0].description, /#1/);
    assert.match(rankingPayload.data.embeds[0].description, /这张排行卡片会在/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(discordDeletedInteractionMessages.at(-1), {
      applicationId: '123456789012345672',
      token: 'interaction_token_ranking_mine'
    });

    result = await request('/integrations/kook/events', {
      method: 'POST',
      body: {
        s: 0,
        d: {
          channel_type: 'WEBHOOK_CHALLENGE',
          challenge: 'kook_challenge_ok',
          verify_token: 'kook_verify_token_updated'
        }
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.challenge, 'kook_challenge_ok');

    result = await request('/integrations/kook/events', {
      method: 'POST',
      body: {
        s: 0,
        d: {
          extra: {
            type: 'message_btn_click',
            body: {
              value: 'nb_kook_member_ranking:metric:sulfur',
              msg_id: 'kook_message_unknown',
              user_id: 'kook_user_1',
              target_id: 'kook_ranking_channel_123'
            }
          }
        }
      }
    });
    assert.equal(result.response.status, 401);
    assert.equal(result.payload.error, 'KOOK verify token mismatch.');

    const kookPostCountBeforeMetric = kookPosts.length;
    const kookUpdateCountBeforeMetric = kookUpdates.length;
    const kookDeleteCountBeforeMetric = kookDeletes.length;
    result = await request('/integrations/kook/events', {
      method: 'POST',
      body: {
        s: 0,
        d: {
          verify_token: 'kook_verify_token_updated',
          extra: {
            type: 'message_btn_click',
            body: {
              value: 'nb_kook_member_ranking:metric:sulfur',
              msg_id: 'kook_message_1',
              user_id: 'kook_user_1',
              target_id: 'kook_ranking_channel_123'
            }
          }
        }
      }
    });
    assert.equal(result.response.status, 200);
    const kookMetricUpdate = await waitForKookUpdate((update, index) => {
      if (index < kookUpdateCountBeforeMetric || update.body.msg_id !== 'kook_message_1') return false;
      try {
        return /硫磺/.test(JSON.parse(update.body.content)?.[0]?.modules?.[0]?.text?.content || '');
      } catch {
        return false;
      }
    });
    const kookMetricMessageId = 'kook_message_1';
    assert.equal(kookPosts.length, kookPostCountBeforeMetric);
    assert.equal(kookMetricUpdate.authorization, 'Bot kook_bot_token_1234567890');
    const kookMetricCards = JSON.parse(kookMetricUpdate.body.content);
    assert.match(kookMetricCards[0].modules[0].text.content, /硫磺/);
    assert.equal(
      kookMetricCards[0].modules
        .flatMap((module) => Array.isArray(module.elements) ? module.elements : [])
        .find((button) => button.value === 'nb_kook_member_ranking:metric:sulfur').theme,
      'primary'
    );
    assert.equal(kookDeletes.length, kookDeleteCountBeforeMetric);
	    await waitForStoreCondition((store) => (
	      store.settings.kook.lastMemberRankingMetric === 'sulfur' &&
	      store.settings.kook.lastMemberRankingMessageId === kookMetricMessageId &&
	      store.settings.kook.lastMemberRankingRefreshAt
	        ? store.settings.kook
	        : null
	    ), { label: 'KOOK ranking metric refresh' });
	    const kookMetricIntegrationEvent = await waitForStoreCondition((store) => (
	      (store.integrationEvents || []).find((event) => (
	        event.platform === 'kook' &&
	        event.eventType === 'message_button_click' &&
	        event.status === 'processed' &&
	        event.metadata?.buttonValue === 'nb_kook_member_ranking:metric:sulfur'
	      ))
	    ), { label: 'KOOK ranking metric integration event processed' });
	    assert.equal(kookMetricIntegrationEvent.errorSummary, '');
	    assert.equal(kookMetricIntegrationEvent.metadata.action, 'metric');
	    assert.equal(kookMetricIntegrationEvent.metadata.messageId, kookMetricMessageId);

	    await updateStore((store) => {
	      const member = store.members.find((item) => item.id === 'member_test_1');
	      if (member) member.kookId = 'kook_user_1';
	    });
    const kookPostCountBeforeMine = kookPosts.length;
    result = await request('/integrations/kook/events', {
      method: 'POST',
      body: {
        s: 0,
        d: {
          verify_token: 'kook_verify_token_updated',
          extra: {
            type: 'message_btn_click',
            body: {
              value: 'nb_kook_member_ranking:mine_disabled',
              msg_id: kookMetricMessageId,
              user_id: 'kook_user_1',
              target_id: 'kook_ranking_channel_123'
            }
          }
        }
      }
	    });
	    assert.equal(result.response.status, 200);
	    await new Promise((resolve) => setTimeout(resolve, 50));
	    assert.equal(kookPosts.length, kookPostCountBeforeMine);
	    const kookMineIntegrationEvent = await waitForStoreCondition((store) => (
	      (store.integrationEvents || []).find((event) => (
	        event.platform === 'kook' &&
	        event.eventType === 'message_button_click' &&
	        event.status === 'skipped' &&
	        event.metadata?.buttonValue === 'nb_kook_member_ranking:mine_disabled' &&
	        event.metadata?.reason === 'my_ranking_disabled'
	      ))
	    ), { label: 'KOOK ranking mine integration event skipped' });
	    assert.equal(kookMineIntegrationEvent.errorSummary, '');

	    await updateStore((store) => {
	      const member = store.members.find((item) => item.id === 'member_test_1');
	      if (member) member.discordId = 'discord-alpha';
	    });

    let kdaCommandResponse = await postDiscordInteraction({
      type: 2,
      application_id: '123456789012345672',
      token: 'interaction_token_kda_wrong_channel',
      channel_id: '123456789012345671',
      guild_id: '123456789012345670',
      locale: 'en-US',
      member: { permissions: '0', roles: [], user: { id: '123456789012345685', username: 'KdaUser' } },
      data: {
        type: 1,
        name: 'kda',
        options: [{ type: 3, name: 'steam_input', value: 'AlphaSteam' }]
      }
    });
    assert.equal(kdaCommandResponse.status, 200);
    let kdaCommandPayload = await kdaCommandResponse.json();
    assert.equal(kdaCommandPayload.type, 4);
    assert.equal(kdaCommandPayload.data.flags, 64);
    assert.match(kdaCommandPayload.data.content, /configured KDA query channel/);

    kdaCommandResponse = await postDiscordInteraction({
      type: 2,
      application_id: '123456789012345672',
      token: 'interaction_token_kda_ok',
      channel_id: '123456789012345677',
      guild_id: '123456789012345670',
      locale: 'en-US',
      member: { permissions: '0', roles: [], user: { id: '123456789012345685', username: 'KdaUser' } },
      data: {
        type: 1,
        name: 'kda',
        options: [{ type: 3, name: 'steam_input', value: 'AlphaSteam' }]
      }
    });
    assert.equal(kdaCommandResponse.status, 200);
    kdaCommandPayload = await kdaCommandResponse.json();
    assert.equal(kdaCommandPayload.type, 4);
    assert.equal('flags' in kdaCommandPayload.data, false);
    assert.equal(kdaCommandPayload.data.embeds[0].title, 'KDA · Alpha');
    assert.match(kdaCommandPayload.data.embeds[0].fields.find((field) => field.name === 'Clan Portal Member Registration').value, /Steam nickname: AlphaSteam/);
    assert.match(kdaCommandPayload.data.embeds[0].fields.find((field) => field.name === 'Current KDA').value, /Kills: 19/);
    assert.match(kdaCommandPayload.data.embeds[0].fields.find((field) => field.name === 'Current KDA').value, /Sulfur: 2\.58w/);
    assert.match(kdaCommandPayload.data.embeds[0].fields.find((field) => field.name === 'Account information').value, /Steam profile:/);
    assert.match(kdaCommandPayload.data.embeds[0].fields.find((field) => field.name === 'Links').value, /Vital KDA/);
    assert.match(kdaCommandPayload.data.embeds[0].fields.find((field) => field.name === 'Auto delete').value, /<t:\d+:R>/);
    assert.equal(kdaCommandPayload.data.embeds[0].footer.text, 'Clan Portal Member System');
    assert.ok(Number.isFinite(Date.parse(kdaCommandPayload.data.embeds[0].timestamp)));
    assert.doesNotMatch(kdaCommandPayload.data.embeds[0].footer.text, /T\d{2}:\d{2}:/);
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.deepEqual(discordDeletedInteractionMessages.at(-1), {
      applicationId: '123456789012345672',
      token: 'interaction_token_kda_ok'
    });

    await updateStore((store) => {
      store.settings.discord.kdaQueryChannelId = '';
      store.settings.discord.targets[0].kdaQueryChannelId = '';
    });
    kdaCommandResponse = await postDiscordInteraction({
      type: 2,
      application_id: '123456789012345672',
      token: 'interaction_token_kda_all_channels',
      channel_id: '123456789012345671',
      guild_id: '123456789012345670',
      locale: 'en-US',
      member: { permissions: '0', roles: [], user: { id: '123456789012345685', username: 'KdaUser' } },
      data: {
        type: 1,
        name: 'kda',
        options: [{ type: 3, name: 'steam_input', value: 'AlphaSteam' }]
      }
    });
    assert.equal(kdaCommandResponse.status, 200);
    kdaCommandPayload = await kdaCommandResponse.json();
    assert.equal(kdaCommandPayload.type, 4);
    assert.equal('flags' in kdaCommandPayload.data, false);
    assert.equal(kdaCommandPayload.data.embeds[0].title, 'KDA · Alpha');
    assert.match(kdaCommandPayload.data.embeds[0].fields.find((field) => field.name === 'Auto delete').value, /This card will be deleted <t:\d+:R>\./);
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.deepEqual(discordDeletedInteractionMessages.at(-1), {
      applicationId: '123456789012345672',
      token: 'interaction_token_kda_all_channels'
    });
    await updateStore((store) => {
      store.settings.discord.kdaQueryChannelId = '123456789012345677';
      store.settings.discord.targets[0].kdaQueryChannelId = '123456789012345677';
    });

    result = await request(`/wipes/${wipeId}/participants`, { method: 'POST', body: { memberIds: ['member_test_2'], responseLimit: 2, responseOffset: 0 } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.participants.length, 2);
    assert.equal(result.payload.total, 3);
    assert.equal(result.payload.hasMore, true);

    const rootCookieForWebMemberOps = cookie;
    cookie = '';
    result = await request('/auth/login', { method: 'POST', ip: '10.30.0.1', body: { username: 'web_member', password: 'MemberPass123!' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.user.role, 'member');
    result = await request('/squads');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.squads.some((squad) => squad.id === 'squad_test_1'), true);
    assert.equal(result.payload.squads.some((squad) => squad.id === 'squad_test_2'), true);
    result = await request('/squads/squad_test_2/members');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.members.some((member) => member.id === 'member_test_2'), true);
    result = await request('/wipes/current');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.wipe.participantCount, 3);
    result = await request(`/wipes/${wipeId}/participants`);
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.participants.length, 3);
    result = await request(`/kda?wipeId=${wipeId}&scope=all&sort=kda&order=desc`);
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.rows.some((row) => row.memberId === 'member_test_1'), true);
    result = await request('/kda/sync', { method: 'POST', body: { wipeId, scope: 'all' } });
    assert.equal(result.response.status, 403);
    cookie = rootCookieForWebMemberOps;

    result = await request('/squads/squad_test_1/members');
    assert.equal(result.response.status, 200);
    const playingMember = result.payload.members.find((member) => member.id === 'member_test_1');
    assert.equal(playingMember.playStatus, 'playing');
    assert.equal(playingMember.isPlayingCurrentWipe, true);

    result = await request(`/wipes/${wipeId}/participants/member_test_1`, { method: 'PUT', body: { status: 'late' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.participants[0].status, 'join_16h');

    result = await request(`/wipes/${wipeId}/participants`);
    assert.equal(result.response.status, 200);
    const participantSummaryBeforeNotAttending = result.payload.summary;
    assert.equal(
      participantSummaryBeforeNotAttending.squads.reduce((sum, squad) => sum + squad.count, 0),
      participantSummaryBeforeNotAttending.onTime
    );

    await updateStore((store) => {
      const createdAt = nowIso();
      store.members.push({
        id: 'member_not_attending_kda_filter',
        steamId: '76561198000008888',
        rawInput: '76561198000008888',
        customName: 'Not Attending Filter',
        steamNickname: 'NotAttendingFilter',
        avatar: '',
        discordId: '',
        wechatId: '',
        notes: '',
        specialty: [],
        vitalVipType: 'queue_skip',
        invitedByUserId: 'user_root',
        createdAt,
        updatedAt: createdAt
      });
      store.wipeParticipants.push({
        id: 'wipe_participant_not_attending_kda_filter',
        wipeId,
        squadId: 'squad_test_1',
        memberId: 'member_not_attending_kda_filter',
        status: 'not_attending',
        source: 'web',
        addedByUserId: 'user_root',
        createdAt,
        updatedAt: createdAt
      });
      store.kdaRows.push({
        id: 'kda_not_attending_filter',
        wipeId,
        memberId: 'member_not_attending_kda_filter',
        steamId: '76561198000008888',
        kills: 999,
        deaths: 1,
        assists: 0,
        t3Kills: 0,
        rockets: 0,
        sulfur: 0,
        metalOre: 0,
        building: 0,
        playTimeMinutes: 0,
        raw: {},
        source: 'vital',
        syncedAt: createdAt
      });
    });

    result = await request(`/wipes/${wipeId}/participants`);
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.summary.notAttending, participantSummaryBeforeNotAttending.notAttending + 1);
    assert.equal(result.payload.summary.vip, participantSummaryBeforeNotAttending.vip);
    assert.equal(result.payload.summary.queueSkip, participantSummaryBeforeNotAttending.queueSkip);
    assert.equal(
      result.payload.summary.squads.reduce((sum, squad) => sum + squad.count, 0),
      result.payload.summary.onTime
    );

    let autoTargets = battlemetricsAutoSyncTargets(await readStore());
    assert.equal(autoTargets.wipe.id, wipeId);
    assert.equal(autoTargets.wipe.status, 'active');
    assert.equal(autoTargets.targets.some((member) => member.id === 'member_test_2'), true);
    assert.equal(autoTargets.targets.some((member) => member.id === 'member_not_attending_kda_filter'), false);
    let kdaTargets = kdaAutoSyncTargets(await readStore());
    assert.equal(kdaTargets.wipe.id, wipeId);
    assert.equal(kdaTargets.wipe.status, 'active');
    assert.equal(kdaTargets.participants.some((participant) => participant.memberId === 'member_test_1'), true);
    assert.equal(kdaTargets.participants.some((participant) => participant.memberId === 'member_test_2'), true);
    assert.equal(kdaTargets.participants.some((participant) => participant.memberId === 'member_test_4'), true);
    assert.equal(kdaTargets.participants.some((participant) => participant.memberId === 'member_not_attending_kda_filter'), true);
    result = await request(`/kda?wipeId=${wipeId}&scope=all&sort=kills&order=desc`);
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.rows.some((row) => row.memberId === 'member_test_4'), true);
    const notAttendingKdaRow = result.payload.rows.find((row) => row.memberId === 'member_not_attending_kda_filter');
    assert.equal(Boolean(notAttendingKdaRow), true);
    assert.equal(notAttendingKdaRow.kills, 999);
    await updateStore((store) => {
      store.wipeParticipants = store.wipeParticipants.filter((participant) => participant.id !== 'wipe_participant_not_attending_kda_filter');
      store.members = store.members.filter((member) => member.id !== 'member_not_attending_kda_filter');
      store.kdaRows = store.kdaRows.filter((row) => row.id !== 'kda_not_attending_filter');
    });

    result = await request('/query', { method: 'POST', ip: '10.10.0.2', body: { steamInput: '76561198000000001' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.member.profileUrl, 'https://steamcommunity.com/profiles/76561198000000001');
    assert.deepEqual(result.payload.member.specialty, ['pvp']);
    assert.equal(result.payload.member.currentWipe.isRegistered, true);
    assert.equal(result.payload.member.currentWipe.status, 'join_16h');
    assert.equal(result.payload.member.currentWipe.squad.name, 'Alpha Squad');
    assert.equal(result.payload.member.currentWipe.squad.leader.displayName, 'Leader Test');
    assert.equal(result.payload.member.currentWipe.squad.leader.steamId, '76561198000009999');
    assert.equal(result.payload.member.currentWipe.squad.leader.profileUrl, 'https://steamcommunity.com/profiles/76561198000009999');
    assert.deepEqual(result.payload.member.currentWipe.squad.leaders.map((leader) => leader.steamId), ['76561198000009999', '76561198000007777']);
    assert.equal(result.payload.member.squad.name, 'Alpha Squad');
    assert.deepEqual(result.payload.member.squad.leaders.map((leader) => leader.steamId), ['76561198000009999', '76561198000007777']);
    assert.equal(result.payload.member.inviterName, 'Leader Test');
    assert.equal(result.payload.member.id, 'member_test_1');
    assert.equal(Boolean(result.payload.member.createdAt), true);
    assert.equal(Boolean(result.payload.member.updatedAt), true);
    assert.equal(Boolean(result.payload.member.profileStats), true);

    result = await request('/query', { method: 'POST', ip: '10.10.0.18', body: { steamInput: '76561198000000001', detailed: false } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.isMember, true);
    assert.equal(Object.hasOwn(result.payload.member, 'id'), false);
    assert.equal(Object.hasOwn(result.payload.member, 'serverOnline'), false);
    assert.equal(Object.hasOwn(result.payload.member, 'profileStats'), false);

    const authCookie = cookie;
    cookie = '';
    result = await request('/query', { method: 'POST', ip: '10.10.0.3', body: { steamInput: '76561198000000001' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.isMember, true);
    assert.equal(result.payload.member.profileUrl, 'https://steamcommunity.com/profiles/76561198000000001');
    assert.equal(result.payload.member.currentWipe.isRegistered, true);
    assert.equal(result.payload.member.currentWipe.squad.name, 'Alpha Squad');
    assert.equal(result.payload.member.currentWipe.squad.leader.displayName, 'Leader Test');
    assert.equal(result.payload.member.currentWipe.squad.leader.steamId, '76561198000009999');
    assert.equal(result.payload.member.currentWipe.squad.leader.profileUrl, 'https://steamcommunity.com/profiles/76561198000009999');
    assert.deepEqual(result.payload.member.currentWipe.squad.leaders.map((leader) => leader.steamId), ['76561198000009999', '76561198000007777']);
    assert.equal('serverOnline' in result.payload.member, false);
    assert.equal(result.payload.kdaSync.source, 'cache');
    assert.equal(Object.hasOwn(result.payload.member, 'inviterName'), false);
    assert.equal(Object.hasOwn(result.payload.member, 'invitedAt'), false);
    assert.equal(Object.hasOwn(result.payload.member, 'specialty'), false);
    result = await request('/query', { method: 'POST', ip: '10.10.0.8', body: { steamInput: '76561198000000005' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.isMember, true);
    assert.equal(result.payload.member.currentWipe.isRegistered, false);
    assert.equal(result.payload.member.squad.name, 'Alpha Squad');
    assert.equal(result.payload.member.squad.leader.displayName, 'Leader Test');
    assert.deepEqual(result.payload.member.squad.leaders.map((leader) => leader.steamId), ['76561198000009999', '76561198000007777']);
    result = await request('/query', { method: 'POST', ip: '10.10.0.3', body: { steamInput: '76561198000000004' } });
    assert.equal(result.response.status, 429);
    assert.equal(result.payload.error, '请求过于频繁，请稍后再试');
    cookie = authCookie;

    const bravoProfileOnlineStart = new Date(Date.now() - 100 * 60_000).toISOString();
    const bravoProfileOnlineStop = new Date(Date.now() - 10 * 60_000).toISOString();
    await updateStore((store) => {
      store.memberProfiles = (store.memberProfiles || []).filter((profile) => profile.memberId !== 'member_test_2');
      store.memberProfiles.push({
        id: 'member_profile_kda_import_bravo',
        memberId: 'member_test_2',
        steamId: '76561198000000004',
        playTimeMinutes: 1440,
        battlemetricsPlayerId: 'bm_profile_bravo',
        battlemetricsServerId: '36933209',
        battlemetricsServerName: 'Vital Rust Workflow Server',
        battlemetricsWipeId: wipeId,
        battlemetricsWipeName: 'Vital Rust Workflow Wipe',
        battlemetricsWipeStatus: 'active',
        battlemetricsLastOnlineAt: bravoProfileOnlineStart,
        battlemetricsLastOfflineAt: bravoProfileOnlineStop,
        battlemetricsServerPlayTimeSeconds: 5400,
        battlemetricsWeeklyPlayTimeSeconds: 5400,
        battlemetricsSyncedAt: bravoProfileOnlineStop
      });
    });

    result = await request('/kda/import', {
      method: 'POST',
      body: {
        wipeId,
        text: [
          'Steam ID,kills,t3Kills,deaths,assists,rockets,sulfur,metalOre,building,playTimeMinutes',
          '76561198000000001,10,3,2,4,12,12000,8000,55,320',
          '76561198000000004,4,1,5,0,3,2000,5000,25,180'
        ].join('\n')
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.imported, 2);
    const importedKdaStore = await readStore();
    const importedBravoKda = importedKdaStore.kdaRows.find((row) => row.wipeId === wipeId && row.memberId === 'member_test_2');
    assert.equal(importedBravoKda.onlineTimeMinutes, 90);
    assert.equal(importedBravoKda.playTimeMinutes, 180);
    assert.equal(importedBravoKda.onlineSummary.battlemetricsPlayerId, 'bm_profile_bravo');
    assert.equal(importedBravoKda.onlineSummary.lastOnlineAt, bravoProfileOnlineStart);

    result = await request('/query', { method: 'POST', ip: '10.10.0.6', body: { steamInput: '76561198000000001' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.member.currentKda.kills, 10);
    assert.equal(result.payload.member.currentKda.t3Kills, 3);
    assert.equal(result.payload.member.currentKda.rockets, 12);
    assert.equal(result.payload.member.currentKda.sulfur, 12000);
    assert.equal(result.payload.member.currentKda.serverName, 'Vital Rust Workflow Server');

    result = await request('/members/member_test_1/profile');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.member.steamId, '76561198000000001');
    assert.equal(result.payload.member.discordId, 'discord-alpha');
    assert.equal(result.payload.member.profileStats.playTimeMinutes, 320);
    assert.equal(result.payload.member.profileStats.inventoryPublic, false);

    const profileFetch = globalThis.fetch;
    const privateProfileMemberId = 'member_profile_private_probe';
    const privateProfileSteamId = '76561198000000998';
    const bmFallbackMemberId = 'member_profile_bm_fallback_probe';
    const bmFallbackSteamId = '76561198000000996';
    const bmFallbackPlayerId = 'bm_profile_playtime_fallback';
    const officialRiskSteamId = '76561198012345678';
    const bmFallbackSessionStart = new Date(Date.now() - 95 * 60_000).toISOString();
    const bmFallbackSessionStop = new Date(Date.now() - 5 * 60_000).toISOString();
    const bmFallbackRequests = [];
    let bmFallbackShouldFail = false;
    const steamBanRequests = [];
    await updateStore((store) => {
      const createdAt = nowIso();
      store.members.push({
        id: privateProfileMemberId,
        steamId: privateProfileSteamId,
        rawInput: privateProfileSteamId,
        customName: 'Private Profile Probe',
        steamNickname: 'Private Profile Probe',
        invitedByUserId: 'user_root',
        createdAt,
        updatedAt: createdAt
      });
      store.members.push({
        id: bmFallbackMemberId,
        steamId: bmFallbackSteamId,
        rawInput: bmFallbackSteamId,
        customName: 'BM Fallback Probe',
        steamNickname: 'BM Fallback Probe',
        battlemetricsId: bmFallbackPlayerId,
        invitedByUserId: 'user_root',
        createdAt,
        updatedAt: createdAt
      });
    });
    process.env.NB_DISABLE_EXTERNAL_VITAL = '0';
    const largeInventorySteamId = '76561198000006666';
    let largeInventoryRequestCount = 0;
    globalThis.fetch = async (url, options = {}) => {
      if (String(url) === `https://steamcommunity.com/profiles/${largeInventorySteamId}?xml=1`) {
        return new Response([
          '<profile>',
          `<steamID64>${largeInventorySteamId}</steamID64>`,
          '<steamID>Large Inventory Probe</steamID>',
          '<privacyState>public</privacyState>',
          '<visibilityState>3</visibilityState>',
          '<avatarFull>https://example.test/avatar-large-inventory.jpg</avatarFull>',
          '</profile>'
        ].join(''), { status: 200, headers: { 'content-type': 'text/xml' } });
      }
      if (String(url) === `https://rust-kda.anlonely.me/api/player/${largeInventorySteamId}`) {
        return new Response(JSON.stringify({
          name: 'Large Inventory Probe',
          avatar: 'https://example.test/avatar-large-inventory-kda.jpg',
          profileUrl: `https://steamcommunity.com/profiles/${largeInventorySteamId}`,
          playTimeHours: 13808
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(url) === `https://rust-kda.anlonely.me/api/inventory/${largeInventorySteamId}`) {
        largeInventoryRequestCount += 1;
        return new Promise((resolve, reject) => {
          const signal = options?.signal;
          if (signal?.aborted) {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
            return;
          }
          const timer = setTimeout(() => resolve(new Response(JSON.stringify({
            inventoryAvailable: true,
            totalSummary: { totalValue: 360.6, tradableValue: 300.5, currency: 'USD' },
            skinsSummary: { available: true, totalValue: 360.6, tradableValue: 300.5 },
            storeSummary: { available: true, ownedCount: 3600, ownedValue: 60.1 },
            skins: Array.from({ length: 3 }, (_, index) => ({ marketHashName: `Large Skin ${index + 1}`, quantity: 1200, price: 0.1 })),
            storeItems: []
          }), { status: 200, headers: { 'content-type': 'application/json' } })), 20);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      }
      if (String(url) === 'https://steamcommunity.com/profiles/76561198000000001?xml=1') {
        return new Response([
          '<profile>',
          '<steamID64>76561198000000001</steamID64>',
          '<steamID>Alpha Synced</steamID>',
          '<privacyState>public</privacyState>',
          '<visibilityState>3</visibilityState>',
          '<avatarFull>https://avatars.steamstatic.com/alpha-member_full.jpg</avatarFull>',
          '</profile>'
        ].join(''), { status: 200, headers: { 'content-type': 'text/xml' } });
      }
      if (String(url) === 'https://steamcommunity.com/broadcast/getbroadcastmpd/?steamid=76561198000000001') {
        return new Response(JSON.stringify({
          success: 'unavailable',
          retry: 30000,
          broadcastid: 0,
          eresult: 1
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(url) === `https://steamcommunity.com/profiles/${privateProfileSteamId}?xml=1`) {
        return new Response([
          '<profile>',
          `<steamID64>${privateProfileSteamId}</steamID64>`,
          '<steamID>Private Profile Probe</steamID>',
          '<privacyState>private</privacyState>',
          '<visibilityState>1</visibilityState>',
          '<avatarFull>https://example.test/avatar-private.jpg</avatarFull>',
          '</profile>'
        ].join(''), { status: 200, headers: { 'content-type': 'text/xml' } });
      }
      if (String(url) === `https://steamcommunity.com/broadcast/getbroadcastmpd/?steamid=${privateProfileSteamId}`) {
        return new Response(JSON.stringify({
          success: 'user_restricted',
          retry: 30000,
          broadcastid: 0,
          eresult: 1
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(url) === `https://steamcommunity.com/profiles/${bmFallbackSteamId}?xml=1`) {
        return new Response([
          '<profile>',
          `<steamID64>${bmFallbackSteamId}</steamID64>`,
          '<steamID>BM Fallback Probe</steamID>',
          '<privacyState>public</privacyState>',
          '<visibilityState>3</visibilityState>',
          '<avatarFull>https://example.test/avatar-bm-fallback.jpg</avatarFull>',
          '</profile>'
        ].join(''), { status: 200, headers: { 'content-type': 'text/xml' } });
      }
      if (String(url) === `https://steamcommunity.com/profiles/${officialRiskSteamId}?xml=1`) {
        return new Response([
          '<profile>',
          `<steamID64>${officialRiskSteamId}</steamID64>`,
          '<steamID>Official Risk Probe</steamID>',
          '<privacyState>public</privacyState>',
          '<visibilityState>3</visibilityState>',
          '<avatarFull>https://example.test/avatar-official-risk.jpg</avatarFull>',
          '</profile>'
        ].join(''), { status: 200, headers: { 'content-type': 'text/xml' } });
      }
      if (String(url) === `https://steamcommunity.com/broadcast/getbroadcastmpd/?steamid=${bmFallbackSteamId}`) {
        return new Response(JSON.stringify({
          success: 'unavailable',
          retry: 30000,
          broadcastid: 0,
          eresult: 1
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(url) === `https://steamcommunity.com/broadcast/getbroadcastmpd/?steamid=${officialRiskSteamId}`) {
        return new Response(JSON.stringify({
          success: 'user_restricted',
          retry: 30000,
          broadcastid: 0,
          eresult: 1
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(url) === 'https://rust-kda.anlonely.me/api/player/76561198000000001') {
        return new Response(JSON.stringify({
          name: 'Alpha Synced',
          avatarMedium: 'https://avatars.steamstatic.com/alpha-member_full.jpg',
          profileUrl: 'https://steamcommunity.com/profiles/76561198000000001',
          playTimeHours: 12.5
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(url) === 'https://rust-kda.anlonely.me/api/inventory/76561198000000001') {
        return new Response(JSON.stringify({
          inventoryAvailable: true,
          totalSummary: { totalValue: 88.6, tradableValue: 88.6, currency: 'USD' },
          storeSummary: { ownedValue: 12.4 }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(url) === 'https://rust-kda.anlonely.me/api/kda/76561198000000001') {
        return new Response(JSON.stringify({
          is_private: true,
          personaname: 'Alpha Synced',
          minutes_played: 750,
          achievement_count: 42,
          kdr: 3,
          kills: 24,
          deaths: 8,
          headshot: 12,
          rocket_fired: 7,
          bullets: {
            fired: 300,
            hits: {
              players: 120,
              buildings: 30,
              signs: 5,
              wolves: 2,
              bears: 3,
              boars: 4,
              deer: 5,
              horses: 6,
              dead_players: 7,
              other: 8
            }
          },
          resources: {
            sulfurOre: 2400,
            metalOre: 1200,
            wood: 600,
            stone: 300
          },
          sections: [{
            id: 'pvp',
            title: 'PVP',
            emoji: '⚔️',
            items: [
              { id: 'kills', label: '击杀', value: 24, icon: '💀' },
              { id: 'headshots', label: '子弹爆头', value: 12, icon: '🔥' }
            ]
          }]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(url) === `https://rust-kda.anlonely.me/api/player/${privateProfileSteamId}`) {
        return new Response(JSON.stringify({
          name: 'Private Profile Probe',
          avatar: 'https://example.test/avatar-private-kda.jpg',
          profileUrl: `https://steamcommunity.com/profiles/${privateProfileSteamId}`,
          playTimeHours: null
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(url) === `https://rust-kda.anlonely.me/api/inventory/${privateProfileSteamId}`) {
        return new Response(JSON.stringify({
          inventoryAvailable: false,
          totalSummary: { totalValue: null, tradableValue: null, ownedStoreValue: 0, currency: 'USD' },
          skinsSummary: { available: false, totalValue: null, tradableValue: null },
          storeSummary: { available: true, ownedCount: 0, ownedValue: 0 },
          dlcSummary: { available: false, ownedValue: null }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(url) === `https://rust-kda.anlonely.me/api/kda/${privateProfileSteamId}`) {
        return new Promise((resolve, reject) => {
          const signal = options?.signal;
          if (signal?.aborted) {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
            return;
          }
          signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      }
      if (String(url) === `https://rust-kda.anlonely.me/api/player/${bmFallbackSteamId}`) {
        return new Response(JSON.stringify({
          name: 'BM Fallback Probe',
          avatar: 'https://example.test/avatar-bm-fallback-kda.jpg',
          profileUrl: `https://steamcommunity.com/profiles/${bmFallbackSteamId}`,
          playTimeHours: null
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(url) === `https://rust-kda.anlonely.me/api/inventory/${bmFallbackSteamId}`) {
        return new Response(JSON.stringify({
          inventoryAvailable: false,
          totalSummary: { totalValue: null, tradableValue: null, ownedStoreValue: 0, currency: 'USD' },
          skinsSummary: { available: false, totalValue: null, tradableValue: null },
          storeSummary: { available: true, ownedCount: 0, ownedValue: 0 },
          dlcSummary: { available: false, ownedValue: null }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(url) === `https://rust-kda.anlonely.me/api/kda/${bmFallbackSteamId}`) {
        return new Response(JSON.stringify({
          summary: { kills: 0, deaths: 0, kdRatio: 0 },
          sections: []
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(url) === `https://rust-kda.anlonely.me/api/player/${officialRiskSteamId}`) {
        return new Response(JSON.stringify({
          name: 'Official Risk Probe',
          avatar: 'https://example.test/avatar-official-risk-kda.jpg',
          profileUrl: `https://steamcommunity.com/profiles/${officialRiskSteamId}`,
          playTimeHours: 100
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(url) === `https://rust-kda.anlonely.me/api/kda/${officialRiskSteamId}`) {
        return new Response(JSON.stringify({
          kills: 6,
          deaths: 2,
          assists: 1,
          headshot: 3,
          bullet_fired: 80,
          bullet_hit_player: 40
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(url).startsWith('https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/')) {
        const href = String(url);
        steamBanRequests.push(href);
        const requestUrl = new URL(href);
        const requestedSteamIds = String(requestUrl.searchParams.get('steamids') || '').split(',').filter(Boolean);
        const players = requestedSteamIds.map((steamId) => {
          if (steamId === privateProfileSteamId || steamId === officialRiskSteamId) {
            return {
              SteamId: steamId,
              CommunityBanned: true,
              VACBanned: true,
              NumberOfVACBans: 1,
              DaysSinceLastBan: 1408,
              NumberOfGameBans: 2,
              EconomyBan: 'probation'
            };
          }
          return {
            SteamId: steamId,
            CommunityBanned: false,
            VACBanned: false,
            NumberOfVACBans: 0,
            DaysSinceLastBan: 0,
            NumberOfGameBans: 0,
            EconomyBan: 'none'
          };
        });
        return new Response(JSON.stringify({ players }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(url).startsWith('https://api.battlemetrics.com')) {
        const href = String(url);
        bmFallbackRequests.push({ href, authorization: options.headers?.authorization || '' });
        if (bmFallbackShouldFail && href.includes(bmFallbackPlayerId)) {
          return new Response(JSON.stringify({ errors: [{ title: 'temporary BattleMetrics failure' }] }), { status: 400, headers: { 'content-type': 'application/json' } });
        }
        if (href.includes(`/players/${bmFallbackPlayerId}/servers/36933209`)) {
          return new Response(JSON.stringify({
            data: {
              type: 'playerServer',
              id: `${bmFallbackPlayerId}-36933209`,
              attributes: {
                firstSeen: bmFallbackSessionStart,
                lastSeen: bmFallbackSessionStop,
                timePlayed: 5400,
                online: false
              }
            }
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (href.includes(`/players/${bmFallbackPlayerId}/relationships/sessions`)) {
          return new Response(JSON.stringify({
            data: [
              { type: 'session', id: 'bm_fallback_session_1', attributes: { start: bmFallbackSessionStart, stop: bmFallbackSessionStop, name: 'BM Fallback Probe', firstTime: false } }
            ],
            links: {}
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ errors: [{ title: 'unexpected BattleMetrics fallback url' }] }), { status: 404, headers: { 'content-type': 'application/json' } });
      }
      return profileFetch(url, options);
    };
    try {
      result = await request('/settings/member-profiles/sync', {
        method: 'POST',
        ip: '10.10.0.15',
        body: { memberIds: ['member_test_1', privateProfileMemberId, bmFallbackMemberId] }
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.syncState.status, 'running');
      assert.equal(result.payload.syncState.requested, 3);
      const earlyRestriction = await waitForStoreCondition((store) => {
        const state = store.syncState?.memberProfiles || {};
        const profile = (store.memberProfiles || []).find((item) => item.memberId === privateProfileMemberId);
        if (
          state.status === 'running' &&
          Number(state.completed || 0) < Number(state.requested || 0) &&
          profile?.accountRestricted === true
        ) {
          return { state, profile };
        }
        return null;
      }, { attempts: 80, delayMs: 50, label: 'early account restriction cache update' });
      assert.equal(earlyRestriction.profile.accountRestrictionStatus, 'user_restricted');
      assert.equal(Number(earlyRestriction.state.accountRestrictionCompleted || 0) >= 1, true);
      const profileSyncState = await waitForSyncState('memberProfiles');
      assert.equal(profileSyncState.status, 'complete');
      assert.equal(profileSyncState.updated, 3);
      result = await request('/members?limit=1&q=76561198000000001');
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.members.length, 1);
      assert.equal(result.payload.members[0].accountSignals.officialKda.kills, 24);
      assert.equal(result.payload.members[0].accountSignals.officialKda.sections, undefined);
      assert.equal(result.payload.members[0].accountSignals.officialKda.metrics, undefined);
      assert.equal(result.payload.members[0].accountSignals.officialKda.raw, undefined);
      result = await request('/members/member_test_1/profile');
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.member.profileStats.playTimeMinutes, 750);
      assert.equal(result.payload.member.profileStats.inventoryPublic, true);
      assert.equal(result.payload.member.profileStats.inventoryValue, 101);
      assert.equal(result.payload.member.profileStats.profilePublic, true);
      assert.equal(result.payload.member.profileStats.officialKda.kills, 24);
      assert.equal(result.payload.member.profileStats.officialKda.headshots, 12);
      assert.equal(result.payload.member.profileStats.officialKda.rockets, 7);
      assert.equal(result.payload.member.profileStats.officialKda.sulfur, 2400);
      assert.equal(result.payload.member.profileStats.officialKda.accuracy, 40);
      assert.equal(result.payload.member.profileStats.officialKda.totalHits, 190);
      assert.equal(result.payload.member.profileStats.officialKda.buildingHits, 30);
      assert.equal(result.payload.member.profileStats.officialKda.playTimeMinutes, 750);
      assert.equal(result.payload.member.profileStats.officialKda.achievementsCount, 42);
      assert.equal(result.payload.member.profileStats.officialKda.sections[0].items[0].value, 24);
      assert.equal(result.payload.member.profileStats.accountRestricted, false);
      assert.equal(result.payload.member.profileStats.accountRestrictionStatus, 'unavailable');
      assert.equal(result.payload.member.profileStats.vacBanned, false);
      assert.equal(result.payload.member.profileStats.numberOfGameBans, 0);
      assert.equal(result.payload.member.profileStats.communityBanned, false);
      assert.equal(result.payload.member.profileStats.economyRestricted, false);
      result = await request('/query', { method: 'POST', ip: '10.10.0.16', body: { steamInput: '76561198000000001' } });
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.member.profileStats.playTimeMinutes, 750);
      assert.equal(result.payload.member.profileStats.inventoryValue, 101);
      assert.equal(result.payload.member.profileStats.officialKda.kills, 24);
      assert.equal(result.payload.member.profileStats.vacBanned, false);
      result = await request('/rust-kda/official?steamInput=76561198000000001');
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.member.squadId, 'squad_test_1');
      assert.equal(result.payload.member.squadName, 'Alpha Squad');
      assert.equal(result.payload.kda.headshots, 12);
      assert.equal(result.payload.kda.hits, 120);
      assert.equal(result.payload.kda.totalHits, 190);
      assert.equal(result.payload.kda.headshotRate, 10);
      assert.equal(result.payload.kda.accuracy, 40);
      assert.equal(result.payload.kda.playTimeMinutes, 750);
      assert.equal(result.payload.kda.achievementsCount, 42);
      assert.equal(result.payload.account.accountRestricted, false);
      assert.equal(result.payload.account.accountRestrictionStatus, 'unavailable');
      assert.match(result.payload.account.accountRestrictionCheckedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(result.payload.account.vacBanned, false);
      assert.equal(result.payload.account.numberOfVacBans, 0);
      assert.equal(result.payload.account.numberOfGameBans, 0);
      assert.equal(result.payload.account.communityBanned, false);
      assert.equal(result.payload.account.economyRestricted, false);
      assert.match(result.payload.account.steamBanCheckedAt, /^\d{4}-\d{2}-\d{2}T/);
      result = await request('/moose/servers');
      assert.equal(result.response.status, 200);
      assert.deepEqual(result.payload.servers.map((item) => item.id), ['eu-mondays', 'eu-medium', 'eu-main', 'eu-monthly']);
      result = await request('/moose/servers/eu-main/periods');
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.periods[1].name, '07/30/2026 18:00:00');
      result = await request('/rust-kda/moose', {
        method: 'POST',
        body: {
          steamInput: '76561198000000001',
          serverId: 'eu-main',
          period: 'All Time'
        }
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.source, 'Moose.GG');
      assert.equal(result.payload.moose.server.id, 'eu-main');
      assert.equal(result.payload.moose.identity.steamId, '76561198000000001');
      assert.equal(result.payload.moose.categories[0].selectedMatch.values.kdr, '2.50');
      assert.equal(result.payload.moose.categories[0].fields[1].labelZh, '高金');
      result = await request(`/rust-kda/official?steamInput=${officialRiskSteamId}`);
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.member, null);
      assert.equal(result.payload.kda.kills, 6);
      assert.equal(result.payload.account.accountRestricted, true);
      assert.equal(result.payload.account.accountRestrictionStatus, 'user_restricted');
      assert.match(result.payload.account.accountRestrictionCheckedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(result.payload.account.vacBanned, true);
      assert.equal(result.payload.account.numberOfVacBans, 1);
      assert.equal(result.payload.account.numberOfGameBans, 2);
      assert.equal(result.payload.account.daysSinceLastBan, 1408);
      assert.equal(result.payload.account.communityBanned, true);
      assert.equal(result.payload.account.economyRestricted, true);
      assert.equal(result.payload.account.economyBan, 'probation');
      assert.match(result.payload.account.steamBanCheckedAt, /^\d{4}-\d{2}-\d{2}T/);
      const [largeInventoryFirst, largeInventorySecond] = await Promise.all([
        request(`/rust-kda/inventory?steamInput=${largeInventorySteamId}`),
        request(`/rust-kda/inventory?steamInput=${largeInventorySteamId}`)
      ]);
      assert.equal(largeInventoryFirst.response.status, 200);
      assert.equal(largeInventorySecond.response.status, 200);
      assert.equal(largeInventoryFirst.payload.inventory.totalSummary.totalValue, 360.6);
      assert.equal(largeInventorySecond.payload.inventory.totalSummary.totalValue, 360.6);
      assert.equal(largeInventoryRequestCount, 1);
      result = await request(`/rust-kda/inventory?steamInput=${largeInventorySteamId}`);
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.inventory.skins[0].quantity, 1200);
      assert.equal(largeInventoryRequestCount, 1);
      result = await request(`/members/${privateProfileMemberId}/profile`);
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.member.profileStats.profilePublic, false);
      assert.equal(result.payload.member.profileStats.playTimeVisibility, 'private');
      assert.equal(result.payload.member.profileStats.inventoryPublic, false);
      assert.equal(result.payload.member.profileStats.inventoryValue, null);
      assert.equal(result.payload.member.profileStats.inventoryVisibility, 'private');
      assert.equal(result.payload.member.profileStats.accountRestricted, true);
      assert.equal(result.payload.member.profileStats.accountRestrictionStatus, 'user_restricted');
      assert.equal(result.payload.member.profileStats.vacBanned, true);
      assert.equal(result.payload.member.profileStats.numberOfVacBans, 1);
      assert.equal(result.payload.member.profileStats.numberOfGameBans, 2);
      assert.equal(result.payload.member.profileStats.daysSinceLastBan, 1408);
      assert.equal(result.payload.member.profileStats.communityBanned, true);
      assert.equal(result.payload.member.profileStats.economyRestricted, true);
      assert.equal(result.payload.member.profileStats.economyBan, 'probation');
      assert.match(result.payload.member.profileStats.steamBanCheckedAt, /^\d{4}-\d{2}-\d{2}T/);
      result = await request(`/members/${bmFallbackMemberId}/profile`);
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.member.profileStats.playTimeKnown, false);
      assert.equal(result.payload.member.profileStats.playTimeMinutes, 0);
      assert.equal(result.payload.member.profileStats.battlemetrics.battlemetricsPlayerId, bmFallbackPlayerId);
      assert.equal(result.payload.member.profileStats.battlemetrics.serverPlayTimeMinutes, 90);
      assert.equal(result.payload.member.profileStats.battlemetrics.totalPlayTimeMinutes, 90);
      assert.equal(result.payload.member.profileStats.battlemetrics.error, '');
      assert.equal(bmFallbackRequests.every((item) => item.authorization.startsWith('Bearer ')), true);
      assert.equal(bmFallbackRequests.filter((item) => item.href.includes(`/players/${bmFallbackPlayerId}/servers/36933209`)).length, 1);
      assert.equal(bmFallbackRequests.filter((item) => item.href.includes(`/players/${bmFallbackPlayerId}/relationships/sessions`)).length, 2);
      assert.equal(steamBanRequests.length, 3);
      assert.deepEqual(steamBanRequests.map((href) => new URL(href).searchParams.get('steamids').split(',').length).sort((a, b) => a - b), [1, 1, 3]);
      assert.equal(steamBanRequests.some((href) => new URL(href).searchParams.get('steamids') === officialRiskSteamId), true);
      result = await request('/members');
      assert.equal(result.response.status, 200);
      const restrictedMember = result.payload.members.find((member) => member.id === privateProfileMemberId);
      assert.equal(restrictedMember.accountSignals.playTimeKnown, false);
      assert.equal(restrictedMember.accountSignals.playTimeVisibility, 'private');
      assert.equal(restrictedMember.accountSignals.inventoryPublic, false);
      assert.equal(restrictedMember.accountSignals.inventoryVisibility, 'private');
      assert.equal(restrictedMember.accountSignals.accountRestricted, true);
      assert.equal(restrictedMember.accountSignals.accountRestrictionStatus, 'user_restricted');
      assert.equal(restrictedMember.accountSignals.vacBanned, true);
      assert.equal(restrictedMember.accountSignals.numberOfGameBans, 2);
      assert.equal(restrictedMember.accountSignals.daysSinceLastBan, 1408);
      assert.equal(restrictedMember.accountSignals.communityBanned, true);
      assert.equal(restrictedMember.accountSignals.economyRestricted, true);
      const bmFallbackMember = result.payload.members.find((member) => member.id === bmFallbackMemberId);
      assert.equal(bmFallbackMember.accountSignals.playTimeKnown, false);
      assert.equal(bmFallbackMember.accountSignals.playTimeMinutes, 0);
      assert.equal(bmFallbackMember.accountSignals.onlineTimeKnown, true);
      assert.equal(bmFallbackMember.accountSignals.onlineTimeMinutes, 90);
      assert.equal(bmFallbackMember.accountSignals.battlemetricsServerPlayTimeMinutes, 90);
      assert.equal(bmFallbackMember.accountSignals.battlemetricsTotalPlayTimeMinutes, 90);
      assert.equal(bmFallbackMember.accountSignals.lastOnlineAt, bmFallbackSessionStart);
      bmFallbackShouldFail = true;
      bmFallbackRequests.length = 0;
      result = await request('/settings/member-profiles/sync', {
        method: 'POST',
        ip: '10.10.0.151',
        body: { memberIds: [bmFallbackMemberId] }
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.syncState.status, 'running');
      const failedFallbackSyncState = await waitForSyncState('memberProfiles');
      assert.equal(failedFallbackSyncState.status, 'complete');
      assert.equal(bmFallbackRequests.some((item) => item.href.includes(bmFallbackPlayerId)), true);
      result = await request(`/members/${bmFallbackMemberId}/profile`);
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.member.profileStats.playTimeKnown, false);
      assert.equal(result.payload.member.profileStats.playTimeMinutes, 0);
      assert.equal(result.payload.member.profileStats.battlemetrics.totalPlayTimeMinutes, 90);
    } finally {
      globalThis.fetch = profileFetch;
      process.env.NB_DISABLE_EXTERNAL_VITAL = '1';
      await updateStore((store) => {
        store.members = store.members.filter((member) => ![privateProfileMemberId, bmFallbackMemberId].includes(member.id));
        store.memberProfiles = store.memberProfiles.filter((profile) => ![privateProfileMemberId, bmFallbackMemberId].includes(profile.memberId));
      });
    }

    const probeCreatedAt = nowIso();
    await updateStore((store) => {
      store.members.push({
        id: 'member_profile_visibility_probe',
        steamId: '76561198000000999',
        customName: 'Visibility Probe',
        steamNickname: 'Visibility Probe',
        invitedByUserId: 'user_root',
        createdAt: probeCreatedAt,
        updatedAt: probeCreatedAt
      });
      store.memberProfiles.push({
        id: 'profile_visibility_probe',
        memberId: 'member_profile_visibility_probe',
        steamId: '76561198000000999',
        playTimeMinutes: 0,
        playTimeKnown: true,
        inventoryValue: 0,
        inventoryCurrency: 'USD',
        inventoryPublic: true,
        profilePublic: true,
        fetchedAt: probeCreatedAt,
        source: 'test'
      });
      store.kdaRows.push({
        id: 'kda_profile_visibility_probe',
        wipeId,
        memberId: 'member_profile_visibility_probe',
        steamId: '76561198000000999',
        playTimeMinutes: 120,
        source: 'vital',
        syncedAt: probeCreatedAt
      });
    });
    result = await request('/members/member_profile_visibility_probe/profile');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.member.profileStats.playTimeKnown, false);
    assert.equal(result.payload.member.profileStats.playTimeVisibility, 'private');
    assert.equal(result.payload.member.profileStats.inventoryPublic, false);
    assert.equal(result.payload.member.profileStats.inventoryValue, null);
    assert.equal(result.payload.member.profileStats.inventoryVisibility, 'private');
    result = await request('/members');
    const visibilityProbe = result.payload.members.find((member) => member.id === 'member_profile_visibility_probe');
    assert.equal(visibilityProbe.accountSignals.playTimeKnown, false);
    assert.equal(visibilityProbe.accountSignals.playTimeMinutes, 0);
    assert.equal(visibilityProbe.accountSignals.playTimeVisibility, 'private');
    assert.equal(visibilityProbe.accountSignals.inventoryPublic, false);
    assert.equal(visibilityProbe.accountSignals.inventoryValue, null);
    assert.equal(visibilityProbe.accountSignals.inventoryVisibility, 'private');
    result = await request('/account-alert-dismissals', {
      method: 'POST',
      body: { id: 'member_profile_visibility_probe:private-inventory' }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.dismissals.some((item) => item.id === 'member_profile_visibility_probe:private-inventory'), true);
    result = await request('/account-alert-dismissals', {
      method: 'POST',
      body: { id: 'member_profile_visibility_probe:private-account' }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.dismissals.some((item) => item.id === 'member_profile_visibility_probe:private-account'), true);
    result = await request('/account-alert-dismissals');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.dismissals.some((item) => item.id === 'member_profile_visibility_probe:private-inventory'), true);
    assert.equal(result.payload.dismissals.some((item) => item.id === 'member_profile_visibility_probe:private-account'), true);
    result = await request('/account-alert-dismissals', { method: 'DELETE' });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.cleared >= 2, true);
    assert.equal(result.payload.dismissals.length, 0);
    result = await request('/account-alert-dismissals');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.dismissals.length, 0);
    result = await request('/settings/account-risk');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.accountRisk.rules.some((rule) => rule.id === 'account-restricted' && rule.type === 'account_restricted'), true);
    assert.equal(result.payload.accountRisk.rules.some((rule) => rule.id === 'steam-ban-or-restriction' && rule.type === 'steam_ban_or_restriction'), true);
    assert.equal(result.payload.accountRisk.rules.some((rule) => rule.id === 'low-game-hours'), true);
    result = await request('/settings/account-risk', {
      method: 'PUT',
      body: {
        squadFilter: '__unassigned',
        rules: [{
          name: 'KD high',
          type: 'kd',
          operator: 'gt',
          threshold: 5,
          enabled: true
        }]
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.accountRisk.configured, true);
    assert.equal(result.payload.accountRisk.squadFilter, '__unassigned');
    assert.equal(result.payload.accountRisk.rules.some((rule) => rule.id === 'account-restricted'), true);
    assert.equal(result.payload.accountRisk.rules.some((rule) => rule.id === 'steam-ban-or-restriction'), true);
    const kdRiskRule = result.payload.accountRisk.rules.find((rule) => rule.type === 'kd');
    assert.equal(Boolean(kdRiskRule), true);
    result = await request('/account-alert-dismissals', {
      method: 'POST',
      body: { id: 'member_profile_visibility_probe:steam-ban-or-restriction' }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.dismissals.some((item) => item.id === 'member_profile_visibility_probe:steam-ban-or-restriction'), true);
    const riskRuleAlertId = `member_profile_visibility_probe:${kdRiskRule.id}`;
    result = await request('/account-alert-dismissals', {
      method: 'POST',
      body: { id: riskRuleAlertId }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.dismissals.some((item) => item.id === riskRuleAlertId), true);
    result = await request('/account-alert-dismissals', {
      method: 'POST',
      body: { id: 'member_profile_visibility_probe:not-supported' }
    });
    assert.equal(result.response.status, 400);

    const rootCookieForAccountRisk = cookie;
    cookie = '';
    result = await request('/auth/login', { method: 'POST', body: { username: 'web_member', password: 'MemberPass123!' } });
    assert.equal(result.response.status, 200);
    result = await request('/account-alert-dismissals');
    assert.equal(result.response.status, 403);
    assert.equal(result.payload.error, '无权查看该模块');
    result = await request('/settings/account-risk');
    assert.equal(result.response.status, 403);
    assert.equal(result.payload.error, '无权查看该模块');
    result = await request('/account-alert-dismissals', {
      method: 'POST',
      body: { id: 'member_profile_visibility_probe:private-playtime' }
    });
    assert.equal(result.response.status, 403);
    assert.equal(result.payload.error, '无权修改该模块');

    cookie = '';
    result = await request('/auth/login', { method: 'POST', ip: '10.30.0.2', body: { username: 'readonly_viewer', password: 'ViewerPass123!' } });
    assert.equal(result.response.status, 200);
    result = await request('/account-alert-dismissals');
    assert.equal(result.response.status, 200);
    result = await request('/settings/account-risk');
    assert.equal(result.response.status, 200);
    result = await request('/account-alert-dismissals', {
      method: 'POST',
      body: { id: 'member_profile_visibility_probe:private-playtime' }
    });
    assert.equal(result.response.status, 403);
    assert.equal(result.payload.error, '只读账号只能查看和查询');

    cookie = '';
    result = await request('/auth/login', { method: 'POST', ip: '10.30.0.3', body: { username: 'leader_test', password: 'LeaderPass123!' } });
    assert.equal(result.response.status, 200);
    result = await request('/account-alert-dismissals');
    assert.equal(result.response.status, 200);
    result = await request('/settings/account-risk');
    assert.equal(result.response.status, 200);
    result = await request('/account-alert-dismissals', {
      method: 'POST',
      body: { id: 'member_profile_visibility_probe:private-playtime' }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.dismissals.some((item) => item.id === 'member_profile_visibility_probe:private-playtime'), true);
    cookie = rootCookieForAccountRisk;

    await updateStore((store) => {
      store.syncState.memberProfiles = {
        status: 'running',
        source: 'manual',
        requested: 3,
        updated: 1,
        failed: 0,
        completed: 1,
        percent: 33,
        estimatedSeconds: 6,
        etaSeconds: 4,
        startedAt: probeCreatedAt,
        syncJobId: 'sync_job_member_profile_cancel_probe',
        syncJobType: 'member_profile',
        syncJobSource: 'manual',
        syncJobScope: 'member_profile'
      };
      store.syncJobs.unshift({
        id: 'sync_job_member_profile_cancel_probe',
        type: 'member_profile',
        source: 'manual',
        scope: 'member_profile',
        status: 'running',
        totalCount: 3,
        doneCount: 1,
        failedCount: 0,
        skippedCount: 0,
        percent: 33,
        etaSeconds: 4,
        startedAt: probeCreatedAt,
        finishedAt: '',
        createdBy: 'user_root',
        errorSummary: '',
        details: {},
        createdAt: probeCreatedAt,
        updatedAt: probeCreatedAt
      });
    });
    result = await request('/settings/member-profiles/sync/cancel', { method: 'POST', body: {} });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.syncState.memberProfiles.status, 'cancelled');
    const cancelledStore = await readStore();
    assert.equal(cancelledStore.syncJobs.find((job) => job.id === 'sync_job_member_profile_cancel_probe')?.status, 'cancelled');
    await updateStore((store) => {
      store.members = store.members.filter((member) => member.id !== 'member_profile_visibility_probe');
      store.memberProfiles = store.memberProfiles.filter((profile) => profile.memberId !== 'member_profile_visibility_probe');
      store.accountAlertDismissals = (store.accountAlertDismissals || []).filter((item) => item.memberId !== 'member_profile_visibility_probe');
      store.syncJobs = (store.syncJobs || []).filter((job) => job.id !== 'sync_job_member_profile_cancel_probe');
      store.syncState.memberProfiles = {};
    });

    const originalFetch = globalThis.fetch;
    const sessionStart = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const sessionStop = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    const olderStart = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const olderStop = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const battlemetricsRequests = [];
    await updateStore((store) => {
      store.kdaRows.push({
        id: 'kda_archived_same_steam_before_bm_sync',
        wipeId,
        memberId: 'archived_member_same_steam_before_bm_sync',
        steamId: '76561198000000001',
        kills: 1,
        deaths: 1,
        onlineTimeMinutes: 0,
        source: 'manual_import',
        syncedAt: startedAt
      });
    });
    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      if (!href.startsWith('https://api.battlemetrics.com')) {
        return originalFetch(url, options);
      }
      battlemetricsRequests.push({ href, authorization: options.headers?.authorization || '' });
      if (href.endsWith('/players/match')) {
        return new Response(JSON.stringify({
          data: [],
          included: [{ type: 'player', id: 'bm_player_1', attributes: { name: 'AlphaBM' } }]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (href.includes('/players/bm_player_1/servers/36933209')) {
        return new Response(JSON.stringify({
          data: {
            type: 'playerServer',
            id: 'bm_player_1-36933209',
            attributes: {
              firstSeen: startedAt,
              lastSeen: sessionStop,
              timePlayed: 7200,
              online: false
            }
          }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (href.includes('/players/bm_player_1/relationships/sessions')) {
        return new Response(JSON.stringify({
          data: [
            { type: 'session', id: 'session_1', attributes: { start: sessionStart, stop: sessionStop, name: 'AlphaBM', firstTime: false } },
            { type: 'session', id: 'session_2', attributes: { start: olderStart, stop: olderStop, name: 'AlphaBM', firstTime: false } }
          ],
          links: { next: 'https://api.battlemetrics.com/players/bm_player_1/relationships/sessions?page%5Boffset%5D=100' }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ errors: [{ title: 'unexpected url' }] }), { status: 404, headers: { 'content-type': 'application/json' } });
    };
    try {
      result = await request('/settings/battlemetrics/sync-playtime', { method: 'POST', body: { memberIds: ['member_test_1'] } });
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.requested, 1);
      assert.equal(result.payload.updated, 1);
      assert.equal(result.payload.failed, 0);
      assert.equal(result.payload.serverId, '36933209');
      assert.equal(result.payload.serverName, 'Vital Rust Workflow Server');
      assert.equal(result.payload.wipeId, wipeId);
      assert.equal(result.payload.wipeName, 'Vital Rust Workflow Wipe');
      assert.equal(result.payload.wipeStatus, 'active');
      assert.equal(battlemetricsRequests.every((item) => item.authorization.startsWith('Bearer ')), true);
      assert.equal(battlemetricsRequests.length, 4);
      assert.equal(battlemetricsRequests.some((item) => item.href.includes('/servers/36933209')), true);
    } finally {
      globalThis.fetch = originalFetch;
    }

    result = await request('/members');
    assert.equal(result.response.status, 200);
    const onlineMember = result.payload.members.find((member) => member.id === 'member_test_1');
    assert.equal(onlineMember.battlemetricsId, 'bm_player_1');
    assert.equal(onlineMember.onlineSummary.battlemetricsServerId, '36933209');
    assert.equal(onlineMember.onlineSummary.serverName, 'Vital Rust Workflow Server');
    assert.equal(onlineMember.onlineSummary.wipeId, wipeId);
    assert.equal(onlineMember.onlineSummary.wipeName, 'Vital Rust Workflow Wipe');
    assert.equal(onlineMember.onlineSummary.wipeStatus, 'active');
    assert.equal(onlineMember.onlineSummary.lastOnlineAt, sessionStart);
    assert.equal(onlineMember.onlineSummary.lastOfflineAt, sessionStop);
    assert.equal(onlineMember.onlineSummary.serverPlayTimeMinutes, 135);
    assert.equal(onlineMember.onlineSummary.weeklyPlayTimeMinutes, 135);
    assert.equal(onlineMember.onlineSummary.sessionTruncated, true);
    assert.equal(onlineMember.onlineSummary.partial, true);
    assert.equal(onlineMember.onlineSummary.sessionPageLimit, 1);
    assert.equal(onlineMember.onlineSummary.matchConfidence, 'steam-match');
    assert.equal(onlineMember.onlineSummary.matchFirstSeenAt, startedAt);
    assert.equal(onlineMember.accountSignals.playTimeMinutes, 750);
    assert.equal(onlineMember.accountSignals.playTimeKnown, true);
    assert.equal(onlineMember.accountSignals.inventoryPublic, true);
    assert.equal(onlineMember.accountSignals.inventoryValue, 101);
    assert.equal(onlineMember.accountSignals.lastOnlineAt, sessionStart);
    const kdaSteamBackfilledStore = await readStore();
    const archivedSteamMatchedKda = kdaSteamBackfilledStore.kdaRows.find((row) => row.id === 'kda_archived_same_steam_before_bm_sync');
    assert.equal(archivedSteamMatchedKda.onlineTimeMinutes, 135);
    assert.equal(archivedSteamMatchedKda.onlineSummary.battlemetricsPlayerId, 'bm_player_1');
    assert.equal(archivedSteamMatchedKda.onlineSummary.sessionTruncated, true);
    assert.equal(kdaSteamBackfilledStore.kdaSnapshots.some((row) => (
      row.memberId === 'archived_member_same_steam_before_bm_sync' &&
      row.onlineTimeMinutes === 135 &&
      row.onlineSummary?.battlemetricsPlayerId === 'bm_player_1'
    )), true);

    const totalOnlySteamId = '76561198000000122';
    await updateStore((store) => {
      const createdAt = nowIso();
      store.members.push({
        id: 'member_bm_total_only',
        steamId: totalOnlySteamId,
        rawInput: totalOnlySteamId,
        customName: 'BM Total Only',
        steamNickname: 'BMTotalOnly',
        avatar: '',
        discordId: '',
        wechatId: '',
        notes: '',
        specialty: [],
        battlemetricsId: 'bm_total_only',
        invitedByUserId: 'user_root',
        createdAt,
        updatedAt: createdAt
      });
    });
    const totalOnlyRequests = [];
    const totalOnlyStart = new Date(Date.now() - 4 * 60 * 60_000).toISOString();
    const totalOnlyStop = new Date(Date.now() - 60 * 60_000).toISOString();
    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      if (!href.startsWith('https://api.battlemetrics.com')) {
        return originalFetch(url, options);
      }
      totalOnlyRequests.push(href);
      if (href.includes('/players/bm_total_only/servers/36933209')) {
        return new Response(JSON.stringify({ errors: [{ title: 'That player has not played on that server.' }] }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      if (href.includes('/players/bm_total_only/relationships/sessions')) {
        return new Response(JSON.stringify({
          data: [
            { type: 'session', id: 'total_only_session', attributes: { start: totalOnlyStart, stop: totalOnlyStop, name: 'BM Total Only', firstTime: false } }
          ],
          links: {}
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ errors: [{ title: 'unexpected url' }] }), { status: 404, headers: { 'content-type': 'application/json' } });
    };
    try {
      result = await request('/settings/battlemetrics/sync-playtime', {
        method: 'POST',
        ip: '10.10.0.66',
        body: { memberIds: ['member_bm_total_only'] }
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.requested, 1);
      assert.equal(result.payload.updated, 0);
      assert.equal(result.payload.failed, 1);
      assert.equal(totalOnlyRequests.some((href) => href.includes('/players/bm_total_only/servers/36933209')), true);
      assert.equal(totalOnlyRequests.some((href) => href.includes('/players/bm_total_only/relationships/sessions')), true);
      assert.equal(totalOnlyRequests.some((href) => href.endsWith('/players/match')), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
    const totalOnlyStore = await readStore();
    const totalOnlyFailure = totalOnlyStore.syncState?.battlemetrics?.details?.failedItems?.find((item) => item.memberId === 'member_bm_total_only');
    assert.equal(totalOnlyFailure?.message, '已保存 BM ID，但当前服务器未找到该玩家记录');
    result = await request('/members/member_bm_total_only/profile');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.member.profileStats.battlemetrics.serverPlayTimeMinutes, 0);
    assert.equal(result.payload.member.profileStats.battlemetrics.totalPlayTimeMinutes, 180);

    const onlineOnlySteamId = '76561198000000123';
    await updateStore((store) => {
      const createdAt = nowIso();
      store.members.push({
        id: 'member_bm_online_only',
        steamId: onlineOnlySteamId,
        rawInput: onlineOnlySteamId,
        customName: 'BM Online Only',
        steamNickname: 'BMOnlineOnly',
        avatar: '',
        discordId: '',
        wechatId: '',
        notes: '',
        specialty: [],
        invitedByUserId: 'user_root',
        createdAt,
        updatedAt: createdAt
      });
      store.wipeParticipants.push({
        id: 'participant_bm_online_only',
        wipeId,
        memberId: 'member_bm_online_only',
        status: 'on_time',
        squadId: 'squad_test_1',
        note: '',
        source: 'test',
        createdAt,
        updatedAt: createdAt
      });
    });
    const onlineOnlyRequests = [];
    const onlineOnlyStart = new Date(Date.now() - 80 * 60_000).toISOString();
    const onlineOnlyStop = new Date(Date.now() - 5 * 60_000).toISOString();
    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      if (!href.startsWith('https://api.battlemetrics.com')) {
        return originalFetch(url, options);
      }
      onlineOnlyRequests.push(href);
      if (href.endsWith('/players/match')) {
        return new Response(JSON.stringify({
          data: [{ type: 'player', id: 'bm_online_only', attributes: { name: 'BM Online Only' } }]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (href.includes('/players/bm_online_only/servers/36933209')) {
        return new Response(JSON.stringify({
          data: {
            type: 'playerServer',
            id: 'bm_online_only-36933209',
            attributes: {
              firstSeen: onlineOnlyStart,
              lastSeen: onlineOnlyStop,
              timePlayed: 4500,
              online: false
            }
          }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (href.includes('/players/bm_online_only/relationships/sessions')) {
        return new Response(JSON.stringify({
          data: [
            { type: 'session', id: 'online_only_session', attributes: { start: onlineOnlyStart, stop: onlineOnlyStop, name: 'BM Online Only', firstTime: false } }
          ],
          links: {}
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ errors: [{ title: 'unexpected url' }] }), { status: 404, headers: { 'content-type': 'application/json' } });
    };
    try {
      result = await request('/settings/battlemetrics/sync-playtime', {
        method: 'POST',
        ip: '10.10.0.26',
        body: { memberIds: ['member_bm_online_only'] }
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.updated, 1);
      assert.equal(onlineOnlyRequests.some((href) => href.includes('/relationships/sessions')), true);
      const onlineOnlyStore = await readStore();
      const onlineOnlyRow = onlineOnlyStore.kdaRows.find((row) => row.wipeId === wipeId && row.memberId === 'member_bm_online_only');
      assert.equal(Boolean(onlineOnlyRow), true);
      assert.equal(onlineOnlyRow.source, 'battlemetrics_online');
      assert.equal(onlineOnlyRow.onlineTimeMinutes, 75);
      assert.equal(onlineOnlyRow.onlineSummary.battlemetricsPlayerId, 'bm_online_only');
      assert.equal(onlineOnlyStore.kdaSnapshots.some((row) => row.memberId === 'member_bm_online_only' && row.onlineTimeMinutes === 75), true);
    } finally {
      globalThis.fetch = originalFetch;
    }

    result = await request('/sync-status?kind=battlemetrics');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.syncState.battlemetrics.status, 'complete');
    assert.equal(result.payload.syncState.battlemetrics.completed, 1);
    result = await request('/sync/jobs/recent?limit=5');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.recent.some((job) => job.type === 'battlemetrics_playtime' && job.status === 'completed'), true);

    await updateStore((store) => {
      for (const member of store.members) {
        if (member.id === 'member_test_1' || member.id === 'member_test_2') member.battlemetricsId = '';
      }
      store.memberProfiles = (store.memberProfiles || []).filter((profile) => !['member_test_1', 'member_test_2'].includes(profile.memberId));
    });

    const bulkMatchRequests = [];
    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      if (!href.startsWith('https://api.battlemetrics.com')) {
        return originalFetch(url, options);
      }
      bulkMatchRequests.push({ href, body: options.body ? JSON.parse(options.body) : null });
      if (href.endsWith('/players/match')) {
        return new Response(JSON.stringify({
          data: [
            {
              type: 'identifier',
              id: 'identifier_1',
              attributes: { type: 'steamID', identifier: '76561198000000001' },
              relationships: { player: { data: { type: 'player', id: 'bm_player_1' } } }
            },
            {
              type: 'identifier',
              id: 'identifier_2',
              attributes: { type: 'steamID', identifier: '76561198000000004' },
              relationships: { player: { data: { type: 'player', id: 'bm_player_2' } } }
            }
          ],
          included: [
            { type: 'player', id: 'bm_player_1', attributes: { name: 'AlphaBM' } },
            { type: 'player', id: 'bm_player_2', attributes: { name: 'BravoBM' } }
          ]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (href.includes('/players/bm_player_1/servers/36933209')) {
        return new Response(JSON.stringify({
          data: {
            type: 'playerServer',
            id: 'bm_player_1-36933209',
            attributes: {
              firstSeen: startedAt,
              lastSeen: sessionStop,
              timePlayed: 7200,
              online: false
            }
          }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (href.includes('/players/bm_player_2/servers/36933209')) {
        return new Response(JSON.stringify({
          data: {
            type: 'playerServer',
            id: 'bm_player_2-36933209',
            attributes: {
              firstSeen: startedAt,
              lastSeen: sessionStop,
              timePlayed: 5400,
              online: false
            }
          }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (href.includes('/players/bm_player_1/relationships/sessions')) {
        return new Response(JSON.stringify({
          data: [
            { type: 'session', id: 'bulk_session_1', attributes: { start: sessionStart, stop: sessionStop, name: 'AlphaBM', firstTime: false } },
            { type: 'session', id: 'bulk_session_1_older', attributes: { start: olderStart, stop: olderStop, name: 'AlphaBM', firstTime: false } }
          ],
          links: {}
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (href.includes('/players/bm_player_2/relationships/sessions')) {
        return new Response(JSON.stringify({
          data: [
            { type: 'session', id: 'bulk_session_2', attributes: { start: sessionStart, stop: sessionStop, name: 'BravoBM', firstTime: false } },
            { type: 'session', id: 'bulk_session_2_older', attributes: { start: olderStart, stop: olderStop, name: 'BravoBM', firstTime: false } }
          ],
          links: {}
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ errors: [{ title: 'unexpected url' }] }), { status: 404, headers: { 'content-type': 'application/json' } });
    };
    try {
      result = await request('/settings/battlemetrics/sync-playtime', {
        method: 'POST',
        ip: '10.10.0.12',
        body: { memberIds: ['member_test_1', 'member_test_2'] }
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.updated, 2);
      assert.equal(typeof result.payload.battlemetricsQueue.pendingCount, 'number');
      assert.equal(typeof result.payload.battlemetricsQueue.totals.completed, 'number');
      const matchRequests = bulkMatchRequests.filter((item) => item.href.endsWith('/players/match'));
      assert.equal(matchRequests.length, 1);
      assert.equal(matchRequests[0].body.data.length, 2);
      assert.deepEqual(matchRequests[0].body.data.map((item) => item.attributes.identifier), ['76561198000000001', '76561198000000004']);
      assert.equal(bulkMatchRequests.filter((item) => item.href.includes('/servers/36933209')).length, 2);
      assert.equal(bulkMatchRequests.filter((item) => item.href.includes('/relationships/sessions')).length, 4);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const allMemberSyncRequests = [];
    const allMemberSnapshot = await readStore();
    const allMemberProfiles = new Map((allMemberSnapshot.memberProfiles || []).map((profile) => [profile.memberId, profile]));
    const expectedManualTargets = allMemberSnapshot.members.filter((member) => member.steamId);
    const expectedMissingSteamIds = expectedManualTargets
      .filter((member) => !member.battlemetricsId && !allMemberProfiles.get(member.id)?.battlemetricsPlayerId)
      .map((member) => member.steamId)
      .sort();
    const allMemberPlayerIds = new Map([
      ['76561198000000001', 'bm_player_1'],
      ['76561198000000004', 'bm_player_2'],
      ['76561198000000005', 'bm_player_3'],
      ['76561198000000008', 'bm_player_4']
    ]);
    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      if (!href.startsWith('https://api.battlemetrics.com')) {
        return originalFetch(url, options);
      }
      allMemberSyncRequests.push({ href, body: options.body ? JSON.parse(options.body) : null });
      if (href.endsWith('/players/match')) {
        const identifiers = JSON.parse(options.body || '{}').data || [];
        return new Response(JSON.stringify({
          data: identifiers.map((item, index) => {
            const steamId = item.attributes?.identifier || '';
            return {
              type: 'identifier',
              id: `all_member_identifier_${index}`,
              attributes: { type: 'steamID', identifier: steamId },
              relationships: { player: { data: { type: 'player', id: allMemberPlayerIds.get(steamId) || `bm_missing_${steamId}` } } }
            };
          })
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const serverMatch = href.match(/\/players\/([^/]+)\/servers\/36933209/);
      if (serverMatch) {
        return new Response(JSON.stringify({
          data: {
            type: 'playerServer',
            id: `${serverMatch[1]}-36933209`,
            attributes: {
              firstSeen: startedAt,
              lastSeen: sessionStop,
              timePlayed: 2700,
              online: false
            }
          }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const sessionsMatch = href.match(/\/players\/([^/]+)\/relationships\/sessions/);
      if (sessionsMatch) {
        const playerId = sessionsMatch[1];
        return new Response(JSON.stringify({
          data: [
            { type: 'session', id: `${playerId}_session`, attributes: { start: sessionStart, stop: sessionStop, name: playerId, firstTime: false } },
            { type: 'session', id: `${playerId}_older_session`, attributes: { start: olderStart, stop: olderStop, name: playerId, firstTime: false } }
          ],
          links: {}
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ errors: [{ title: 'unexpected url' }] }), { status: 404, headers: { 'content-type': 'application/json' } });
    };
    try {
      result = await request('/settings/battlemetrics/sync-playtime', {
        method: 'POST',
        ip: '10.10.0.16',
        body: {}
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.requested, expectedManualTargets.length);
      assert.equal(result.payload.updated, expectedManualTargets.length);
      assert.equal(result.payload.failed, 0);
      const matchRequests = allMemberSyncRequests.filter((item) => item.href.endsWith('/players/match'));
      assert.equal(matchRequests.length, expectedMissingSteamIds.length ? 1 : 0);
      if (expectedMissingSteamIds.length) {
        assert.deepEqual(
          matchRequests[0].body.data.map((item) => item.attributes.identifier).sort(),
          expectedMissingSteamIds
        );
      }
      assert.equal(allMemberSyncRequests.filter((item) => item.href.includes('/relationships/sessions')).length, expectedManualTargets.length * 2);
      assert.equal(allMemberSyncRequests.filter((item) => item.href.includes('/servers/36933209')).length, expectedManualTargets.length);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const cachedIdentitySteamId = '76561198000006666';
    await updateStore((store) => {
      const createdAt = nowIso();
      store.members = (store.members || []).filter((member) => member.id !== 'member_bm_cached_identity');
      store.memberProfiles = (store.memberProfiles || []).filter((profile) => profile.memberId !== 'member_bm_cached_identity');
      store.members.push({
        id: 'member_bm_cached_identity',
        steamId: cachedIdentitySteamId,
        rawInput: cachedIdentitySteamId,
        customName: 'Cached BM Identity',
        steamNickname: '',
        avatar: '',
        discordId: '',
        wechatId: '',
        notes: '',
        specialty: [],
        battlemetricsId: '',
        createdAt,
        updatedAt: createdAt
      });
      store.memberProfiles.push({
        id: 'profile_bm_cached_identity',
        memberId: 'member_bm_cached_identity',
        steamId: cachedIdentitySteamId,
        profileUrl: `https://steamcommunity.com/profiles/${cachedIdentitySteamId}`,
        battlemetricsPlayerId: 'bm_cached_identity',
        battlemetricsMatchConfidence: 'steam-match',
        fetchedAt: createdAt,
        source: 'battlemetrics'
      });
    });
    const cachedIdentityRequests = [];
    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      if (!href.startsWith('https://api.battlemetrics.com')) {
        return originalFetch(url, options);
      }
      cachedIdentityRequests.push(href);
      return new Response(JSON.stringify({ errors: [{ title: 'unexpected cached identity sync request' }] }), { status: 500, headers: { 'content-type': 'application/json' } });
    };
    try {
      result = await request('/sync/jobs/battlemetrics-id', {
        method: 'POST',
        ip: '10.10.0.18',
        body: { memberIds: ['member_bm_cached_identity'] }
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.job.status, 'completed');
      assert.equal(result.payload.job.totalCount, 0);
      assert.equal(cachedIdentityRequests.length, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const reviewCandidateSteamId = '76561198000006667';
    await updateStore((store) => {
      const createdAt = nowIso();
      store.members = (store.members || []).filter((member) => member.id !== 'member_bm_review_candidate');
      store.memberProfiles = (store.memberProfiles || []).filter((profile) => profile.memberId !== 'member_bm_review_candidate');
      store.members.push({
        id: 'member_bm_review_candidate',
        steamId: reviewCandidateSteamId,
        rawInput: reviewCandidateSteamId,
        customName: 'Review Candidate',
        steamNickname: '',
        avatar: '',
        discordId: '',
        wechatId: '',
        notes: '',
        specialty: [],
        createdAt,
        updatedAt: createdAt
      });
    });

    const reviewCandidateRequests = [];
    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      if (!href.startsWith('https://api.battlemetrics.com')) {
        return originalFetch(url, options);
      }
      reviewCandidateRequests.push(href);
      if (href.endsWith('/players/match')) {
        return new Response(JSON.stringify({ data: [], included: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const parsed = new URL(href);
      if (
        parsed.pathname === '/players' &&
        parsed.searchParams.get('filter[search]') === 'Review Candidate' &&
        parsed.searchParams.get('filter[servers]') === '36933209'
      ) {
        return new Response(JSON.stringify({
          data: [
            { type: 'player', id: 'bm_review_candidate', attributes: { name: 'Review Candidate Alt' } }
          ]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (href.includes('/players/bm_review_candidate/servers/36933209')) {
        return new Response(JSON.stringify({
          data: {
            type: 'playerServer',
            id: 'bm_review_candidate-36933209',
            attributes: {
              firstSeen: startedAt,
              lastSeen: sessionStop,
              timePlayed: 1800,
              online: false
            }
          }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ errors: [{ title: 'unexpected review candidate url' }] }), { status: 404, headers: { 'content-type': 'application/json' } });
    };
    try {
      result = await request('/sync/jobs/battlemetrics-id', {
        method: 'POST',
        ip: '10.10.0.17',
        body: { memberIds: ['member_bm_review_candidate'] }
      });
      assert.equal(result.response.status, 200);
      const reviewJobId = result.payload.job.id;
      const reviewJob = await waitForStoreCondition((store) => {
        const job = (store.syncJobs || []).find((item) => item.id === reviewJobId);
        return job && job.status === 'failed' ? job : null;
      }, { label: 'battlemetrics review candidate job' });
      const reviewItem = reviewJob.details.failedItems.find((item) => item.memberId === 'member_bm_review_candidate');
      assert.equal(reviewItem.message, 'BattleMetrics 昵称搜索仅找到待人工复核候选');
      assert.equal(reviewItem.battlemetricsCandidates.length, 1);
      assert.equal(reviewItem.battlemetricsCandidates[0].battlemetricsId, 'bm_review_candidate');
      assert.equal(reviewItem.battlemetricsCandidates[0].displayName, 'Review Candidate Alt');
      assert.equal(reviewItem.battlemetricsCandidates[0].alias, 'Review Candidate');
      assert.equal(reviewItem.battlemetricsCandidates[0].serverTimePlayedSeconds, 1800);
      assert.equal(reviewCandidateRequests.some((href) => href.includes('/players?') && href.includes('filter%5Bsearch%5D=Review+Candidate')), true);
    } finally {
      globalThis.fetch = originalFetch;
    }

    result = await request('/members/member_test_1/profile');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.member.serverOnline.onlineTimeMinutes, 135);
    assert.equal(result.payload.member.serverOnline.lastOnlineAt, sessionStart);
    assert.equal(result.payload.member.onlineSummary.weeklyPlayTimeMinutes, 135);
    assert.equal(result.payload.member.profileStats.battlemetrics.weeklyPlayTimeMinutes, 135);

    await updateStore((store) => {
      const member = store.members.find((item) => item.id === 'member_test_2');
      if (member) member.battlemetricsId = '';
      store.memberProfiles = (store.memberProfiles || []).filter((profile) => profile.memberId !== 'member_test_2');
    });

    const aliasMatchRequests = [];
    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      if (!href.startsWith('https://api.battlemetrics.com')) {
        return originalFetch(url, options);
      }
      aliasMatchRequests.push({ href, body: options.body ? JSON.parse(options.body) : null });
      if (href.endsWith('/players/match')) {
        return new Response(JSON.stringify({ data: [], included: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const parsed = new URL(href);
      if (parsed.pathname === '/players' && parsed.searchParams.get('filter[search]') === 'Bravo' && parsed.searchParams.get('filter[servers]') === '36933209') {
        return new Response(JSON.stringify({
          data: [
            { type: 'player', id: 'bm_alias_bravo', attributes: { name: 'Bravo' } }
          ]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (href.includes('/players/bm_alias_bravo/servers/36933209')) {
        return new Response(JSON.stringify({
          data: {
            type: 'playerServer',
            id: 'bm_alias_bravo-36933209',
            attributes: {
              firstSeen: startedAt,
              lastSeen: sessionStop,
              timePlayed: 3600,
              online: false
            }
          }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (href.includes('/players/bm_alias_bravo/relationships/sessions')) {
        return new Response(JSON.stringify({
          data: [
            { type: 'session', id: 'alias_session_1', attributes: { start: sessionStart, stop: sessionStop, name: 'Bravo', firstTime: false } }
          ],
          links: {}
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ errors: [{ title: 'unexpected url' }] }), { status: 404, headers: { 'content-type': 'application/json' } });
    };
    try {
      result = await request('/settings/battlemetrics/sync-playtime', {
        method: 'POST',
        ip: '10.10.0.13',
        body: { memberIds: ['member_test_2'] }
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.updated, 1);
      assert.equal(result.payload.failed, 0);
      assert.equal(aliasMatchRequests.some((item) => item.href.endsWith('/players/match')), true);
      assert.equal(aliasMatchRequests.some((item) => item.href.includes('/players?') && item.href.includes('filter%5Bsearch%5D=Bravo')), true);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const aliasStore = await readStore();
    const aliasMember = aliasStore.members.find((member) => member.id === 'member_test_2');
    const aliasProfile = aliasStore.memberProfiles.find((profile) => profile.memberId === 'member_test_2');
    assert.equal(aliasMember.battlemetricsId, 'bm_alias_bravo');
    assert.equal(aliasProfile.battlemetricsMatchConfidence, 'exact-active-name');
    assert.equal(aliasProfile.battlemetricsMatchAlias, 'Bravo');

    await updateStore((store) => {
      const member = store.members.find((item) => item.id === 'member_test_2');
      if (member) member.battlemetricsId = '';
      store.memberProfiles = (store.memberProfiles || []).filter((profile) => profile.memberId !== 'member_test_2');
    });

    const partialFailureRequests = [];
    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      if (!href.startsWith('https://api.battlemetrics.com')) {
        return originalFetch(url, options);
      }
      partialFailureRequests.push(href);
      if (href.endsWith('/players/match')) {
        return new Response(JSON.stringify({ data: [], included: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const parsed = new URL(href);
      if (parsed.pathname === '/players') {
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (href.includes('/players/bm_player_1/servers/36933209')) {
        return new Response(JSON.stringify({
          data: {
            type: 'playerServer',
            id: 'bm_player_1-36933209',
            attributes: {
              firstSeen: startedAt,
              lastSeen: sessionStop,
              timePlayed: 7200,
              online: false
            }
          }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (href.includes('/players/bm_player_1/relationships/sessions')) {
        return new Response(JSON.stringify({
          data: [
            { type: 'session', id: 'partial_session_1', attributes: { start: sessionStart, stop: sessionStop, name: 'AlphaBM', firstTime: false } },
            { type: 'session', id: 'partial_session_2', attributes: { start: olderStart, stop: olderStop, name: 'AlphaBM', firstTime: false } }
          ],
          links: {}
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ errors: [{ title: 'unexpected url' }] }), { status: 404, headers: { 'content-type': 'application/json' } });
    };
    try {
      result = await request('/settings/battlemetrics/sync-playtime', {
        method: 'POST',
        ip: '10.10.0.14',
        body: { memberIds: ['member_test_1', 'member_test_2'] }
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.updated, 1);
      assert.equal(result.payload.failed, 1);
      assert.equal(result.payload.completed, 2);
      assert.equal(result.payload.status, 'complete');
      assert.equal(result.payload.error, '');
      assert.equal(partialFailureRequests.some((href) => href.includes('/players?') && href.includes('filter%5Bsearch%5D=Bravo')), true);
    } finally {
      globalThis.fetch = originalFetch;
    }

    result = await request('/sync-status?kind=battlemetrics');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.syncState.battlemetrics.status, 'complete');
    assert.equal(result.payload.syncState.battlemetrics.failed, 1);
    assert.equal(result.payload.syncState.battlemetrics.error, '');

    await updateStore((store) => {
      const base = Date.parse(startedAt);
      store.kdaSnapshots.push(
        {
          id: 'snapshot_range_1',
          capturedAt: new Date(base + 60 * 60 * 1000).toISOString(),
          wipeId,
          memberId: 'member_test_1',
          steamId: '76561198000000001',
          kills: 2,
          deaths: 1,
          assists: 0,
          t3Kills: 1,
          rockets: 2,
          sulfur: 2000,
          metalOre: 1000,
          building: 10,
          playTimeMinutes: 60,
          onlineTimeMinutes: 30,
          onlineSummary: {
            battlemetricsPlayerId: 'bm_player_1',
            battlemetricsServerId: '36933209',
            serverPlayTimeSeconds: 30 * 60,
            serverPlayTimeMinutes: 30,
            weeklyPlayTimeSeconds: 30 * 60,
            weeklyPlayTimeMinutes: 30,
            syncedAt: new Date(base + 60 * 60 * 1000).toISOString()
          },
          source: 'manual_import',
          syncedAt: new Date(base + 60 * 60 * 1000).toISOString()
        },
        {
          id: 'snapshot_range_2',
          capturedAt: new Date(base + 2 * 60 * 60 * 1000).toISOString(),
          wipeId,
          memberId: 'member_test_1',
          steamId: '76561198000000001',
          kills: 10,
          deaths: 3,
          assists: 0,
          t3Kills: 3,
          rockets: 12,
          sulfur: 12000,
          metalOre: 8000,
          building: 55,
          playTimeMinutes: 320,
          onlineTimeMinutes: 150,
          onlineSummary: {
            battlemetricsPlayerId: 'bm_player_1',
            battlemetricsServerId: '36933209',
            serverPlayTimeSeconds: 150 * 60,
            serverPlayTimeMinutes: 150,
            weeklyPlayTimeSeconds: 150 * 60,
            weeklyPlayTimeMinutes: 150,
            syncedAt: new Date(base + 2 * 60 * 60 * 1000).toISOString()
          },
          source: 'manual_import',
          syncedAt: new Date(base + 2 * 60 * 60 * 1000).toISOString()
        }
      );
    });

    const rangeStart = encodeURIComponent(new Date(Date.parse(startedAt) + 90 * 60 * 1000).toISOString());
    const rangeEnd = encodeURIComponent(new Date(Date.parse(startedAt) + 150 * 60 * 1000).toISOString());
    result = await request(`/kda?wipeId=${wipeId}&scope=all&sort=kills&order=desc&from=${rangeStart}&to=${rangeEnd}`);
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.rows.length, 1);
    assert.equal(result.payload.rows[0].kills, 8);
    assert.equal(result.payload.rows[0].rockets, 10);
    assert.equal(result.payload.rows[0].onlineTimeMinutes, 120);
    assert.equal(result.payload.rows[0].onlineSummary.serverPlayTimeMinutes, 120);
    assert.equal(result.payload.rows[0].onlineSummary.rangeDelta, true);

    const shortRangeEnd = encodeURIComponent(new Date(Date.parse(startedAt) + 100 * 60 * 1000).toISOString());
    result = await request(`/kda/export?wipeId=${wipeId}&scope=all&from=${rangeStart}&to=${shortRangeEnd}`);
    assert.equal(result.response.status, 400);
    assert.equal(result.payload.error, '时间范围最小 1 小时');

    result = await request(`/kda?wipeId=${wipeId}&scope=all&sort=kda&order=desc`);
    assert.equal(result.response.status, 200);
    assert.equal(Boolean(result.payload.dataFreshness.syncedAt), true);
    const alphaKdaRow = result.payload.rows.find((row) => row.memberId === 'member_test_1');
    assert.equal(alphaKdaRow.kills, 10);
    assert.equal(alphaKdaRow.t3Kills, 3);
    assert.equal(alphaKdaRow.rockets, 12);
    assert.equal(alphaKdaRow.onlineTimeMinutes, 135);
    assert.equal(alphaKdaRow.onlineSummary.lastOnlineAt, sessionStart);
    assert.equal(Object.hasOwn(result.payload.rows[0], 'kd'), false);

    result = await request(`/kda?wipeId=${wipeId}&scope=all&q=Alpha&sort=kda&order=desc`);
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.rows.some((row) => row.memberId === 'member_test_1'), true);
    assert.equal(result.payload.rows.every((row) => [
      row.displayName,
      row.customName,
      row.steamNickname,
      row.member?.displayName,
      row.member?.customName,
      row.member?.steamNickname,
      row.steamId,
      row.squadName
    ].some((value) => String(value || '').toLowerCase().includes('alpha'))), true);

    result = await request(`/kda?wipeId=${wipeId}&scope=squad&squadIds=squad_test_2&sort=kda&order=desc`);
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.rows.some((row) => row.steamId === '76561198000000004'), true);
    assert.equal(result.payload.rows.every((row) => row.squadName === 'Bravo Squad'), true);

    const exportDateToken = startedAt.slice(5, 10);
    result = await request(`/kda/export?wipeId=${wipeId}&scope=all&language=en`);
    assert.equal(result.response.status, 200);
    assert.match(result.response.headers.get('content-type') || '', /text\/html/);
    assert.match(result.response.headers.get('content-disposition') || '', new RegExp(`filename="NB-Vital-Workflow-${exportDateToken}-Kills-ranking\\.html"`));
    assert.match(result.response.headers.get('content-disposition') || '', new RegExp(`filename\\*=UTF-8''NB-Vital-Workflow-${exportDateToken}%20-%20Kills%20ranking\\.html`));
    assert.equal(result.response.headers.get('x-nb-download-filename'), `NB-Vital-Workflow-${exportDateToken}-Kills-ranking.html`);
    assert.match(result.text, /class="cover"/);
    assert.match(result.text, /class="leaderboard"/);
    assert.match(result.text, /class="leaderboard-table"/);
    assert.match(result.text, /break-inside: avoid/);
    assert.match(result.text, /@page \{ size: A4 landscape; margin: 12mm; \}/);
    assert.match(result.text, /class="avatar"/);
    assert.match(result.text, /#01/);
    assert.match(result.text, /T3 Kills/);
    assert.match(result.text, /Rockets/);
    assert.match(result.text, /Online time/);
    assert.match(result.text, /2\.3 h/);
    assert.match(result.text, /1\.2w/);
    assert.match(result.text, /8,000/);
    assert.match(result.text, /Data time/);
    assert.match(result.text, /Clan Portal · Kills leaderboard/);
    assert.match(result.text, /class="ranking-page"/);
    assert.match(result.text, /class="rank-gold"/);
    assert.match(result.text, /class="medal medal-gold"/);
    assert.match(result.text, /<th>#<\/th><th>Name<\/th><th>Team<\/th><th>Online time<\/th><th class="leaderboard-primary-stat">Kills<\/th><th>T3 Kills<\/th><th>Deaths<\/th><th>KDA<\/th><th>RPG<\/th>/);
    assert.doesNotMatch(result.text, /ranking-subtitle/);

    result = await request(`/kda/export?wipeId=${wipeId}&scope=all&language=zh`);
    assert.equal(result.response.status, 200);
    assert.match(result.response.headers.get('content-disposition') || '', new RegExp(`filename="NB-Vital-Workflow-${exportDateToken}-Kills-ranking\\.html"`));
    assert.match(result.response.headers.get('content-disposition') || '', new RegExp(`filename\\*=UTF-8''NB-Vital-Workflow-${exportDateToken}%20-%20%E5%87%BB%E6%9D%80%E6%8E%92%E8%A1%8C\\.html`));
    assert.equal(result.response.headers.get('x-nb-download-filename'), `NB-Vital-Workflow-${exportDateToken}-Kills-ranking.html`);
    assert.doesNotMatch(result.text, />320<\/td>/);
    assert.doesNotMatch(result.text, />KD</);
    assert.doesNotMatch(result.text, /KDA data/);
    assert.doesNotMatch(result.text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    assert.doesNotMatch(result.text, /\bVT\b/);
    assert.match(result.text, /Alpha/);
    assert.match(result.text, /Bravo/);

    result = await request(`/kda/export?wipeId=${wipeId}&scope=all&language=en&ranking=online_minutes`);
    assert.equal(result.response.status, 200);
    assert.match(result.response.headers.get('content-type') || '', /text\/html/);
    assert.match(result.text, /Clan Portal · Online time leaderboard/);
    assert.match(result.text, /<th>#<\/th><th>Name<\/th><th>Team<\/th><th class="leaderboard-primary-stat">Online time<\/th><th>Kills<\/th><th>T3 Kills<\/th><th>Deaths<\/th><th>KDA<\/th><th>RPG<\/th>/);
    assert.doesNotMatch(result.text, /<th>Online time<\/th><th class="leaderboard-primary-stat">Online time<\/th>/);
    assert.match(result.text, /2\.3 h/);

    result = await request(`/kda/export?wipeId=${wipeId}&scope=squad&squadIds=squad_test_2&language=en`);
    assert.equal(result.response.status, 200);
    assert.match(result.text, /Bravo/);
    assert.match(result.text, /Bravo Squad/);
    assert.doesNotMatch(result.text, /Alpha/);

    result = await request(`/kda/export?wipeId=${wipeId}&scope=squad&squadIds=squad_test_1,squad_test_2&language=en`);
    assert.equal(result.response.status, 200);
    assert.match(result.text, /Alpha/);
    assert.match(result.text, /Bravo/);

    result = await request(`/wipes/${wipeId}/close`, { method: 'POST' });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.wipe.status, 'closed');
    const closedAt = result.payload.wipe.closedAt;
    autoTargets = battlemetricsAutoSyncTargets(await readStore());
    assert.equal(autoTargets.wipe, null);
    assert.deepEqual(autoTargets.targets, []);
    kdaTargets = kdaAutoSyncTargets(await readStore());
    assert.equal(kdaTargets.wipe, null);
    assert.deepEqual(kdaTargets.participants, []);

    const closedHistoryRootCookie = cookie;
    cookie = '';
    result = await request('/auth/login', { method: 'POST', body: { username: 'web_member', password: 'MemberPass123!' } });
    assert.equal(result.response.status, 200);
    result = await request('/wipes');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.wipes.some((wipe) => wipe.id === wipeId), true);
    result = await request(`/wipes/${wipeId}?scope=all&sort=kda&order=desc`);
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.participants.length, 4);
    assert.equal(result.payload.rows.some((row) => row.memberId === 'member_test_2'), true);
    assert.equal(result.payload.rows.some((row) => row.memberId === 'member_test_4'), true);
    assert.equal(result.payload.rows.some((row) => row.memberId === 'member_bm_online_only'), true);
    assert.equal(result.payload.settlement.kdaMemberScope, 'all_members');
    result = await request(`/kda?wipeId=${wipeId}&scope=all&sort=kda&order=desc`);
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.rows.some((row) => row.memberId === 'member_test_2'), true);
    assert.equal(result.payload.rows.some((row) => row.memberId === 'member_test_4'), true);
    cookie = '';
    result = await request('/auth/login', { method: 'POST', body: { username: 'readonly_viewer', password: 'ViewerPass123!' } });
    assert.equal(result.response.status, 200);
    result = await request('/wipes');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.wipes.some((wipe) => wipe.id === wipeId), true);
    result = await request(`/kda?wipeId=${wipeId}&scope=all&sort=kda&order=desc`);
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.wipe.id, wipeId);
    assert.equal(result.payload.rows.some((row) => row.memberId === 'member_test_1'), true);
    result = await request(`/wipes/${wipeId}?scope=all&sort=kda&order=desc`);
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.wipe.id, wipeId);
    assert.equal(result.payload.rows.some((row) => row.memberId === 'member_test_2'), true);
    cookie = closedHistoryRootCookie;

    result = await request('/squads/squad_test_1/members');
    assert.equal(result.response.status, 200);
    const lastPlayedMember = result.payload.members.find((member) => member.id === 'member_test_1');
    assert.equal(lastPlayedMember.playStatus, 'last_played');
    assert.equal(lastPlayedMember.isPlayingCurrentWipe, false);
    assert.equal(lastPlayedMember.lastPlayedAt, closedAt);

    const futureStartedAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    await updateStore((store) => {
      store.wipes.unshift({
        id: 'wipe_future_planned',
        name: 'Vital Rust 2X EU Medium 2026-06-18',
        status: 'active',
        serverName: 'Vital Rust 2X EU Medium',
        startedAt: futureStartedAt,
        closedAt: '',
        wipeLabel: 'Next',
        wipeMode: 'next',
        nextWipeAt: '',
        directConnect: '',
        vipUrl: '',
        mapLink: '',
        notes: '',
        vitalServerId: '19',
        vitalWipeId: 'future-wipe',
        battlemetricsId: '32032048',
        kdaUrl: '',
        createdBy: 'user_root',
        createdAt: futureStartedAt,
        updatedAt: futureStartedAt
      });
      store.wipeParticipants.push({
        id: 'participant_future_alpha',
        wipeId: 'wipe_future_planned',
        memberId: 'member_test_1',
        squadId: 'squad_test_1',
        status: 'on_time',
        addedByUserId: 'user_root',
        createdAt: futureStartedAt,
        updatedAt: futureStartedAt
      });
      store.kdaRows.push({
        id: 'kda_future_different_server_alpha',
        wipeId: 'wipe_future_planned',
        memberId: 'member_test_1',
        steamId: '76561198000000001',
        kills: 1,
        deaths: 0,
        onlineTimeMinutes: 0,
        source: 'manual_import',
        syncedAt: futureStartedAt
      });
      const alphaProfile = store.memberProfiles.find((profile) => profile.memberId === 'member_test_1');
      if (alphaProfile) {
        Object.assign(alphaProfile, {
          battlemetricsPlayerId: alphaProfile.battlemetricsPlayerId || 'bm_player_1',
          battlemetricsServerId: '32032048',
          battlemetricsServerName: 'Vital Rust 2X EU Medium',
          battlemetricsWipeId: 'wipe_future_planned',
          battlemetricsWipeName: 'Vital Rust 2X EU Medium 2026-06-18',
          battlemetricsWipeStatus: 'planned',
          battlemetricsLastOnlineAt: '2026-06-18T09:29:00.000Z',
          battlemetricsLastOfflineAt: '',
          battlemetricsServerPlayTimeSeconds: 210 * 60,
          battlemetricsWeeklyPlayTimeSeconds: 210 * 60,
          battlemetricsSyncedAt: '2026-06-18T09:30:00.000Z',
          battlemetricsMatchConfidence: 'rustplus_relay_bmid',
          battlemetricsMatchNotes: 'Rust+ relay online fallback by BMID'
        });
      }
    });

    result = await request('/wipes/current');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.wipe.status, 'planned');
    assert.equal(result.payload.wipe.rawStatus, 'active');
    autoTargets = battlemetricsAutoSyncTargets(await readStore());
    assert.equal(autoTargets.wipe, null);
    assert.deepEqual(autoTargets.targets, []);
    kdaTargets = kdaAutoSyncTargets(await readStore());
    assert.equal(kdaTargets.wipe, null);
    assert.deepEqual(kdaTargets.participants, []);

    result = await request('/kda?wipeId=wipe_future_planned&scope=all&sort=kills&order=desc');
    assert.equal(result.response.status, 200);
    const futureKdaRow = result.payload.rows.find((row) => row.id === 'kda_future_different_server_alpha');
    assert.equal(futureKdaRow.onlineTimeMinutes, 0);
    assert.equal(futureKdaRow.onlineSummary.battlemetricsServerId || '', '');

    result = await request('/query', { method: 'POST', ip: '10.10.0.4', body: { steamInput: '76561198000000001' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.member.currentWipe.wipeId, 'wipe_future_planned');
    assert.equal(result.payload.member.currentWipe.wipeStatus, 'planned');
    assert.equal(result.payload.member.currentWipe.isRegistered, true);
    assert.equal(result.payload.member.currentWipe.status, 'on_time');
    assert.equal(result.payload.member.currentKda.wipeId, wipeId);
    assert.equal(result.payload.member.serverOnline.wipeId, 'wipe_future_planned');
    assert.equal(result.payload.member.serverOnline.wipeStatus, 'planned');
    assert.equal(result.payload.member.serverOnline.battlemetricsServerId, '32032048');
    assert.equal(result.payload.member.serverOnline.onlineTimeMinutes, 0);
    assert.equal(result.payload.member.serverOnline.lastOnlineAt, '');
    assert.equal(result.payload.member.recentHistoryServerOnline.wipeId, wipeId);
    assert.equal(result.payload.member.recentHistoryServerOnline.onlineTimeMinutes, 135);
    assert.equal(result.payload.member.recentHistoryServerOnline.lastOnlineAt, sessionStart);
    assert.equal(result.payload.member.recentHistoryServerOnline.lastOfflineAt, sessionStop);

    result = await request('/members');
    assert.equal(result.response.status, 200);
    const plannedListMember = result.payload.members.find((member) => member.id === 'member_test_1');
    assert.equal(plannedListMember.onlineSummary.wipeId, wipeId);
    assert.equal(plannedListMember.onlineSummary.wipeStatus, 'closed');
    assert.equal(plannedListMember.onlineSummary.serverPlayTimeMinutes, 135);
    assert.equal(plannedListMember.onlineSummary.lastOnlineAt, sessionStart);

    const fallbackBattlemetricsRequests = [];
    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      if (!href.startsWith('https://api.battlemetrics.com')) {
        return originalFetch(url, options);
      }
      fallbackBattlemetricsRequests.push(href);
      if (href.includes('/players/bm_player_1/servers/36933209')) {
        return new Response(JSON.stringify({
          data: {
            type: 'playerServer',
            id: 'bm_player_1-36933209',
            attributes: {
              firstSeen: startedAt,
              lastSeen: sessionStop,
              timePlayed: 7200,
              online: false
            }
          }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (href.includes('/players/bm_player_1/relationships/sessions')) {
        return new Response(JSON.stringify({
          data: [
            { type: 'session', id: 'session_1', attributes: { start: sessionStart, stop: sessionStop, name: 'AlphaBM', firstTime: false } },
            { type: 'session', id: 'session_2', attributes: { start: olderStart, stop: olderStop, name: 'AlphaBM', firstTime: false } }
          ],
          links: {}
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ errors: [{ title: 'unexpected url' }] }), { status: 404, headers: { 'content-type': 'application/json' } });
    };
    try {
      result = await request('/settings/battlemetrics/sync-playtime', {
        method: 'POST',
        ip: '10.10.0.7',
        body: { memberIds: ['member_test_1'] }
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.serverId, '36933209');
      assert.equal(result.payload.serverName, 'Vital Rust Workflow Server');
      assert.equal(result.payload.wipeId, wipeId);
      assert.equal(result.payload.wipeName, 'Vital Rust Workflow Wipe');
      assert.equal(result.payload.wipeStatus, 'closed');
      assert.equal(fallbackBattlemetricsRequests.some((href) => href.includes('36933209')), true);
      assert.equal(fallbackBattlemetricsRequests.some((href) => href.includes('32032048')), false);
      assert.equal(fallbackBattlemetricsRequests.some((href) => href.endsWith('/players/match')), false);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const publicBattlemetricsRequests = [];
    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      if (href.startsWith('https://api.battlemetrics.com')) publicBattlemetricsRequests.push(href);
      return originalFetch(url, options);
    };
    try {
      cookie = '';
      result = await request('/query', { method: 'POST', ip: '10.10.0.5', body: { steamInput: '76561198000000001' } });
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.member.currentWipe.wipeId, 'wipe_future_planned');
      assert.equal(result.payload.member.currentWipe.wipeStatus, 'planned');
      assert.equal(result.payload.member.currentWipe.isRegistered, true);
      assert.equal('serverOnline' in result.payload.member, false);
      assert.equal(result.payload.kdaSync.source, 'cache');
      assert.equal(publicBattlemetricsRequests.length, 0);
    } finally {
      globalThis.fetch = originalFetch;
      cookie = rootCookie;
    }

    const startedFutureAt = new Date(Date.now() - 60_000).toISOString();
    await updateStore((store) => {
      const futureWipe = store.wipes.find((wipe) => wipe.id === 'wipe_future_planned');
      if (futureWipe) {
        futureWipe.startedAt = startedFutureAt;
        futureWipe.vitalWipeId = 'stale-early-vital-wipe';
        futureWipe.kdaUrl = '/?view=dataLookup&tab=vital&vitalServerId=19&vitalWipeId=stale-early-vital-wipe';
        futureWipe.mapLink = '';
        futureWipe.updatedAt = startedFutureAt;
      }
      store.kdaRows.push({
        id: 'kda_future_stale_vital',
        wipeId: 'wipe_future_planned',
        memberId: 'member_test_1',
        steamId: '76561198000000001',
        kills: 999,
        deaths: 1,
        source: 'vital',
        syncedAt: startedFutureAt
      });
      store.kdaSnapshots.push({
        id: 'kda_snapshot_future_stale_vital',
        wipeId: 'wipe_future_planned',
        memberId: 'member_test_1',
        steamId: '76561198000000001',
        kills: 999,
        deaths: 1,
        source: 'vital',
        capturedAt: startedFutureAt,
        syncedAt: startedFutureAt
      });
    });
    const vitalRefreshFetch = globalThis.fetch;
    const previousVitalRefreshExternal = process.env.NB_DISABLE_EXTERNAL_VITAL;
    const vitalRefreshRequests = [];
    process.env.NB_DISABLE_EXTERNAL_VITAL = '0';
    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      if (href === 'https://playerstatistics.vitalgamenetwork.com/servers/19/wipes') {
        vitalRefreshRequests.push({ href, method: options.method || 'GET' });
        return new Response(JSON.stringify({
          statusCode: 200,
          data: [
            {
              gameServerId: 19,
              id: 'remote-previous-vital-wipe',
              startTime: new Date(Date.parse(startedFutureAt) - 7 * 24 * 60 * 60 * 1000).toISOString()
            },
            {
              gameServerId: 19,
              id: 'remote-current-vital-wipe',
              mapSize: 4750,
              mapUrl: 'https://cdn.example.com/remote-current.map',
              protocol: '2627.285.1',
              startTime: startedFutureAt
            }
          ]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return vitalRefreshFetch(url, options);
    };
    try {
      result = await request('/wipes/current');
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.wipe.id, 'wipe_future_planned');
	      assert.equal(result.payload.wipe.status, 'active');
	      assert.equal(result.payload.wipe.rawStatus, 'active');
	      assert.equal(result.payload.wipe.wipeMode, 'current');
		      assert.equal(result.payload.wipe.wipeLabel, 'Current');
		      assert.equal(result.payload.wipe.vitalWipeId, 'remote-current-vital-wipe');
		      assert.equal(result.payload.wipe.vitalWipeStartedAt, startedFutureAt);
		      assert.equal(result.payload.wipe.kdaUrl, '/?view=dataLookup&tab=vital&vitalServerId=19&vitalWipeId=remote-current-vital-wipe');
		      assert.equal(result.payload.wipe.mapLink, 'https://cdn.example.com/remote-current.map');
		      assert.equal(result.payload.wipe.mapSize, '4750');
		      assert.equal(result.payload.wipe.protocol, '2627.285.1');
		      assert.deepEqual(vitalRefreshRequests, [{
		        href: 'https://playerstatistics.vitalgamenetwork.com/servers/19/wipes',
		        method: 'GET'
		      }]);
		    } finally {
		      globalThis.fetch = vitalRefreshFetch;
		      process.env.NB_DISABLE_EXTERNAL_VITAL = previousVitalRefreshExternal;
		    }
		    const promotedFutureStore = await readStore();
		    const promotedFutureWipe = promotedFutureStore.wipes.find((wipe) => wipe.id === 'wipe_future_planned');
		    assert.equal(promotedFutureWipe.wipeMode, 'current');
		    assert.equal(promotedFutureWipe.wipeLabel, 'Current');
		    assert.equal(promotedFutureWipe.vitalWipeId, 'remote-current-vital-wipe');
		    assert.equal(promotedFutureWipe.vitalWipeStartedAt, startedFutureAt);
		    assert.equal(promotedFutureWipe.kdaUrl, '/?view=dataLookup&tab=vital&vitalServerId=19&vitalWipeId=remote-current-vital-wipe');
		    assert.equal(promotedFutureWipe.mapLink, 'https://cdn.example.com/remote-current.map');
		    assert.equal(promotedFutureWipe.mapSize, '4750');
		    assert.equal(promotedFutureWipe.protocol, '2627.285.1');
		    assert.equal(promotedFutureStore.kdaRows.some((row) => row.id === 'kda_future_stale_vital'), false);
		    assert.equal(promotedFutureStore.kdaSnapshots.some((row) => row.id === 'kda_snapshot_future_stale_vital'), false);
		    assert.equal(promotedFutureStore.kdaRows.some((row) => row.id === 'kda_future_different_server_alpha'), true);
    result = await request('/members');
    assert.equal(result.response.status, 200);
    const startedListMember = result.payload.members.find((member) => member.id === 'member_test_1');
    assert.equal(startedListMember.onlineSummary.wipeId, 'wipe_future_planned');
    assert.equal(startedListMember.onlineSummary.wipeStatus, 'active');
    assert.equal(startedListMember.onlineSummary.battlemetricsServerId, '32032048');
    assert.equal(startedListMember.onlineSummary.serverPlayTimeMinutes, 0);
    assert.equal(startedListMember.onlineSummary.weeklyPlayTimeMinutes, 0);
    assert.equal(startedListMember.onlineSummary.lastOnlineAt, '');

    const vitalServersFetch = globalThis.fetch;
    const previousExternalVitalForServerList = process.env.NB_DISABLE_EXTERNAL_VITAL;
    const vitalServerWipeRequests = [];
    process.env.NB_DISABLE_EXTERNAL_VITAL = '0';
    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      const match = href.match(/^https:\/\/playerstatistics\.vitalgamenetwork\.com\/servers\/(\d+)\/wipes$/);
      if (match) {
        vitalServerWipeRequests.push({ href, method: options.method || 'GET' });
        const data = match[1] === '23'
          ? [
              {
                id: 'remote-current-wipe',
                gameServerId: 23,
                startTime: '2026-06-20T18:45:00.000Z',
                mapUrl: 'https://cdn.example.com/current.map',
                mapSize: 4750,
                protocol: '2627.285.1'
              },
              {
                id: 'remote-closed-wipe',
                gameServerId: 23,
                startTime: '2026-06-01T18:45:00.000Z',
                endTime: '2026-06-20T18:44:59.000Z',
                mapUrl: 'https://cdn.example.com/closed.map',
                mapSize: 4500,
                protocol: '2626.1'
              }
            ]
          : [];
        return new Response(JSON.stringify({ statusCode: 200, data }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return vitalServersFetch(url, options);
    };
    try {
      result = await request('/vital-servers');
      assert.equal(result.response.status, 200);
      const remoteUsMonthly = result.payload.servers.find((server) => server.vitalServerId === '23');
      assert.equal(remoteUsMonthly.remoteAvailable, true);
      assert.equal(remoteUsMonthly.wipes.length, 2);
      assert.equal(remoteUsMonthly.wipeOptions[0].type, 'all');
      assert.equal(remoteUsMonthly.wipeOptions[0].vitalWipeId, '');
      assert.equal(remoteUsMonthly.wipeOptions.some((option) => option.vitalWipeId === 'remote-current-wipe'), true);
      assert.equal(remoteUsMonthly.wipeOptions.some((option) => option.vitalWipeId === 'remote-closed-wipe'), true);
      assert.equal(vitalServerWipeRequests.some((item) => item.href.endsWith('/servers/23/wipes')), true);
    } finally {
      globalThis.fetch = vitalServersFetch;
      process.env.NB_DISABLE_EXTERNAL_VITAL = previousExternalVitalForServerList;
    }

    const preWipeRangeStopAt = new Date(Date.parse(startedFutureAt) - 4 * 60 * 60 * 1000).toISOString();
    await updateStore((store) => {
      const futureRow = store.kdaRows.find((row) => row.id === 'kda_future_different_server_alpha');
      if (futureRow) {
        futureRow.onlineTimeMinutes = 246;
        futureRow.onlineSummary = {
          wipeId: 'wipe_future_planned',
          wipeName: 'Vital Rust 2X EU Medium 2026-06-18',
          wipeStatus: 'active',
          battlemetricsPlayerId: 'bm_player_1',
          battlemetricsServerId: '32032048',
          serverPlayTimeSeconds: 14767,
          serverPlayTimeMinutes: 246,
          weeklyPlayTimeSeconds: 14767,
          weeklyPlayTimeMinutes: 246,
          syncedAt: preWipeRangeStopAt,
          rangeStopAt: preWipeRangeStopAt,
          matchConfidence: 'steam-match'
        };
      }
      const alphaProfile = store.memberProfiles.find((profile) => profile.memberId === 'member_test_1');
      if (alphaProfile) {
        Object.assign(alphaProfile, {
          battlemetricsMatchConfidence: 'steam-match',
          battlemetricsMatchNotes: '',
          battlemetricsServerPlayTimeSeconds: 14767,
          battlemetricsWeeklyPlayTimeSeconds: 14767,
          battlemetricsSyncedAt: preWipeRangeStopAt,
          battlemetricsRangeStopAt: preWipeRangeStopAt
        });
      }
    });

    result = await request('/kda?wipeId=wipe_future_planned&scope=all&sort=kills&order=desc');
    assert.equal(result.response.status, 200);
    const stalePreWipeKdaRow = result.payload.rows.find((row) => row.id === 'kda_future_different_server_alpha');
    assert.equal(stalePreWipeKdaRow.onlineTimeMinutes, 0);
    assert.equal(stalePreWipeKdaRow.onlineSummary.battlemetricsServerId || '', '');

    result = await request('/members/member_test_1/profile');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.member.profileStats.battlemetrics.serverPlayTimeMinutes, 0);

    const failedSyncAt = new Date(Date.parse(startedFutureAt) + 10 * 60 * 1000).toISOString();
    const previousWipeOnlineAt = new Date(Date.parse(startedFutureAt) - 7 * 24 * 60 * 60 * 1000).toISOString();
    await updateStore((store) => {
      const futureRow = store.kdaRows.find((row) => row.id === 'kda_future_different_server_alpha');
      if (futureRow) {
        futureRow.onlineTimeMinutes = 4928;
        futureRow.onlineSummary = {
          wipeId: 'wipe_future_planned',
          wipeName: 'Vital Rust 2X EU Medium 2026-06-18',
          wipeStatus: 'active',
          battlemetricsPlayerId: 'bm_player_1',
          battlemetricsServerId: '32032048',
          lastOnlineAt: previousWipeOnlineAt,
          lastOfflineAt: previousWipeOnlineAt,
          serverPlayTimeSeconds: 4928 * 60,
          serverPlayTimeMinutes: 4928,
          weeklyPlayTimeSeconds: 4575 * 60,
          weeklyPlayTimeMinutes: 4575,
          syncedAt: failedSyncAt,
          error: 'BattleMetrics 未匹配到该 SteamID 或昵称',
          matchConfidence: 'exact-active-name'
        };
      }
      const alphaProfile = store.memberProfiles.find((profile) => profile.memberId === 'member_test_1');
      if (alphaProfile) {
        Object.assign(alphaProfile, {
          battlemetricsLastOnlineAt: previousWipeOnlineAt,
          battlemetricsLastOfflineAt: previousWipeOnlineAt,
          battlemetricsServerPlayTimeSeconds: 4928 * 60,
          battlemetricsWeeklyPlayTimeSeconds: 4575 * 60,
          battlemetricsSyncedAt: failedSyncAt,
          battlemetricsError: 'BattleMetrics 未匹配到该 SteamID 或昵称',
          battlemetricsRangeStopAt: ''
        });
      }
    });

    result = await request('/kda?wipeId=wipe_future_planned&scope=all&sort=kills&order=desc');
    assert.equal(result.response.status, 200);
    const failedSyncKdaRow = result.payload.rows.find((row) => row.id === 'kda_future_different_server_alpha');
    assert.equal(failedSyncKdaRow.onlineTimeMinutes, 0);
    assert.equal(failedSyncKdaRow.onlineSummary.battlemetricsServerId || '', '');

    result = await request('/members/member_test_1/profile');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.member.serverOnline.onlineTimeMinutes, 0);
    assert.equal(result.payload.member.profileStats.battlemetrics.serverPlayTimeMinutes, 0);

    await updateStore((store) => {
      store.wipes = store.wipes.filter((wipe) => wipe.id !== 'wipe_future_planned');
      store.wipeParticipants = store.wipeParticipants.filter((participant) => participant.wipeId !== 'wipe_future_planned');
    });

    const cloudflareBlockedRequests = [];
    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      if (!href.startsWith('https://api.battlemetrics.com')) {
        return originalFetch(url, options);
      }
      cloudflareBlockedRequests.push(href);
      return new Response('<!DOCTYPE html><title>Just a moment...</title>cloudflare challenge-platform', {
        status: 403,
        headers: { 'content-type': 'text/html; charset=UTF-8', server: 'cloudflare' }
      });
    };
    try {
      result = await request('/settings/battlemetrics/sync-playtime', {
        method: 'POST',
        ip: '10.10.0.8',
        body: { memberIds: ['member_test_2'] }
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.failed, 1);
      assert.equal(result.payload.status, 'failed');
      assert.equal(result.payload.error, 'BattleMetrics API 被 Cloudflare 阻止，请稍后重试或配置可访问的代理');
      assert.equal(cloudflareBlockedRequests.length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }

    result = await request(`/wipes/${wipeId}/participants/member_test_1`, { method: 'PUT', body: { status: 'on_time' } });
    assert.equal(result.response.status, 409);

    result = await request('/kda/import', { method: 'POST', body: { wipeId, rows: [{ steamId: '76561198000000001', kills: 99 }] } });
    assert.equal(result.response.status, 409);

    result = await request(`/wipes/${wipeId}?scope=all&sort=kda&order=desc`);
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.settlement.kdaSnapshot.some((row) => row.memberId === 'member_test_1' && row.kills === 10), true);
    assert.equal(result.payload.settlement.kdaSnapshot.some((row) => row.memberId === 'member_test_4'), true);

    result = await request(`/wipes/${wipeId}?scope=squad&squadIds=squad_test_2&sort=kda&order=desc`);
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.participants.length, 1);
    assert.equal(result.payload.participants[0].member.steamId, '76561198000000004');
    assert.equal(result.payload.rows.length >= 1, true);
    assert.equal(result.payload.rows.every((row) => row.squadId === 'squad_test_2'), true);
    assert.equal(result.payload.rows.some((row) => row.memberId === 'member_test_2'), true);
    assert.equal(result.payload.rows.every((row) => row.squadName === 'Bravo Squad'), true);

    result = await request(`/wipes/${wipeId}/export?scope=all&language=en`);
    assert.equal(result.response.status, 200);
    assert.match(result.response.headers.get('content-disposition') || '', new RegExp(`filename="NB-Vital-Workflow-${exportDateToken}-Settlement\\.csv"`));
    assert.match(result.text, /Server information/);
    assert.match(result.text, /T3 Kills/);
    assert.match(result.text, /Rockets/);
    assert.doesNotMatch(result.text, /,KD,/);
    assert.match(result.text, /Workflow Wipe/);
    assert.match(result.text, /Alpha/);
    assert.doesNotMatch(result.text, /\bVT\b/);

    result = await request(`/wipes/${wipeId}/export?scope=all&language=en&format=html&ranking=metalOre&timeZone=Asia/Shanghai`);
    assert.equal(result.response.status, 200);
    assert.match(result.response.headers.get('content-type') || '', /text\/html/);
    assert.match(result.response.headers.get('content-disposition') || '', new RegExp(`filename="NB-Vital-Workflow-${exportDateToken}-Metal-ore-ranking\\.html"`));
    assert.match(result.response.headers.get('content-disposition') || '', new RegExp(`filename\\*=UTF-8''NB-Vital-Workflow-${exportDateToken}%20-%20Metal%20ore%20ranking\\.html`));
    assert.match(result.text, /Top kills/);
    assert.match(result.text, /Top T3 kills/);
    assert.match(result.text, /Top rockets/);
    assert.match(result.text, /Top sulfur/);
    assert.match(result.text, /class="avatar"/);
    assert.match(result.text, /class="leaderboard-table"/);
    assert.match(result.text, /Clan Portal · Metal ore leaderboard/);
    assert.match(result.text, /<th>#<\/th><th>Name<\/th><th>Team<\/th><th>Online time<\/th><th class="leaderboard-primary-stat">Metal ore<\/th><th>Kills<\/th><th>T3 Kills<\/th><th>Deaths<\/th><th>KDA<\/th><th>RPG<\/th><th>Sulfur<\/th><th>Building<\/th>/);
    assert.match(result.text, /1\.2w/);
    assert.match(result.text, /Play days<\/label><strong>3/);
    assert.match(result.text, /page-break-inside: avoid/);
    assert.doesNotMatch(result.text, /<h2>Participants<\/h2>/);
    assert.doesNotMatch(result.text, /Top KDA/);
    assert.doesNotMatch(result.text, /KDA data/);
    assert.doesNotMatch(result.text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    assert.doesNotMatch(result.text, /\bVT\b/);

    result = await request(`/wipes/${wipeId}/export?scope=all&language=en&format=html&ranking=online_minutes&timeZone=Asia/Shanghai`);
    assert.equal(result.response.status, 200);
    assert.match(result.text, /Clan Portal · Online time leaderboard/);
    assert.match(result.text, /<th>#<\/th><th>Name<\/th><th>Team<\/th><th class="leaderboard-primary-stat">Online time<\/th><th>Kills<\/th><th>T3 Kills<\/th><th>Deaths<\/th><th>KDA<\/th><th>RPG<\/th>/);
    assert.doesNotMatch(result.text, /<th>Online time<\/th><th class="leaderboard-primary-stat">Online time<\/th>/);

    result = await request(`/wipes/${wipeId}/export?scope=squad&squadIds=squad_test_2&language=en&format=html&ranking=kills&timeZone=Asia/Shanghai`);
    assert.equal(result.response.status, 200);
    assert.match(result.text, /Bravo/);
    assert.match(result.text, /Bravo Squad/);
    assert.match(result.text, /Members<\/label><strong>1/);
    assert.doesNotMatch(result.text, /Alpha/);

    result = await request('/logs?q=Vital%20Rust');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.logs.some((log) => log.summary.includes('Vital Rust Workflow Wipe')), true);
    assert.equal(result.payload.logs.some((log) => /\bVT\b/.test(log.summary)), false);
    assert.equal(typeof result.payload.total, 'number');
    assert.equal(result.payload.limit, 300);
    assert.equal(Boolean(result.payload.range.from), true);
    assert.equal(Boolean(result.payload.range.to), true);

    const historicalLogTime = new Date(Date.now() - 3 * 86_400_000);
    const historicalLogEnd = new Date(historicalLogTime.getTime() + 60_000);
    await updateStore((store) => {
      store.logs.unshift({
        id: 'log_historical_test',
        type: 'query',
        actorUserId: 'user_root',
        actorUsername: 'root',
        ip: '127.0.0.1',
        steamId: '',
        targetId: '',
        summary: 'Vital Rust Historical Wipe',
        metadata: {},
        createdAt: historicalLogTime.toISOString()
      });
    });
    result = await request('/logs?q=Historical');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.logs.length, 0);
    result = await request(`/logs?q=Historical&from=${encodeURIComponent(historicalLogTime.toISOString())}&to=${encodeURIComponent(historicalLogEnd.toISOString())}`);
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.logs.length, 1);
    assert.equal(result.payload.logs[0].summary, 'Vital Rust Historical Wipe');

    result = await request(`/wipes/${wipeId}`, { method: 'DELETE' });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.wipes.some((wipe) => wipe.id === wipeId), false);

    result = await request(`/wipes/${wipeId}?scope=all&sort=kda&order=desc`);
    assert.equal(result.response.status, 404);

    const deletedStore = await readStore();
    assert.equal(deletedStore.wipes.some((wipe) => wipe.id === wipeId), false);
    assert.equal(deletedStore.wipeParticipants.some((participant) => participant.wipeId === wipeId), false);
    assert.equal(deletedStore.kdaRows.some((row) => row.wipeId === wipeId), false);
    assert.equal(deletedStore.kdaSnapshots.some((row) => row.wipeId === wipeId), false);
    assert.equal(deletedStore.wipeSettlements.some((settlement) => settlement.wipeId === wipeId), false);
    assert.equal(deletedStore.uploads.some((upload) => upload.ownerType === 'wipe' && upload.ownerId === wipeId), false);

    discordRequest = null;
    const autoCreateStartedAt = Date.now();
    result = await request('/wipes/current/discord-attendance', { method: 'POST', body: { vitalServerId: '23' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.wipe.serverName, 'Vital Rust 2X US Monthly');
    assert.equal(Date.parse(result.payload.wipe.startedAt) > autoCreateStartedAt, true);
    assert.equal(discordRequest.body.embeds[0].title, '🚨 Vital Rust 2X US Monthly WIPE 🚨');
    assert.match(discordRequest.body.embeds[0].description, /🗓️ Date: <t:\d+:F> 🕖 Time: <t:\d+:t>/);
    assert.doesNotMatch(discordRequest.body.embeds[0].description, /Signup Window/);
    assert.equal(findDiscordAttendanceField(discordRequest.body.embeds[0].fields, '✅ Attending (0)').value, '-');
    const autoWipeId = result.payload.wipe.id;
    result = await request(`/wipes/${autoWipeId}/close`, { method: 'POST' });
    assert.equal(result.response.status, 200);
    result = await request(`/wipes/${autoWipeId}`, { method: 'DELETE' });
    assert.equal(result.response.status, 200);

    result = await request('/squads/squad_test_1', { method: 'DELETE' });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.squads.some((squad) => squad.id === 'squad_test_1'), false);
    const squadDeletedStore = await readStore();
    assert.equal(Boolean(squadDeletedStore.squads.find((squad) => squad.id === 'squad_test_1')?.archivedAt), true);
    assert.equal(squadDeletedStore.squadMembers.some((item) => item.squadId === 'squad_test_1'), false);
  } finally {
    __mooseStatsProviderForTests.reset();
    await drainBackgroundTaskQueuesForTests().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => discordServer.close(resolve));
    await new Promise((resolve) => kookServer.close(resolve));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    delete process.env.NB_TRUST_PROXY;
    delete process.env.NB_DISCORD_API_BASE_URL;
    delete process.env.NB_KOOK_API_BASE_URL;
    delete process.env.NB_RUST_KDA_BASE_URL;
    delete process.env.NB_RUST_KDA_PROVIDER;
    delete process.env.NB_DISCORD_KDA_AUTO_DELETE_MS;
    delete process.env.NB_DISCORD_MEMBER_RANKING_AUTO_DELETE_MS;
    delete process.env.NB_DISCORD_WIPE_ATTENDANCE_REFRESH_DEBOUNCE_MS;
  }
});
