import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { createServer } from 'node:http';
import { IdentityRepository, installIdentitySchema } from '../server/v2/identity/repository.js';
import { grant, allScope } from '../server/v2/identity/permissions.js';
import { PlatformAdminService } from '../server/v2/platform-admin/service.js';
import { installPlatformAdminSchema } from '../server/v2/platform-admin/repository.js';
import { createPlatformAdminRouter } from '../server/v2/platform-admin/routes.js';

function setup(t) {
  const db = new DatabaseSync(':memory:');
  installIdentitySchema(db);
  installPlatformAdminSchema(db);
  t.after(() => db.close());
  const repo = new IdentityRepository(db);
  repo.setScalar('settings', { thirdPartyLogin: {
    steam: { enabled: true, updatedAt: '' }, discord: { enabled: true, updatedAt: 'unchanged' }
  } });
  const actor = { id: 'admin', status: 'active', grants: [
    grant('platforms.read', allScope), grant('platforms.configure', allScope)
  ] };
  let auditCount = 0;
  const identity = {
    repo, origin: 'https://example.test',
    actorForAccount: id => id === actor.id ? actor : null,
    relations: () => ({}),
    audit: (action, accountId, detail) => repo.put('audits', {
      id: `audit_${++auditCount}`, action, accountId, ...detail
    })
  };
  return { repo, actor, identity, service: new PlatformAdminService({ identity, now: () => Date.UTC(2026, 8, 23, 12) }) };
}

test('Steam login settings show the real OpenID callback and save only the Steam switch', t => {
  const { repo, actor, service } = setup(t);
  assert.deepEqual(service.steamLoginDetail(actor), {
    enabled: true, updatedAt: '', canConfigure: true, method: 'OpenID 2.0',
    providerUrl: 'https://steamcommunity.com/openid/login',
    startUrl: 'https://example.test/api/v2/auth/steam/start',
    callbackUrl: 'https://example.test/api/v2/auth/steam/login-callback'
  });
  const operationId = randomUUID(), input = { expectedUpdatedAt: '', enabled: false };
  const saved = service.saveSteamLogin(actor, input, { operationId });
  assert.equal(saved.current.enabled, false);
  assert.equal(repo.scalar('settings').thirdPartyLogin.discord.updatedAt, 'unchanged');
  assert.equal(repo.all('audits').filter(row => row.action === 'steam_login_settings_changed').length, 1);
  assert.equal(service.saveSteamLogin(actor, input, { operationId }).updatedAt, saved.updatedAt);
  assert.throws(() => service.saveSteamLogin(actor, { expectedUpdatedAt: '', enabled: true }, { operationId: randomUUID() }),
    { errorCode: 'REVISION_CONFLICT' });
  assert.throws(() => service.saveSteamLogin(actor, { expectedUpdatedAt: '', enabled: true }, { operationId }),
    { errorCode: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(service.receipt(actor, operationId).enabled, false);
});

test('Steam login settings HTTP route enforces platform permissions and uses the saved value', async t => {
  const { actor, identity, service } = setup(t);
  const app = express();
  app.use((req, _res, next) => {
    req.v2Identity = { service: identity, authenticate: async () => ({ actor }) };
    next();
  });
  app.use('/api/v2', createPlatformAdminRouter({ getSystem: () => ({ service }) }));
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/v2/platform-admin/steam/login`;
  const initial = await (await fetch(url)).json();
  assert.equal(initial.data.enabled, true);
  const saved = await (await fetch(url, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'Idempotency-Key': randomUUID()
  }, body: JSON.stringify({ expectedUpdatedAt: '', enabled: false }) })).json();
  assert.equal(saved.data.current.enabled, false);
  assert.equal((await (await fetch(url)).json()).data.enabled, false);
  actor.grants = [];
  assert.equal((await fetch(url)).status, 403);
});
