import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

test('discord-kook bridge initializes cursors and syncs translated @everyone messages both ways', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-discord-kook-'));
  const previousEnv = {
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE
  };
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISCORD_SEND_INTERVAL_MS = '0';
  process.env.NB_DISCORD_KOOK_BRIDGE_BATCH_LIMIT = '10';
  process.env.NODE_ENV = 'production';
  delete process.env.NB_COOKIE_SECURE;

  const discordMessagesByChannel = new Map();
  function discordMessages(channelId) {
    if (!discordMessagesByChannel.has(channelId)) discordMessagesByChannel.set(channelId, []);
    return discordMessagesByChannel.get(channelId);
  }
  discordMessages('123456789012345679').push({
    id: '100000000000000001',
    channel_id: '123456789012345679',
    content: 'seed',
    timestamp: '2026-06-18T00:00:00.000Z',
    mention_everyone: false,
    author: { id: 'discord_user_seed', username: 'Seed', bot: false }
  });
  discordMessages('123456789012345680').push({
    id: '100000000000000011',
    channel_id: '123456789012345680',
    content: 'seed 2',
    timestamp: '2026-06-18T00:00:00.000Z',
    mention_everyone: false,
    author: { id: 'discord_user_seed_2', username: 'Seed2', bot: false }
  });
  const discordPosts = [];
  const discordApp = express();
  discordApp.use(express.json());
  discordApp.get('/channels/:channelId/messages', (req, res) => {
    const after = String(req.query.after || '');
    const messages = discordMessages(req.params.channelId);
    const afterIndex = after ? messages.findIndex((message) => message.id === after) : -1;
    const items = after
      ? messages.slice(afterIndex + 1)
      : messages.slice(-1);
    res.json(items.slice().reverse());
  });
  discordApp.post('/channels/:channelId/messages', (req, res) => {
    const id = `20000000000000000${discordPosts.length + 1}`;
    const messages = discordMessages(req.params.channelId);
    discordPosts.push({
      channelId: req.params.channelId,
      authorization: req.get('authorization') || '',
      body: req.body
    });
    messages.push({
      id,
      channel_id: req.params.channelId,
      content: req.body?.content || '',
      timestamp: new Date(Date.UTC(2026, 5, 18, 0, 10 + discordPosts.length)).toISOString(),
      mention_everyone: /@everyone/.test(req.body?.content || ''),
      author: { id: 'discord_bot', username: 'NB Bridge', bot: true }
    });
    res.json({ id, channel_id: req.params.channelId });
  });
  discordApp.get('/attachments/raid-plan.png', (_req, res) => {
    res.type('image/png').send(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });
  discordApp.get('/attachments/second-plan.png', (_req, res) => {
    res.type('image/png').send(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });
  discordApp.get('/attachments/tenor-spray.gif', (_req, res) => {
    res.type('image/gif').send(Buffer.from('GIF89a-tenor-preview'));
  });
  const discordServer = createServer(discordApp);
  await new Promise((resolve) => discordServer.listen(0, '127.0.0.1', resolve));
  process.env.NB_DISCORD_API_BASE_URL = `http://127.0.0.1:${discordServer.address().port}`;

  const kookMessagesByChannel = new Map();
  function kookMessages(channelId) {
    if (!kookMessagesByChannel.has(channelId)) kookMessagesByChannel.set(channelId, []);
    return kookMessagesByChannel.get(channelId);
  }
  kookMessages('kook_channel_123').push({
    id: 'kook_seed',
    type: 9,
    content: 'seed',
    mention_all: false,
    create_at: Date.UTC(2026, 5, 18, 0, 0),
    author: { id: 'kook_user_seed', username: 'Seed', bot: false }
  });
  kookMessages('kook_channel_456').push({
    id: 'kook_seed_2',
    type: 9,
    content: 'seed 2',
    mention_all: false,
    create_at: Date.UTC(2026, 5, 18, 0, 0),
    author: { id: 'kook_user_seed_2', username: 'Seed2', bot: false }
  });
  const kookPosts = [];
  const kookAssets = [];
  const kookListQueries = [];
  const failingKookListChannels = new Set();
  const kookApp = express();
  kookApp.use(express.json());
  kookApp.get('/api/v3/message/list', (req, res) => {
    const targetId = String(req.query.target_id || '');
    kookListQueries.push({ ...req.query });
    if (failingKookListChannels.has(targetId)) {
      res.status(400).json({ code: 400, message: 'target object missing' });
      return;
    }
    const msgId = String(req.query.msg_id || '');
    const pageSize = Math.max(1, Math.min(50, Number(req.query.page_size || 50) || 50));
    const messages = kookMessages(targetId);
    const index = msgId ? messages.findIndex((message) => message.id === msgId) : -1;
    const items = msgId
      ? messages.slice(index + 1)
      : messages.slice(-pageSize);
    res.json({ code: 0, message: '操作成功', data: { items: items.slice().reverse() } });
  });
  kookApp.post('/api/v3/message/send-pipemsg', (req, res) => {
    const id = `kook_bridge_${kookPosts.length + 1}`;
    const targetId = String(req.query.target_id || '');
    const content = req.body?.content || '';
    if (/kook content rejected/i.test(content)) {
      res.json({ code: 400, message: '请检查消息内容后重试' });
      return;
    }
    const messages = kookMessages(targetId);
    kookPosts.push({
      authorization: req.get('authorization') || '',
      query: req.query,
      body: req.body
    });
    messages.push({
      id,
      type: Number(req.query.type || 9),
      content,
      mention_all: /\(met\)\s*all\s*\(met\)/i.test(content),
      create_at: Date.UTC(2026, 5, 18, 0, 5 + kookPosts.length),
      author: { id: 'kook_bot', username: 'NB Bridge', bot: true }
    });
    res.json({ code: 0, message: '操作成功', data: { msg_id: id, msg_timestamp: Date.UTC(2026, 5, 18, 0, 5 + kookPosts.length) } });
  });
  kookApp.post('/api/v3/asset/create', (req, res) => {
    kookAssets.push({
      authorization: req.get('authorization') || '',
      contentType: req.get('content-type') || ''
    });
    res.json({
      code: 0,
      message: '操作成功',
      data: { url: `https://img.kook.test/assets/${kookAssets.length}.png` }
    });
  });
  const kookServer = createServer(kookApp);
  await new Promise((resolve) => kookServer.listen(0, '127.0.0.1', resolve));
  process.env.NB_KOOK_API_BASE_URL = `http://127.0.0.1:${kookServer.address().port}/api/v3`;

  const aiRequests = [];
  const aiApp = express();
  aiApp.use(express.json());
  aiApp.post('/v1/chat/completions', (req, res) => {
    aiRequests.push({ authorization: req.get('authorization') || '', body: req.body });
    const prompt = req.body?.messages?.at(-1)?.content || '';
    const target = (/Target language:\s*([^\n]+)/i.exec(prompt)?.[1] || '').trim();
    const hasNickname = /昵称[：:]\s*xxxx/i.test(prompt);
    const hasHelloWorld = /hello world/i.test(prompt);
    const byTarget = {
      'Simplified Chinese': hasNickname ? '昵称：xxxx' : (hasHelloWorld ? '你好，世界 @everyone' : '你好 @everyone'),
      English: hasNickname ? 'Nickname: xxxx' : (hasHelloWorld ? 'Hello world @everyone' : 'Hello @everyone'),
      Russian: hasNickname ? 'Никнейм: xxxx' : (hasHelloWorld ? 'Привет, мир @everyone' : 'Привет @everyone'),
      Turkish: hasNickname ? 'Takma ad: xxxx' : (hasHelloWorld ? 'Merhaba dünya @everyone' : 'Merhaba @everyone')
    };
    const content = byTarget[target] || 'translated';
    res.json({ choices: [{ message: { content } }] });
  });
  const aiServer = createServer(aiApp);
  await new Promise((resolve) => aiServer.listen(0, '127.0.0.1', resolve));
  process.env.NB_TRANSLATION_API_BASE_URL = `http://127.0.0.1:${aiServer.address().port}/v1`;
  process.env.NB_TRANSLATION_API_KEY = 'translation_key_1234567890';
  process.env.NB_TRANSLATION_MODEL = 'gpt-5.4-mini';

  let apiServer = null;
  try {
    const { createApiRouter } = await import('../server/api.js');
    const { ensureStore, readStore } = await import('../server/store.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await ensureStore();

    const app = express();
    app.use('/api', createApiRouter());
    apiServer = createServer(app);
    await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${apiServer.address().port}/api`;
    let cookie = '';

    async function request(url, options = {}) {
      const response = await fetch(`${baseUrl}${url}`, {
        method: options.method || 'GET',
        headers: {
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {})
        },
        body: options.body ? JSON.stringify(options.body) : undefined
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const payload = await response.json();
      return { response, payload };
    }

    let result = await request('/auth/login', { method: 'POST', body: { username: 'root', password: 'RootPass123!' } });
    assert.equal(result.response.status, 200);

    result = await request('/settings/discord', {
      method: 'PUT',
      body: {
        botToken: 'discord_bot_token_123456789012345',
        targets: [{
          id: 'default',
          name: 'Bridge source',
          guildId: '123456789012345678',
          channelId: '123456789012345679'
        }]
      }
    });
    assert.equal(result.response.status, 200);

    result = await request('/settings/kook', {
      method: 'PUT',
      body: {
        botToken: 'kook_bot_token_1234567890',
        guildId: 'kook_guild_123',
        channelId: 'kook_channel_123'
      }
    });
    assert.equal(result.response.status, 200);

    result = await request('/settings/discord-kook-bridge', {
      method: 'PUT',
      body: {
        enabled: true,
        translationApiKey: 'web_translation_key_1234567890',
        translationBaseUrl: process.env.NB_TRANSLATION_API_BASE_URL,
        translationModel: 'gpt-5.4-mini',
        pollIntervalSeconds: 3,
        routes: [{
          name: 'Primary',
          enabled: true,
          discordGuildId: '123456789012345678',
          discordChannelId: '123456789012345679',
          kookChannelId: 'kook_channel_123',
          kookAccessToken: 'kook_pipe_token_primary_123'
        }, {
          name: 'Second',
          enabled: true,
          discordGuildId: '123456789012345681',
          discordChannelId: '123456789012345680',
          kookChannelId: 'kook_channel_456',
          kookAccessToken: 'kook_pipe_token_second_456'
        }]
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.bridge.configured, true);
    assert.equal(result.payload.bridge.routeCount, 2);
    assert.equal(result.payload.bridge.configuredRouteCount, 2);
    assert.equal(result.payload.bridge.translationKeySource, 'web');
    assert.equal(result.payload.bridge.translationConfigured, true);
    assert.equal(result.payload.bridge.pollIntervalMs, 3000);
    assert.equal(result.payload.bridge.pollIntervalMinMs, 3000);

    result = await request('/settings/discord-kook-bridge', {
      method: 'PUT',
      body: {
        enabled: true,
        routes: [{
          name: 'Duplicate A',
          enabled: true,
          discordGuildId: '123456789012345678',
          discordChannelId: '123456789012345679',
          kookChannelId: 'kook_channel_123',
          kookAccessToken: 'kook_pipe_token_duplicate_a'
        }, {
          name: 'Duplicate B',
          enabled: true,
          discordGuildId: '123456789012345678',
          discordChannelId: '123456789012345679',
          kookChannelId: 'kook_channel_123',
          kookAccessToken: 'kook_pipe_token_duplicate_b'
        }]
      }
    });
    assert.equal(result.response.status, 400);
    assert.match(JSON.stringify(result.payload), /频道重复/);

    result = await request('/settings/discord-kook-bridge/sync', { method: 'POST', body: {} });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.result.initialized, true);
    assert.equal(result.payload.result.operationRun.type, 'discord_kook_bridge_sync');
    assert.equal(result.payload.result.operationRun.platform, 'system');
    assert.equal(result.payload.result.operationRun.source, 'manual');
    assert.equal(result.payload.result.operationRun.status, 'succeeded');
    assert.equal(result.payload.result.operationRun.targetId, 'all_routes');
    assert.equal(result.payload.result.operationRun.createdBy, 'user_root');
    assert.equal(result.payload.result.operationRun.metadata.manual, 'true');
    const bridgeOperationStore = await readStore();
    assert.equal((bridgeOperationStore.operationRuns || []).some((run) => (
      run.id === result.payload.result.operationRun.id &&
      run.type === 'discord_kook_bridge_sync' &&
      run.status === 'succeeded'
    )), true);
    assert.equal(kookPosts.length, 0);
    assert.equal(discordPosts.length, 0);

    discordMessages('123456789012345679').push({
      id: '100000000000000002',
      channel_id: '123456789012345679',
      content: 'hello world @everyone',
      timestamp: '2026-06-18T00:01:00.000Z',
      mention_everyone: true,
      author: { id: 'discord_user_1', username: 'DiscUser', bot: false }
    });
    result = await request('/settings/discord-kook-bridge/sync', { method: 'POST', body: {} });
    assert.equal(result.response.status, 200);
    assert.equal(kookPosts.length, 1);
    assert.equal(kookPosts[0].authorization, '');
    assert.equal(kookPosts[0].query.access_token, 'kook_pipe_token_primary_123');
    assert.equal(kookPosts[0].query.target_id, 'kook_channel_123');
    assert.match(kookPosts[0].body.content, /\(met\)all\(met\)/);
    assert.match(kookPosts[0].body.content, /Discord · Primary/);
    assert.match(kookPosts[0].body.content, /\(met\)all\(met\)\n\nDiscord · Primary\n\nDiscUser: hello world @everyone\n\n中文: 你好，世界 @everyone\n\n\u2063\u200C\u200D\u2060\u200B\u2063\u200B$/);
    assert.doesNotMatch(kookPosts[0].body.content, /英文|俄文|土耳其文/);
    assert.doesNotMatch(kookPosts[0].body.content, /Русский:|Türkçe:/);
    assert.doesNotMatch(kookPosts[0].body.content, /\[Translation\]/);
    let bridgeMessageRefStore = await readStore();
    const kookBridgeMessageRef = (bridgeMessageRefStore.integrationMessageRefs || []).find((ref) => (
      ref.platform === 'kook' &&
        ref.kind === 'discord_kook_bridge_message' &&
        ref.targetType === 'discord_kook_bridge_route' &&
        ref.messageId === 'kook_bridge_1'
    ));
    assert.ok(kookBridgeMessageRef);
    assert.equal(kookBridgeMessageRef.status, 'active');
    assert.equal(kookBridgeMessageRef.channelId, 'kook_channel_123');
    assert.equal(kookBridgeMessageRef.metadata.direction, 'discord_to_kook');
    assert.equal(kookBridgeMessageRef.metadata.sourcePlatform, 'discord');
    assert.equal(kookBridgeMessageRef.metadata.sourceChannelId, '123456789012345679');
    assert.equal(kookBridgeMessageRef.metadata.sourceMessageId, '100000000000000002');

    discordMessages('123456789012345680').push({
      id: '100000000000000012',
      channel_id: '123456789012345680',
      content: 'hello world from <@222222222222222222> <@!333333333333333333> <#444444444444444444> <@&555555555555555555>',
      timestamp: '2026-06-18T00:02:00.000Z',
      mention_everyone: false,
      author: { id: 'discord_user_2', username: 'DiscUser2', bot: false },
      mentions: [
        { id: '222222222222222222', username: 'Alice', global_name: 'Alice Global' },
        { id: '333333333333333333', username: 'Bob' }
      ],
      mention_channels: [
        { id: '444444444444444444', name: 'general' }
      ],
      mention_roles: ['555555555555555555'],
      attachments: [{
        id: 'attachment_1',
        filename: 'raid-plan.png',
        content_type: 'image/png',
        url: `${process.env.NB_DISCORD_API_BASE_URL}/attachments/raid-plan.png`
      }, {
        id: 'attachment_2',
        filename: 'second-plan.png',
        content_type: 'image/png',
        url: `${process.env.NB_DISCORD_API_BASE_URL}/attachments/second-plan.png`
      }]
    });
    result = await request('/settings/discord-kook-bridge/sync', { method: 'POST', body: {} });
    assert.equal(result.response.status, 200);
    assert.equal(kookPosts.length, 2);
    assert.equal(kookPosts[1].query.target_id, 'kook_channel_456');
    assert.equal(kookPosts[1].query.access_token, 'kook_pipe_token_second_456');
    assert.equal(kookPosts[1].query.type, '10');
    assert.equal(kookAssets.length, 2);
    assert.equal(kookAssets[0].authorization, 'Bot kook_bot_token_1234567890');
    assert.match(kookAssets[0].contentType, /^multipart\/form-data\b/);
    assert.equal(kookAssets[1].authorization, 'Bot kook_bot_token_1234567890');
    assert.match(kookAssets[1].contentType, /^multipart\/form-data\b/);
    const discordImageBridgeCard = JSON.parse(kookPosts[1].body.content);
    const discordImageBridgeCardJson = JSON.stringify(discordImageBridgeCard);
    assert.match(discordImageBridgeCardJson, /Discord · Second/);
    assert.match(discordImageBridgeCardJson, /DiscUser2: hello world from @Alice Global @Bob #general @role:555555555555555555/);
    assert.match(discordImageBridgeCardJson, /https:\/\/img\.kook\.test\/assets\/1\.png/);
    assert.match(discordImageBridgeCardJson, /https:\/\/img\.kook\.test\/assets\/2\.png/);
    assert.doesNotMatch(discordImageBridgeCardJson, /attachments\/raid-plan\.png/);
    assert.doesNotMatch(discordImageBridgeCardJson, /second-plan\.png/);
    assert.doesNotMatch(discordImageBridgeCardJson, /\(img\).*raid-plan\.png\(img\)/);
    assert.doesNotMatch(discordImageBridgeCardJson, /<@!?222222222222222222>|<#444444444444444444>|<@&555555555555555555>/);
    assert.match(discordImageBridgeCardJson, /中文: 你好，世界 @everyone/);
    assert.doesNotMatch(discordImageBridgeCardJson, /Русский:|Türkçe:/);
    assert.doesNotMatch(aiRequests.at(-1).body.messages.at(-1).content, /attachments\/raid-plan\.png|second-plan\.png/);

    discordMessages('123456789012345679').push({
      id: '100000000000000003',
      channel_id: '123456789012345679',
      content: '(met)all(met) fake @everyone',
      timestamp: '2026-06-18T00:03:00.000Z',
      mention_everyone: false,
      author: { id: 'discord_user_3', username: 'Trickster', bot: false }
    });
    result = await request('/settings/discord-kook-bridge/sync', { method: 'POST', body: {} });
    assert.equal(result.response.status, 200);
    assert.equal(kookPosts.length, 3);
    assert.equal(kookPosts[2].query.target_id, 'kook_channel_123');
    assert.doesNotMatch(kookPosts[2].body.content, /(^|\n)\(met\)all\(met\)/);
    assert.match(kookPosts[2].body.content, /\\\(met\\\)all\\\(met\\\)/);

    kookMessages('kook_channel_123').push({
      id: 'kook_user_2',
      type: 9,
      content: '(met)all(met) 你好',
      mention_all: true,
      create_at: Date.UTC(2026, 5, 18, 0, 12),
      author: { id: 'kook_user_1', username: 'KookUser', bot: false }
    });
    result = await request('/settings/discord-kook-bridge/sync', { method: 'POST', body: {} });
    assert.equal(result.response.status, 200);
    assert.equal(discordPosts.length, 1);
    assert.equal(discordPosts[0].authorization, 'Bot discord_bot_token_123456789012345');
    assert.equal(discordPosts[0].channelId, '123456789012345679');
    assert.match(discordPosts[0].body.content, /@everyone/);
    assert.match(discordPosts[0].body.content, /KOOK · Primary/);
    assert.match(discordPosts[0].body.content, /@everyone\n\nKOOK · Primary\n\nKookUser: @everyone 你好\n\nEnglish: Hello @everyone\n\nРусский: Привет @everyone\n\nTürkçe: Merhaba @everyone\n\n\u2063\u200C\u200D\u2060\u200B\u2063\u200B$/);
    assert.doesNotMatch(discordPosts[0].body.content, /英文|俄文|土耳其文/);
    assert.doesNotMatch(discordPosts[0].body.content, /中文:/);
    assert.doesNotMatch(discordPosts[0].body.content, /\[Translation\]/);
    assert.deepEqual(discordPosts[0].body.allowed_mentions, { parse: ['everyone'] });
    bridgeMessageRefStore = await readStore();
    const discordBridgeMessageRef = (bridgeMessageRefStore.integrationMessageRefs || []).find((ref) => (
      ref.platform === 'discord' &&
        ref.kind === 'discord_kook_bridge_message' &&
        ref.targetType === 'discord_kook_bridge_route' &&
        ref.messageId === '200000000000000001'
    ));
    assert.ok(discordBridgeMessageRef);
    assert.equal(discordBridgeMessageRef.status, 'active');
    assert.equal(discordBridgeMessageRef.channelId, '123456789012345679');
    assert.equal(discordBridgeMessageRef.targetId, kookBridgeMessageRef.targetId);
    assert.equal(discordBridgeMessageRef.metadata.direction, 'kook_to_discord');
    assert.equal(discordBridgeMessageRef.metadata.sourcePlatform, 'kook');
    assert.equal(discordBridgeMessageRef.metadata.sourceChannelId, 'kook_channel_123');
    assert.equal(discordBridgeMessageRef.metadata.sourceMessageId, 'kook_user_2');
    assert.equal(aiRequests.length, 6);
    assert.equal(aiRequests[0].authorization, 'Bearer web_translation_key_1234567890');
    const systemPrompt = aiRequests[0].body.messages[0].content;
    assert.match(systemPrompt, /clan table/);
    assert.match(systemPrompt, /raid defense/);
    assert.match(systemPrompt, /oyundaysanız/);
    assert.match(systemPrompt, /TC\/tool cupboard/);
    assert.match(systemPrompt, /locker\/wardrobe\/closet/);
    assert.match(systemPrompt, /HQM\/high quality metal/);
    assert.match(systemPrompt, /help hqm tower/);
    assert.match(systemPrompt, /FOB/);
    assert.match(systemPrompt, /MLRS/);
    assert.match(systemPrompt, /dome roof\/top/);
    assert.match(systemPrompt, /farm\/fram\/faming\/farmin/);
    assert.match(systemPrompt, /doorcamp/);
    assert.match(systemPrompt, /oil rig/);
    assert.doesNotMatch(systemPrompt, /\u9ad8\u8d28/);
    assert.equal(kookListQueries.every((query) => !Object.hasOwn(query, 'msg_id')), true);

    result = await request('/settings/discord-kook-bridge');
    assert.equal(result.response.status, 200);
    const primaryRoute = result.payload.bridge.routes.find((route) => route.name === 'Primary');
    const secondRoute = result.payload.bridge.routes.find((route) => route.name === 'Second');
    assert.ok(primaryRoute?.id);
    assert.ok(secondRoute?.id);
    assert.equal(primaryRoute.lastDiscordMessageId, '100000000000000003');
    assert.equal(primaryRoute.lastKookMessageId, 'kook_user_2');
    assert.equal(primaryRoute.lastKookMessageAt, String(Date.UTC(2026, 5, 18, 0, 12)));

    const primaryDiscordMessages = discordMessages('123456789012345679');
    result = await request('/settings/discord-kook-bridge/sync', { method: 'POST', body: { routeId: primaryRoute.id } });
    assert.equal(result.response.status, 200);
    assert.equal(kookPosts.length, 3);
    const beforeTrackingFailureKookPosts = kookPosts.length;
    const trackingFailureDiscordMessageId = '100000000000000019';
    primaryDiscordMessages.push({
      id: trackingFailureDiscordMessageId,
      channel_id: '123456789012345679',
      content: 'tracking write failure',
      timestamp: '2026-06-18T00:18:00.000Z',
      mention_everyone: false,
      author: { id: 'discord_user_tracking_failure', username: 'TrackUser', bot: false }
    });
    repositoryModule.injectSqliteStorePatchFailureForTests('discord_kook_bridge_route_state', 1);
    result = await request('/settings/discord-kook-bridge/sync', { method: 'POST', body: { routeId: primaryRoute.id } });
    assert.equal(result.response.status, 200);
    assert.equal(kookPosts.length, beforeTrackingFailureKookPosts + 1, JSON.stringify(result.payload.result));
    assert.equal(result.payload.result.errors, 1);
    assert.equal(result.payload.result.operationRun.status, 'failed');
    assert.equal(result.payload.result.operationRun.metadata.externalActionSucceeded, 'true');
    assert.equal(result.payload.result.operationRun.metadata.trackingWriteFailed, 'true');
    assert.match(result.payload.result.operationRun.metadata.trackingWriteError, /Injected sqlite patch failure for discord_kook_bridge_route_state/);
    const trackingFailureRouteResult = result.payload.result.routes[0];
    assert.equal(trackingFailureRouteResult.discordToKook.forwarded, 1);
    assert.equal(trackingFailureRouteResult.discordToKook.trackingWriteFailed, true);
    assert.equal(trackingFailureRouteResult.discordToKook.externalActionSucceeded, true);
    assert.equal(trackingFailureRouteResult.discordToKook.messageRefPersisted, true);
    assert.equal(trackingFailureRouteResult.discordToKook.trackingRecovered, true);
    const trackingFailureKookMessageId = `kook_bridge_${beforeTrackingFailureKookPosts + 1}`;
    const trackingFailureStore = await readStore();
    const trackingFailureRef = (trackingFailureStore.integrationMessageRefs || []).find((ref) => (
      ref.platform === 'kook' &&
        ref.kind === 'discord_kook_bridge_message' &&
        ref.messageId === trackingFailureKookMessageId
    ));
	    assert.ok(trackingFailureRef);
	    assert.equal(trackingFailureRef.metadata.sourceMessageId, trackingFailureDiscordMessageId);
	    const trackingFailureRoute = trackingFailureStore.settings.discordKookBridge.routes.find((route) => route.id === primaryRoute.id);
	    assert.equal(trackingFailureRoute.lastDiscordMessageId, trackingFailureDiscordMessageId);

	    const beforeMessageRefFailureKookPosts = kookPosts.length;
	    const messageRefFailureDiscordMessageId = '100000000000000020';
	    primaryDiscordMessages.push({
	      id: messageRefFailureDiscordMessageId,
	      channel_id: '123456789012345679',
	      content: 'message ref write failure',
	      timestamp: '2026-06-18T00:18:30.000Z',
	      mention_everyone: false,
	      author: { id: 'discord_user_message_ref_failure', username: 'RefUser', bot: false }
	    });
	    repositoryModule.injectSqliteStorePatchFailureForTests('discord_kook_bridge_message_ref', 1);
	    result = await request('/settings/discord-kook-bridge/sync', { method: 'POST', body: { routeId: primaryRoute.id } });
	    assert.equal(result.response.status, 200);
	    assert.equal(kookPosts.length, beforeMessageRefFailureKookPosts + 1, JSON.stringify(result.payload.result));
	    assert.equal(result.payload.result.errors, 1);
	    assert.equal(result.payload.result.operationRun.status, 'failed');
	    assert.equal(result.payload.result.operationRun.metadata.externalActionSucceeded, 'true');
	    assert.equal(result.payload.result.operationRun.metadata.trackingWriteFailed, 'true');
	    assert.equal(result.payload.result.operationRun.metadata.messageRefWriteFailed, 'true');
	    assert.equal(result.payload.result.operationRun.metadata.messageRefPersisted, 'false');
	    assert.match(result.payload.result.operationRun.metadata.trackingWriteError, /Injected sqlite patch failure for discord_kook_bridge_message_ref/);
	    const messageRefFailureRouteResult = result.payload.result.routes[0];
	    assert.equal(messageRefFailureRouteResult.discordToKook.forwarded, 1);
	    assert.equal(messageRefFailureRouteResult.discordToKook.trackingWriteFailed, true);
	    assert.equal(messageRefFailureRouteResult.discordToKook.externalActionSucceeded, true);
	    assert.equal(messageRefFailureRouteResult.discordToKook.messageRefPersisted, false);
	    assert.equal(messageRefFailureRouteResult.discordToKook.messageRefWriteFailed, true);
	    assert.equal(messageRefFailureRouteResult.discordToKook.trackingRecovered, undefined);
	    const messageRefFailureKookMessageId = `kook_bridge_${beforeMessageRefFailureKookPosts + 1}`;
	    const messageRefFailureStore = await readStore();
	    assert.equal((messageRefFailureStore.integrationMessageRefs || []).some((ref) => (
	      ref.platform === 'kook' &&
	        ref.kind === 'discord_kook_bridge_message' &&
	        ref.messageId === messageRefFailureKookMessageId
	    )), false);
	    const messageRefFailureRoute = messageRefFailureStore.settings.discordKookBridge.routes.find((route) => route.id === primaryRoute.id);
	    assert.equal(messageRefFailureRoute.lastDiscordMessageId, messageRefFailureDiscordMessageId);

	    const aiRequestsBeforeTenor = aiRequests.length;
	    const kookPostsBeforeTenor = kookPosts.length;
    const kookAssetsBeforeTenor = kookAssets.length;
    primaryDiscordMessages.push({
      id: '100000000000000013',
      channel_id: '123456789012345679',
      content: 'https://tenor.com/view/spray-bottle-cat-spray-bottle-spray-bottle-meme-tiktok-gif-25591053',
      timestamp: '2026-06-18T00:19:00.000Z',
      mention_everyone: false,
      author: { id: 'discord_user_tenor', username: 'Erra', bot: false },
      embeds: [{
        type: 'gifv',
        url: 'https://tenor.com/view/spray-bottle-cat-spray-bottle-spray-bottle-meme-tiktok-gif-25591053',
        thumbnail: { url: `${process.env.NB_DISCORD_API_BASE_URL}/attachments/tenor-spray.gif` }
      }]
    });
    result = await request('/settings/discord-kook-bridge/sync', { method: 'POST', body: { routeId: primaryRoute.id } });
    assert.equal(result.response.status, 200);
    assert.equal(kookPosts.length, kookPostsBeforeTenor + 1);
    assert.equal(kookPosts.at(-1).query.type, '10');
    assert.equal(aiRequests.length, aiRequestsBeforeTenor);
    assert.equal(kookAssets.length, kookAssetsBeforeTenor + 1);
    const tenorBridgeCardJson = JSON.stringify(JSON.parse(kookPosts.at(-1).body.content));
    assert.match(tenorBridgeCardJson, /Discord · Primary/);
    assert.match(tenorBridgeCardJson, /https:\/\/img\.kook\.test\/assets\/3\.png/);
    assert.doesNotMatch(tenorBridgeCardJson, /tenor\.com\/view/);
    assert.doesNotMatch(tenorBridgeCardJson, /Erra:.*Erra:/s);

    const aiRequestsBeforeBrokenAsset = aiRequests.length;
    primaryDiscordMessages.push({
      id: '100000000000000014',
      channel_id: '123456789012345679',
      content: `${process.env.NB_DISCORD_API_BASE_URL}/attachments/expired-asset.gif`,
      timestamp: '2026-06-18T00:19:20.000Z',
      mention_everyone: false,
      author: { id: 'discord_user_broken_asset', username: 'AssetUser', bot: false },
      embeds: [{
        type: 'gifv',
        thumbnail: { url: `${process.env.NB_DISCORD_API_BASE_URL}/attachments/expired-asset.gif` }
      }]
    });
    result = await request('/settings/discord-kook-bridge/sync', { method: 'POST', body: { routeId: primaryRoute.id } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.result.errors, 0);
    assert.equal(result.payload.result.routes[0].discordToKook.skipped, 1);
    assert.equal(kookPosts.length, kookPostsBeforeTenor + 1);
    assert.equal(aiRequests.length, aiRequestsBeforeBrokenAsset);
    assert.equal(kookAssets.length, kookAssetsBeforeTenor + 1);
    result = await request('/settings/discord-kook-bridge');
    assert.equal(result.response.status, 200);
    const brokenAssetSkipRoute = result.payload.bridge.routes.find((route) => route.name === 'Primary');
    assert.equal(brokenAssetSkipRoute.lastDiscordMessageId, '100000000000000014');

    const aiRequestsBeforeSticker = aiRequests.length;
    primaryDiscordMessages.push({
      id: '100000000000000015',
      channel_id: '123456789012345679',
      content: '',
      timestamp: '2026-06-18T00:19:30.000Z',
      mention_everyone: false,
      author: { id: 'discord_user_sticker', username: 'StickerUser', bot: false },
      sticker_items: [{
        id: 'sticker_sus_cat',
        name: 'sus cat',
        format_type: 2
      }]
    });
    result = await request('/settings/discord-kook-bridge/sync', { method: 'POST', body: { routeId: primaryRoute.id } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.result.errors, 0);
    assert.equal(result.payload.result.routes[0].discordToKook.skipped, 1);
    assert.equal(kookPosts.length, kookPostsBeforeTenor + 1);
    assert.equal(aiRequests.length, aiRequestsBeforeSticker);
    result = await request('/settings/discord-kook-bridge');
    assert.equal(result.response.status, 200);
    const stickerSkipRoute = result.payload.bridge.routes.find((route) => route.name === 'Primary');
    assert.equal(stickerSkipRoute.lastDiscordMessageId, '100000000000000015');

    const aiRequestsBeforeSnapshot = aiRequests.length;
    primaryDiscordMessages.push({
      id: '100000000000000016',
      channel_id: '123456789012345679',
      content: '',
      timestamp: '2026-06-18T00:19:45.000Z',
      mention_everyone: false,
      flags: 16384,
      author: { id: 'discord_user_snapshot', username: 'SnapshotUser', bot: false },
      message_snapshots: [{
        message: {
          content: '',
          embeds: [{
            type: 'rich',
            title: 'Forwarded server alert',
            description: 'raid defense at main base'
          }],
          attachments: []
        }
      }]
    });
    result = await request('/settings/discord-kook-bridge/sync', { method: 'POST', body: { routeId: primaryRoute.id } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.result.errors, 0);
    assert.equal(result.payload.result.routes[0].discordToKook.forwarded, 1);
    assert.equal(kookPosts.length, kookPostsBeforeTenor + 2);
    assert.equal(aiRequests.length, aiRequestsBeforeSnapshot + 1);
    assert.match(kookPosts.at(-1).body.content, /Discord · Primary/);
    assert.match(kookPosts.at(-1).body.content, /SnapshotUser: Forwarded server alert\nraid defense at main base/);
    result = await request('/settings/discord-kook-bridge');
    assert.equal(result.response.status, 200);
    const snapshotRoute = result.payload.bridge.routes.find((route) => route.name === 'Primary');
    assert.equal(snapshotRoute.lastDiscordMessageId, '100000000000000016');

    primaryDiscordMessages.push({
      id: '100000000000000017',
      channel_id: '123456789012345679',
      content: '',
      timestamp: '2026-06-18T00:20:00.000Z',
      mention_everyone: false,
      author: { id: 'discord_user_4', username: 'DiscUser4', bot: false }
    });
    result = await request('/settings/discord-kook-bridge/sync', { method: 'POST', body: { routeId: primaryRoute.id } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.result.errors, 0);
    assert.equal(result.payload.result.routes[0].discordToKook.skipped, 1);
    assert.equal(kookPosts.length, kookPostsBeforeTenor + 2);
    result = await request('/settings/discord-kook-bridge');
    assert.equal(result.response.status, 200);
    const contentIntentRoute = result.payload.bridge.routes.find((route) => route.name === 'Primary');
    assert.equal(contentIntentRoute.lastDiscordMessageId, '100000000000000017');

    primaryDiscordMessages.push({
      id: '100000000000000018',
      channel_id: '123456789012345679',
      content: 'kook content rejected',
      timestamp: '2026-06-18T00:20:30.000Z',
      mention_everyone: false,
      author: { id: 'discord_user_rejected', username: 'RejectedUser', bot: false }
    });
    result = await request('/settings/discord-kook-bridge/sync', { method: 'POST', body: { routeId: primaryRoute.id } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.result.errors, 0);
    assert.equal(result.payload.result.routes[0].discordToKook.skipped, 1);
    assert.equal(kookPosts.length, kookPostsBeforeTenor + 2);
    result = await request('/settings/discord-kook-bridge');
    assert.equal(result.response.status, 200);
    const kookRejectedRoute = result.payload.bridge.routes.find((route) => route.name === 'Primary');
    assert.equal(kookRejectedRoute.lastDiscordMessageId, '100000000000000018');

    failingKookListChannels.add('kook_channel_123');
    primaryDiscordMessages.push({
      id: '100000000000000005',
      channel_id: '123456789012345679',
      content: 'discord should still bridge when kook fetch fails',
      timestamp: '2026-06-18T00:21:00.000Z',
      mention_everyone: false,
      author: { id: 'discord_user_5', username: 'DiscUser5', bot: false }
    });
    result = await request('/settings/discord-kook-bridge/sync', { method: 'POST', body: { routeId: primaryRoute.id } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.result.errors, 1);
    assert.match(result.payload.result.routes[0].kookToDiscord.error, /target object missing/);
    assert.equal(kookPosts.length, kookPostsBeforeTenor + 3);
    assert.equal(kookPosts.at(-1).query.target_id, 'kook_channel_123');
    assert.match(kookPosts.at(-1).body.content, /Discord · Primary/);
    assert.match(kookPosts.at(-1).body.content, /DiscUser5: discord should still bridge/);
    result = await request('/settings/discord-kook-bridge');
    assert.equal(result.response.status, 200);
    const partiallyFailedRoute = result.payload.bridge.routes.find((route) => route.name === 'Primary');
    assert.equal(partiallyFailedRoute.lastDiscordMessageId, '100000000000000005');
    assert.match(partiallyFailedRoute.lastSyncError, /KOOK→Discord/);
    failingKookListChannels.clear();

    const primaryKookMessages = kookMessages('kook_channel_123');
    primaryKookMessages.splice(primaryKookMessages.findIndex((message) => message.id === 'kook_user_2'), 1);
    result = await request('/settings/discord-kook-bridge/sync', { method: 'POST', body: { routeId: primaryRoute.id } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.result.routes[0].kookToDiscord.forwarded, 0);
    assert.equal(discordPosts.length, 1);

    primaryKookMessages.push({
      id: 'kook_user_3',
	      type: 2,
	      content: 'https://img.example.com/kook-user-3.png',
	      mention_all: false,
	      create_at: Date.UTC(2026, 5, 18, 0, 14),
      author: { id: 'kook_user_1', username: 'KookUser', bot: false }
    });
    result = await request('/settings/discord-kook-bridge/sync', { method: 'POST', body: { routeId: primaryRoute.id } });
    assert.equal(result.response.status, 200);
    assert.equal(discordPosts.length, 2);
    assert.match(discordPosts[1].body.content, /KOOK · Primary/);
    assert.doesNotMatch(discordPosts[1].body.content, /https:\/\/img\.example\.com\/kook-user-3\.png/);
    assert.deepEqual(discordPosts[1].body.embeds, [{ color: 0x2563eb, image: { url: 'https://img.example.com/kook-user-3.png' } }]);
    assert.doesNotMatch(aiRequests.at(-1).body.messages.at(-1).content, /https:\/\/img\.example\.com\/kook-user-3\.png/);

    primaryKookMessages.push({
      id: 'kook_user_4',
      type: 10,
      content: JSON.stringify([{
        type: 'card',
        theme: 'info',
        modules: [{
          type: 'section',
          text: { type: 'kmarkdown', content: 'KOOK 图片卡片' }
        }, {
          type: 'container',
          elements: [{
            type: 'image',
            src: 'https://img.example.com/kook-card.png',
            alt: 'kook card image',
            size: 'lg',
            circle: false
          }, {
            type: 'image',
            src: 'https://img.example.com/kook-card-second.png',
            alt: 'second kook card image',
            size: 'lg',
            circle: false
          }]
        }]
	      }]),
	      mention_all: false,
	      create_at: Date.UTC(2026, 5, 18, 0, 14, 30),
      author: { id: 'kook_user_1', username: 'KookUser', bot: false }
    });
    result = await request('/settings/discord-kook-bridge/sync', { method: 'POST', body: { routeId: primaryRoute.id } });
    assert.equal(result.response.status, 200);
    assert.equal(discordPosts.length, 3);
    assert.match(discordPosts[2].body.content, /KookUser: KOOK 图片卡片/);
    assert.doesNotMatch(discordPosts[2].body.content, /https:\/\/img\.example\.com\/kook-card/);
    assert.deepEqual(discordPosts[2].body.embeds, [
      { color: 0x2563eb, image: { url: 'https://img.example.com/kook-card.png' } },
      { color: 0x2563eb, image: { url: 'https://img.example.com/kook-card-second.png' } }
    ]);
    assert.doesNotMatch(aiRequests.at(-1).body.messages.at(-1).content, /https:\/\/img\.example\.com\/kook-card/);

    primaryKookMessages.push({
      id: 'kook_loop_from_discord',
	      type: 9,
	      content: 'Discord · Primary\n\nDiscUser: loop candidate\n\nDiscUser: 循环候选',
	      mention_all: false,
	      create_at: Date.UTC(2026, 5, 18, 0, 15),
      author: { id: 'kook_user_1', username: 'KookUser', bot: false }
    });
    result = await request('/settings/discord-kook-bridge/sync', { method: 'POST', body: { routeId: primaryRoute.id } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.result.routes[0].kookToDiscord.forwarded, 0);
    assert.equal(discordPosts.length, 3);

    primaryDiscordMessages.push({
      id: '100000000000000006',
      channel_id: '123456789012345679',
      content: 'KOOK · Primary\n\nKookUser: loop candidate\n\nKookUser: 循环候选',
      timestamp: '2026-06-18T00:22:00.000Z',
      mention_everyone: false,
      author: { id: 'discord_user_6', username: 'DiscUser6', bot: false }
    });
    result = await request('/settings/discord-kook-bridge/sync', { method: 'POST', body: { routeId: primaryRoute.id } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.result.routes[0].discordToKook.forwarded, 0);
    assert.equal(kookPosts.length, kookPostsBeforeTenor + 3);

    primaryKookMessages.push({
      id: 'kook_duplicate_once',
	      type: 9,
	      content: '重复 ID 只转一次',
	      mention_all: false,
	      create_at: Date.UTC(2026, 5, 18, 0, 16),
      author: { id: 'kook_user_1', username: 'KookUser', bot: false }
    }, {
      id: 'kook_duplicate_once',
	      type: 9,
	      content: '重复 ID 只转一次',
	      mention_all: false,
	      create_at: Date.UTC(2026, 5, 18, 0, 16),
      author: { id: 'kook_user_1', username: 'KookUser', bot: false }
    });
    result = await request('/settings/discord-kook-bridge/sync', { method: 'POST', body: { routeId: primaryRoute.id } });
    assert.equal(result.response.status, 200);
	    assert.equal(result.payload.result.routes[0].kookToDiscord.forwarded, 1);
	    assert.equal(discordPosts.length, 4);
	    assert.match(discordPosts[3].body.content, /重复 ID 只转一次/);

    const beforeDoubleRouteFailureKookPosts = kookPosts.length;
    const aiRequestsBeforeDoubleRouteFailure = aiRequests.length;
    const doubleRouteFailureDiscordMessageId = '100000000000000021';
    const secondaryDiscordMessages = discordMessages('123456789012345680');
    secondaryDiscordMessages.push({
      id: doubleRouteFailureDiscordMessageId,
      channel_id: '123456789012345680',
      content: 'double route tracking failure',
      timestamp: '2026-06-18T00:38:00.000Z',
      mention_everyone: false,
      author: { id: 'discord_user_double_route_failure', username: 'DoubleRouteUser', bot: false }
    });
    repositoryModule.injectSqliteStorePatchFailureForTests('discord_kook_bridge_route_state', 2);
    result = await request('/settings/discord-kook-bridge/sync', { method: 'POST', body: { routeId: secondRoute.id } });
    assert.equal(result.response.status, 200);
    assert.equal(kookPosts.length, beforeDoubleRouteFailureKookPosts + 1, JSON.stringify(result.payload.result));
    assert.equal(result.payload.result.errors, 1);
    assert.equal(result.payload.result.operationRun.status, 'failed');
    assert.equal(result.payload.result.operationRun.metadata.externalActionSucceeded, 'true');
    assert.equal(result.payload.result.operationRun.metadata.trackingWriteFailed, 'true');
    assert.match(result.payload.result.operationRun.metadata.trackingWriteError, /Injected sqlite patch failure for discord_kook_bridge_route_state/);
    const doubleRouteFailureKookMessageId = `kook_bridge_${beforeDoubleRouteFailureKookPosts + 1}`;
    const doubleRouteFailureStore = await readStore();
    const doubleRouteFailureRef = (doubleRouteFailureStore.integrationMessageRefs || []).find((ref) => (
      ref.platform === 'kook' &&
        ref.kind === 'discord_kook_bridge_message' &&
        ref.messageId === doubleRouteFailureKookMessageId
    ));
    assert.ok(doubleRouteFailureRef);
    assert.equal(doubleRouteFailureRef.metadata.sourceMessageId, doubleRouteFailureDiscordMessageId);
    const doubleRouteFailureRoute = doubleRouteFailureStore.settings.discordKookBridge.routes.find((route) => route.id === secondRoute.id);
    assert.notEqual(doubleRouteFailureRoute.lastDiscordMessageId, doubleRouteFailureDiscordMessageId);

    result = await request('/settings/discord-kook-bridge/sync', { method: 'POST', body: { routeId: secondRoute.id } });
    assert.equal(result.response.status, 200);
    assert.equal(kookPosts.length, beforeDoubleRouteFailureKookPosts + 1, JSON.stringify(result.payload.result));
    assert.equal(aiRequests.length, aiRequestsBeforeDoubleRouteFailure + 1);
    assert.equal(result.payload.result.errors, 0, JSON.stringify(result.payload.result));
    assert.equal(result.payload.result.operationRun.status, 'succeeded');
    assert.equal(result.payload.result.routes[0].discordToKook.forwarded, 0);
    assert.equal(result.payload.result.routes[0].discordToKook.skipped, 1);
    assert.equal(result.payload.result.routes[0].discordToKook.duplicateSourceMessageRefSkipped, 1);
    const doubleRouteRecoveredStore = await readStore();
    const doubleRouteRecoveredRoute = doubleRouteRecoveredStore.settings.discordKookBridge.routes.find((route) => route.id === secondRoute.id);
    assert.equal(doubleRouteRecoveredRoute.lastDiscordMessageId, doubleRouteFailureDiscordMessageId);

	    result = await request('/settings/discord-kook-bridge', {
	      method: 'PUT',
	      body: {
        enabled: true,
        routes: [{
          id: primaryRoute.id,
          name: 'Primary moved',
          enabled: true,
          discordGuildId: '123456789012345682',
          discordChannelId: '123456789012345683',
          kookChannelId: 'kook_channel_789',
          kookAccessTokenConfigured: true
        }]
      }
    });
    assert.equal(result.response.status, 200);
    const movedRoute = result.payload.bridge.routes.find((route) => route.id === primaryRoute.id);
    assert.equal(movedRoute.lastDiscordMessageId, '');
    assert.equal(movedRoute.lastKookMessageId, '');
    assert.equal(movedRoute.lastKookMessageAt, '');
    assert.equal(movedRoute.lastForwardedDiscordMessageId, '');
    assert.equal(movedRoute.lastForwardedKookMessageId, '');
    const storeSnapshot = await readStore();
    const storedMovedRoute = storeSnapshot.settings.discordKookBridge.routes.find((route) => route.id === primaryRoute.id);
    assert.deepEqual(storedMovedRoute.recentMessageIds, []);
    assert.equal(storedMovedRoute.kookAccessToken, 'kook_pipe_token_primary_123');

    result = await request('/settings/discord-kook-bridge', {
      method: 'PUT',
      body: {
        enabled: true,
        routes: [{
          id: primaryRoute.id,
          name: 'Primary one-way',
          enabled: true,
          discordGuildId: '123456789012345682',
          discordChannelId: '123456789012345683',
          kookChannelId: 'kook_channel_789',
          clearKookAccessToken: true
        }]
      }
    });
    assert.equal(result.response.status, 200);
    const oneWayRoute = result.payload.bridge.routes.find((route) => route.id === primaryRoute.id);
    assert.equal(oneWayRoute.kookAccessTokenConfigured, false);
    assert.equal(oneWayRoute.configured, true);
    assert.equal(oneWayRoute.discordToKookConfigured, false);
    assert.equal(oneWayRoute.kookToDiscordConfigured, true);

    kookMessages('kook_channel_789').push({
      id: 'kook_seed_789',
      type: 9,
      content: 'seed moved',
      mention_all: false,
      create_at: Date.UTC(2026, 5, 18, 0, 30),
      author: { id: 'kook_user_seed_789', username: 'Seed789', bot: false }
    });
    result = await request('/settings/discord-kook-bridge/sync', { method: 'POST', body: { routeId: primaryRoute.id } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.result.initialized, true);
    assert.equal(result.payload.result.routes[0].discordToKook.disabledReason, 'missing_kook_access_token');
    assert.equal(discordPosts.length, 4);

    kookMessages('kook_channel_789').push({
      id: 'kook_one_way_to_discord',
      type: 9,
      content: '无 Pipe Token 也应该同步到 Discord',
      mention_all: false,
      create_at: Date.UTC(2026, 5, 18, 0, 31),
      author: { id: 'kook_user_789', username: 'KookOnlyUser', bot: false }
    });
    result = await request('/settings/discord-kook-bridge/sync', { method: 'POST', body: { routeId: primaryRoute.id } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.result.routes[0].kookToDiscord.forwarded, 1);
    assert.equal(discordPosts.length, 5);
    assert.equal(discordPosts[4].channelId, '123456789012345683');
    assert.match(discordPosts[4].body.content, /无 Pipe Token 也应该同步到 Discord/);

    const contextDiscordChannelId = '123456789012345684';
    const contextKookChannelId = 'kook_channel_context';
    discordMessages(contextDiscordChannelId).push({
      id: '100000000000000100',
      channel_id: contextDiscordChannelId,
      content: 'context seed',
      timestamp: '2026-06-18T00:40:00.000Z',
      mention_everyone: false,
      author: { id: 'discord_user_context_seed', username: 'ContextSeed', bot: false }
    });
    kookMessages(contextKookChannelId).push({
      id: 'kook_context_seed',
      type: 9,
      content: 'context seed',
      mention_all: false,
      create_at: Date.UTC(2026, 5, 18, 0, 40),
      author: { id: 'kook_user_context_seed', username: 'ContextSeed', bot: false }
    });
    result = await request('/settings/discord-kook-bridge', {
      method: 'PUT',
      body: {
        enabled: true,
        routes: [{
          name: 'Context',
          enabled: true,
          discordGuildId: '123456789012345682',
          discordChannelId: contextDiscordChannelId,
          kookChannelId: contextKookChannelId,
          kookAccessToken: 'kook_pipe_token_context_123'
        }]
      }
    });
    assert.equal(result.response.status, 200);
    const contextRoute = result.payload.bridge.routes.find((route) => route.name === 'Context');
    assert.ok(contextRoute?.id);
    result = await request('/settings/discord-kook-bridge/sync', { method: 'POST', body: { routeId: contextRoute.id } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.result.initialized, true);

    const discordContextAiStart = aiRequests.length;
    discordMessages(contextDiscordChannelId).push({
      id: '100000000000000101',
      channel_id: contextDiscordChannelId,
      content: 'bring rockets to raid base',
      timestamp: '2026-06-18T00:41:00.000Z',
      mention_everyone: false,
      author: { id: 'discord_user_context_1', username: 'ContextD1', bot: false }
    }, {
      id: '100000000000000102',
      channel_id: contextDiscordChannelId,
      content: 'counter raid from north',
      timestamp: '2026-06-18T00:42:00.000Z',
      mention_everyone: false,
      author: { id: 'discord_user_context_2', username: 'ContextD2', bot: false }
    }, {
      id: '100000000000000103',
      channel_id: contextDiscordChannelId,
      content: 'seal the TC after raid',
      timestamp: '2026-06-18T00:43:00.000Z',
      mention_everyone: false,
      author: { id: 'discord_user_context_3', username: 'ContextD3', bot: false }
    }, {
      id: '100000000000000104',
      channel_id: contextDiscordChannelId,
      content: 'depot sulfur and HQM',
      timestamp: '2026-06-18T00:44:00.000Z',
      mention_everyone: false,
      author: { id: 'discord_user_context_4', username: 'ContextD4', bot: false }
    }, {
      id: '100000000000000105',
      channel_id: contextDiscordChannelId,
      content: 'join voice for defense',
      timestamp: '2026-06-18T00:45:00.000Z',
      mention_everyone: false,
      author: { id: 'discord_user_context_5', username: 'ContextD5', bot: false }
    });
    result = await request('/settings/discord-kook-bridge/sync', { method: 'POST', body: { routeId: contextRoute.id } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.result.routes[0].discordToKook.forwarded, 5);
    const discordContextPrompt = aiRequests
      .slice(discordContextAiStart)
      .map((requestBody) => requestBody.body.messages.at(-1).content)
      .find((prompt) => /Target language:\s*Simplified Chinese/i.test(prompt) && /Message to translate:\s*seal the TC after raid/i.test(prompt));
    assert.ok(discordContextPrompt);
    assert.match(discordContextPrompt, /Previous messages:[\s\S]*\[-2\] ContextD1: bring rockets to raid base/);
    assert.match(discordContextPrompt, /Previous messages:[\s\S]*\[-1\] ContextD2: counter raid from north/);
    assert.match(discordContextPrompt, /Next messages:[\s\S]*\[\+1\] ContextD4: depot sulfur and HQM/);
    assert.match(discordContextPrompt, /Next messages:[\s\S]*\[\+2\] ContextD5: join voice for defense/);
    assert.doesNotMatch(discordContextPrompt, /context seed/);

    const kookContextAiStart = aiRequests.length;
    kookMessages(contextKookChannelId).push({
      id: 'kook_context_1',
      type: 9,
      content: '带火箭去 raid base',
      mention_all: false,
      create_at: Date.UTC(2026, 5, 18, 0, 51),
      author: { id: 'kook_user_context_1', username: 'ContextK1', bot: false }
    }, {
      id: 'kook_context_2',
      type: 9,
      content: '北边有人 counter',
      mention_all: false,
      create_at: Date.UTC(2026, 5, 18, 0, 52),
      author: { id: 'kook_user_context_2', username: 'ContextK2', bot: false }
    }, {
      id: 'kook_context_3',
      type: 9,
      content: '封 TC',
      mention_all: false,
      create_at: Date.UTC(2026, 5, 18, 0, 53),
      author: { id: 'kook_user_context_3', username: 'ContextK3', bot: false }
    }, {
      id: 'kook_context_4',
      type: 9,
      content: '存硫磺和高金',
      mention_all: false,
      create_at: Date.UTC(2026, 5, 18, 0, 54),
      author: { id: 'kook_user_context_4', username: 'ContextK4', bot: false }
    }, {
      id: 'kook_context_5',
      type: 9,
      content: '进语音防守',
      mention_all: false,
      create_at: Date.UTC(2026, 5, 18, 0, 55),
      author: { id: 'kook_user_context_5', username: 'ContextK5', bot: false }
    });
    result = await request('/settings/discord-kook-bridge/sync', { method: 'POST', body: { routeId: contextRoute.id } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.result.routes[0].kookToDiscord.forwarded, 5);
    const kookContextPrompt = aiRequests
      .slice(kookContextAiStart)
      .map((requestBody) => requestBody.body.messages.at(-1).content)
      .find((prompt) => /Target language:\s*English/i.test(prompt) && /Message to translate:\s*封 TC/i.test(prompt));
    assert.ok(kookContextPrompt);
    assert.match(kookContextPrompt, /Previous messages:[\s\S]*\[-2\] ContextK1: 带火箭去 raid base/);
    assert.match(kookContextPrompt, /Previous messages:[\s\S]*\[-1\] ContextK2: 北边有人 counter/);
    assert.match(kookContextPrompt, /Next messages:[\s\S]*\[\+1\] ContextK4: 存硫磺和高金/);
    assert.match(kookContextPrompt, /Next messages:[\s\S]*\[\+2\] ContextK5: 进语音防守/);
    assert.doesNotMatch(kookContextPrompt, /context seed/);

  } finally {
    if (apiServer) await new Promise((resolve) => apiServer.close(resolve));
    await new Promise((resolve) => discordServer.close(resolve));
    await new Promise((resolve) => kookServer.close(resolve));
    await new Promise((resolve) => aiServer.close(resolve));
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
