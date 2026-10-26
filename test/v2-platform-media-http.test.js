import './support/results.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { mkdtemp, mkdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fixture, upload, png, defer, response } from './support/v2-platform-media/fixtures.mjs';
import { installPlatformAdminSchema } from '../server/v2/platform-admin/repository.js';
import { createMiniProgramAdapter } from '../server/v2/platform-admin/mini-program.js';
import { createMiniProgramRouter } from '../server/v2/platform-admin/routes.js';
import { createPlatformMediaRouter } from '../server/v2/platform-media/routes.js';
import { createPlatformMediaDomainAdapters } from '../server/v2/platform-media/index.js';

test('fresh disk SQLite + real mini sessions: JSON command vs real bytes, header separation, revocation and parse errors', async () => {
  const runtime = fileURLToPath(new URL('./support/v2-platform-media/.runtime/', import.meta.url));
  await mkdir(runtime, { recursive: true }); const directory = await mkdtemp(path.join(runtime, 'run-'));
  const f = fixture({ file: path.join(directory, 'media.sqlite') }); installPlatformAdminSchema(f.db);
  let waiting = false; const entered = defer(), release = defer();
  const owner = f.owner('appA', { exchangeCode: async () => { if (waiting) { entered.resolve(); await release.promise; } return response(); } });
  const mini = createMiniProgramAdapter({ identity: f.identity, scheduling: f.memberSpace.scheduling, appId: 'appA',
    readConfig: () => f.configs.appA, exchangeCode: async ({ appId, code }) => ({ verified: true, appId, openid: `open_${code}` }) });
  const { token } = await mini.login({ code: 'alpha' });
  const { token: foreignToken } = await mini.login({ code: 'foreign' });
  const profile = createPlatformMediaDomainAdapters(owner).profile;
  const commands = { ...mini, command: async (envelope, command, input) => {
    const method = { avatar: 'avatar', avatar_image: 'avatarImage', share_code: 'shareCode' }[command];
    const { actor } = mini.authenticate(envelope);
    return profile[method]({ actor, input, operationId: envelope.operationId,
      assertCurrent: () => mini.authenticate(envelope).actor,
      subject: () => { const { actor, session } = mini.authenticate(envelope); return { verified: true, accountId: actor.id, appId: session.appId, externalId: session.externalId }; } });
  } };
  const app = express();
  app.use('/api/v2', createPlatformMediaRouter({ owner, authenticate: mini.authenticate }));
  app.use('/api', createPlatformMediaRouter({ owner, authenticate: mini.authenticate, legacy: true }));
  app.use('/api/v2', createMiniProgramRouter({ adapter: commands }));
  app.use('/api/wechat', (_req, res) => res.status(410).json({ retired: true }));
  const server = http.createServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`, auth = { Authorization: `Bearer ${token}` }, checks = [];
  const get = (url, headers = auth) => fetch(origin + url, { headers });
  const post = (url, input, headers = auth) => fetch(origin + url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'Idempotency-Key': 'http-avatar-operation' }, body: JSON.stringify(input) });
  try {
    const tables = f.db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all();
    let r = await get('/api/v2/platform-media/avatar'); assert.equal(r.status, 200); assert.equal((await r.json()).data.revision, 0);
    r = await get('/api/v2/platform-media/avatar', { Cookie: `nb_v2_session=${token}` }); assert.equal(r.status, 401);
    r = await get('/api/wechat/avatar', auth); assert.equal(r.status, 401);
    r = await post('/api/v2/platform-media/avatar', upload()); assert.equal(r.status, 200); assert.equal((await r.json()).data.current.revision, 1);
    r = await get('/api/v2/platform-media/avatar-image'); assert.equal(r.status, 200); assert.equal(r.headers.get('Content-Type'), 'image/png'); assert.equal(r.headers.get('Cache-Control'), 'private, no-store');
    const image = Buffer.from(await r.arrayBuffer()); assert.deepEqual(image, png);
    await writeFile(new URL('../output/test-results/g07-platform-media/http-avatar.png', import.meta.url), image);
    checks.push('real_avatar_bytes');
    r = await get('/api/wechat/avatar-image', { 'x-nb-wechat-session': token }); assert.equal(r.status, 200); assert.deepEqual(Buffer.from(await r.arrayBuffer()), png);
    r = await get('/api/v2/platform-media/avatar-image?memberId=g05_alpha', { Authorization: `Bearer ${foreignToken}` }); assert.equal(r.status, 403);
    r = await get('/api/v2/platform-media/avatar-image?src=https://127.0.0.1/x'); assert.equal(r.status, 422);
    r = await post('/api/v2/mini-program/commands/share_code', { metric: 'kd' }); assert.equal(r.status, 200);
    const json = (await r.json()).data; assert.equal(json.kind, 'share_code'); assert.equal(json.base64, undefined); assert.equal(json.bytes, undefined);
    r = await get('/api/v2/platform-media/share-code?metric=kd'); assert.equal(r.status, 200); assert.deepEqual(Buffer.from(await r.arrayBuffer()), png);
    r = await get('/api/wechat/share-code?metric=kd', { 'x-nb-wechat-session': token }); assert.equal(r.status, 200); await r.arrayBuffer();
    r = await fetch(origin + '/api/v2/platform-media/avatar', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{broken' }); assert.equal(r.status, 422);
    assert.deepEqual(f.db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(), tables);
    checks.push('legacy_bytes_not_json', 'json_metadata_not_base64', 'cookie_rejected', 'cross_member_denied', 'arbitrary_url_rejected', 'get_schema_unchanged');
    waiting = true;
    const late = get('/api/v2/platform-media/share-code?metric=rockets'); await entered.promise;
    mini.logout({ token }); release.resolve(); r = await late; assert.equal(r.status, 401);
    assert.equal((await r.json()).error.errorCode, 'MINI_SESSION_INVALID'); checks.push('real_session_logout_fences_inflight');
    await owner.stop(); assert.equal(f.db.prepare('SELECT 1 n').get().n, 1);
    await writeFile(new URL('../output/test-results/g07-platform-media/http.json', import.meta.url), JSON.stringify({ checks, realPlatformAuthentication: false,
      authentication: 'real mini-session persistence, explicitly isolated exchange proof', loopbackOnly: true,
      freshDiskSqlite: true, sqliteQuickCheck: f.db.prepare('PRAGMA quick_check').get(), mediaWrites: f.state.writes, ownerActiveAfterStop: owner.diagnostics().active }, null, 2) + '\n');
  } finally {
    release.resolve(); await owner.stop(); server.closeAllConnections(); await new Promise(r => server.close(r)); await f.close();
    await rm(directory, { recursive: true, force: true }); await rmdir(runtime);
  }
});
