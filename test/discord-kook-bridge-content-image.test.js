import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

test('discord-kook bridge treats Discord CDN image-only content as one image card', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-discord-kook-content-image-'));
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISCORD_SEND_INTERVAL_MS = '0';
  process.env.NB_DISCORD_KOOK_BRIDGE_BATCH_LIMIT = '10';
  process.env.NODE_ENV = 'production';
  delete process.env.NB_COOKIE_SECURE;

  const discordChannelId = '1472526453491896469';
  const kookChannelId = '1482090658230702131';
  const discordMessages = [{
    id: '100000000000000001',
    channel_id: discordChannelId,
    content: 'seed',
    timestamp: '2026-06-25T00:00:00.000Z',
    mention_everyone: false,
    author: { id: 'discord_seed', username: 'Seed', bot: false }
  }];

  const discordApp = express();
  discordApp.use(express.json());
  discordApp.get('/channels/:channelId/messages', (req, res) => {
    const after = String(req.query.after || '');
    const afterIndex = after ? discordMessages.findIndex((message) => message.id === after) : -1;
    const items = after ? discordMessages.slice(afterIndex + 1) : discordMessages.slice(-1);
    res.json(items.slice().reverse());
  });
  discordApp.get('/attachments/pure-image.gif', (_req, res) => {
    res.type('image/gif').send(Buffer.from('GIF89a'));
  });
  const discordServer = createServer(discordApp);
  await new Promise((resolve) => discordServer.listen(0, '127.0.0.1', resolve));
  process.env.NB_DISCORD_API_BASE_URL = `http://127.0.0.1:${discordServer.address().port}`;

  const kookPosts = [];
  const kookAssets = [];
  const kookMessages = [];
  const kookApp = express();
  kookApp.use(express.json());
  kookApp.get('/api/v3/message/list', (_req, res) => {
    res.json({ code: 0, message: '操作成功', data: { items: kookMessages.slice().reverse() } });
  });
  kookApp.post('/api/v3/message/send-pipemsg', (req, res) => {
    const id = `kook_bridge_${kookPosts.length + 1}`;
    const content = req.body?.content || '';
    kookPosts.push({ query: req.query, body: req.body });
    kookMessages.push({
      id,
      type: Number(req.query.type || 9),
      content,
      create_at: Date.UTC(2026, 5, 25, 0, 1 + kookPosts.length),
      author: { id: 'kook_bot', username: 'NB Bridge', bot: true }
    });
    res.json({ code: 0, message: '操作成功', data: { msg_id: id } });
  });
  kookApp.post('/api/v3/asset/create', (req, res) => {
    kookAssets.push({
      authorization: req.get('authorization') || '',
      contentType: req.get('content-type') || ''
    });
    res.json({ code: 0, message: '操作成功', data: { url: `https://img.kook.test/assets/${kookAssets.length}.gif` } });
  });
  const kookServer = createServer(kookApp);
  await new Promise((resolve) => kookServer.listen(0, '127.0.0.1', resolve));
  process.env.NB_KOOK_API_BASE_URL = `http://127.0.0.1:${kookServer.address().port}/api/v3`;

  const aiRequests = [];
  const aiApp = express();
  aiApp.use(express.json());
  aiApp.post('/v1/chat/completions', (req, res) => {
    aiRequests.push(req.body);
    res.json({ choices: [{ message: { content: 'translated' } }] });
  });
  const aiServer = createServer(aiApp);
  await new Promise((resolve) => aiServer.listen(0, '127.0.0.1', resolve));
  process.env.NB_TRANSLATION_API_BASE_URL = `http://127.0.0.1:${aiServer.address().port}/v1`;

  let apiServer = null;
  try {
    const { createApiRouter } = await import('../server/api.js');
    const { ensureStore } = await import('../server/store.js');
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
      return { response, payload: await response.json() };
    }

    let result = await request('/auth/login', { method: 'POST', body: { username: 'root', password: 'RootPass123!' } });
    assert.equal(result.response.status, 200);
    result = await request('/settings/discord', {
      method: 'PUT',
      body: {
        botToken: 'discord_bot_token_123456789012345',
        targets: [{
          id: 'default',
          name: 'Chat SYNC',
          guildId: '1472526453491896468',
          channelId: discordChannelId
        }]
      }
    });
    assert.equal(result.response.status, 200);
    result = await request('/settings/kook', {
      method: 'PUT',
      body: {
        botToken: 'kook_bot_token_1234567890',
        guildId: '1482090658230702130',
        channelId: kookChannelId
      }
    });
    assert.equal(result.response.status, 200);
    result = await request('/settings/discord-kook-bridge', {
      method: 'PUT',
      body: {
        enabled: true,
        translationApiKey: 'translation_key_1234567890',
        translationBaseUrl: process.env.NB_TRANSLATION_API_BASE_URL,
        translationModel: 'gpt-5.4-mini',
        pollIntervalSeconds: 3,
        routes: [{
          name: 'Chat SYNC',
          enabled: true,
          discordGuildId: '1472526453491896468',
          discordChannelId,
          kookChannelId,
          kookAccessToken: 'kook_pipe_token_content_image_123'
        }]
      }
    });
    assert.equal(result.response.status, 200);

    result = await request('/settings/discord-kook-bridge/sync', { method: 'POST', body: {} });
    assert.equal(result.response.status, 200);
    assert.equal(kookPosts.length, 0);

    const gifUrl = `${process.env.NB_DISCORD_API_BASE_URL}/attachments/pure-image.gif`;
    discordMessages.push({
      id: '100000000000000002',
      channel_id: discordChannelId,
      content: `${gifUrl}\n${gifUrl}`,
      timestamp: '2026-06-25T00:02:00.000Z',
      mention_everyone: false,
      author: { id: 'discord_user_bober', username: 'Bober', bot: false }
    });

    result = await request('/settings/discord-kook-bridge/sync', { method: 'POST', body: {} });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.result.discordToKook.forwarded, 1);
    assert.equal(kookAssets.length, 1);
    assert.equal(kookAssets[0].authorization, 'Bot kook_bot_token_1234567890');
    assert.equal(kookPosts.length, 1);
    assert.equal(kookPosts[0].query.type, '10');
    const cardJson = JSON.stringify(JSON.parse(kookPosts[0].body.content));
    assert.match(cardJson, /Discord · Chat SYNC/);
    assert.match(cardJson, /Bober:/);
    assert.match(cardJson, /https:\/\/img\.kook\.test\/assets\/1\.gif/);
    assert.doesNotMatch(cardJson, /pure-image\.gif/);
    assert.equal(aiRequests.length, 0);

    result = await request('/settings/discord-kook-bridge/sync', { method: 'POST', body: {} });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.result.discordToKook.forwarded, 0);
    assert.equal(kookPosts.length, 1);
  } finally {
    if (apiServer) await new Promise((resolve) => apiServer.close(resolve));
    await new Promise((resolve) => discordServer.close(resolve));
    await new Promise((resolve) => kookServer.close(resolve));
    await new Promise((resolve) => aiServer.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
