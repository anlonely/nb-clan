import { authenticatedSession } from './support/authenticated-session.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createIdentityRouter } from '../server/v2/identity/routes.js';
import { createPlatformAdminRouter } from '../server/v2/platform-admin/routes.js';
import { PlatformAdminService } from '../server/v2/platform-admin/service.js';
import { IdentityService } from '../server/v2/identity/service.js';
import { IdentityRepository } from '../server/v2/identity/repository.js';
import { createPlatformConfigReaders } from '../server/v2/management-adapters/platform-config/index.js';
import { fixture } from './support/v2-platform-config/fixture.mjs';

test('loopback G03 configuration/secrets API persists one revision source and all readers observe committed state after reopening SQLite', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'nb-platform-config-')), filename = join(directory, 'config.sqlite');
  const f = await fixture({ filename }), app = express(), server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, auth = createIdentityRouter({ service: f.identity, origin, providers: {} });
  // Exercise the actual service/HTTP authority with the existing root-style
  // queue + post-commit callback; production runtime source is unchanged.
  const routedService = Object.create(f.platformService);
  for (const method of ['save', 'secrets']) routedService[method] = (actor, id, input, options) =>
    f.runStoreWriteTask(() => { const result = f.platformService[method](actor, id, input, options); if (id === 'wechat') f.notify(result.revision); return result; });
  app.use('/api/v2', f.host.miniRouter);
  app.use('/api/v2', (req, res, next) => { req.v2Identity = { service: f.identity, authenticate: options => auth.authenticate(options)(req) }; next(); });
  app.use('/api/v2', createPlatformAdminRouter({ getSystem: () => ({ service: routedService }) }));
  t.after(async () => { await auth.stopEvents(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await f.close(); rmSync(directory, { recursive: true, force: true }); });
  const session = await authenticatedSession(f.identity, 'admin');
  const request = async (path, { body, authenticated = true, csrf = true, operationId = randomUUID() } = {}) => {
    const result = await fetch(origin + '/api/v2' + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': operationId,
        ...(authenticated ? { Cookie: `nb_v2_session=${session.token}`, ...(csrf ? { 'X-CSRF-Token': session.csrfToken } : {}) } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: result.status, body: await result.json(), cache: result.headers.get('cache-control') };
  };
  const map = { wipeOpen: 'open_http_template' };
  const body = { expectedRevision: 1, config: { subscriptionTemplates: map } };
  assert.equal((await request('/platform-admin/wechat/config', { body, authenticated: false })).status, 401);
  assert.equal((await request('/platform-admin/wechat/config', { body, csrf: false })).status, 403);
  const mini = await f.login();
  const saved = await request('/platform-admin/wechat/config', { body, operationId: 'http-config-one' });
  assert.equal(saved.status, 200, JSON.stringify(saved)); assert.equal(saved.body.data.revision, 2);
  assert.equal(f.readers.readInbox().subscriptionTemplates.wipeOpen, 'open_http_template');
  assert.throws(() => f.host.mini.authenticate(mini), { errorCode: 'MINI_SESSION_INVALID' });
  const replay = await request('/platform-admin/wechat/config', { body, operationId: 'http-config-one' }); assert.equal(replay.body.data.revision, 2);
  const bad = await request('/platform-admin/wechat/config', { body: { expectedRevision: 2, config: { subscriptionTemplates: { nonexistent: 'bad' } } } });
  assert.equal(bad.status, 422); assert.equal(f.readers.readMedia().generation, 2);
  const secret = 'constructed-http-vault-value';
  const input = { expectedRevision: 2, values: { appSecret: secret } };
  const rotated = await request('/platform-admin/wechat/secrets', { body: input, operationId: 'http-secret-one' });
  assert.equal(rotated.status, 200); assert.equal(rotated.body.data.revision, 3);
  const repeated = await request('/platform-admin/wechat/secrets', { body: input, operationId: 'http-secret-one' });
  assert.equal(repeated.body.data.revision, 3); assert.equal(f.state.vaultWrites, 1);
  const beforeGet = f.db.prepare('SELECT total_changes() n').get().n, detail = await request('/platform-admin/wechat');
  assert.equal(detail.status, 200); assert.equal(detail.cache, 'no-store'); assert.ok(!JSON.stringify(detail.body).includes(secret));
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, beforeGet);
  const observer = new DatabaseSync(filename);
  try {
    const identity = new IdentityService(new IdentityRepository(observer), { now: f.now }), service = new PlatformAdminService({ identity });
    const reopened = createPlatformConfigReaders({ platformService: service, appId: 'host_app' });
    assert.equal(reopened.readMini().revision, 3);
    assert.equal(reopened.readMedia().generation, 3); assert.equal(reopened.readInbox().revision, 3);
    assert.equal(reopened.readInbox().subscriptionTemplates.joinReviewResult, map.joinReviewResult);
    assert.equal(observer.prepare("SELECT count(*) n FROM platform_admin_records WHERE kind='config' AND id='wechat'").get().n, 1);
    assert.equal(observer.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { observer.close(); }
});
