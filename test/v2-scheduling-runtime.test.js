import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import express from 'express';
import { installIdentitySchema, IdentityRepository } from '../server/v2/identity/repository.js';
import { IdentityService } from '../server/v2/identity/service.js';
import { CAPABILITIES, grant } from '../server/v2/identity/permissions.js';
import { installSchedulingSchema, SchedulingRepository } from '../server/v2/scheduling/repository.js';
import { applySchedulingMigration, planSchedulingMigration } from '../server/v2/scheduling/migration.js';
import { SchedulingService } from '../server/v2/scheduling/service.js';
import { createSchedulingRouter } from '../server/v2/scheduling/routes.js';

test('injected scheduling service cannot bypass explicit migration or the shared identity database', async t => {
  const db = new DatabaseSync(':memory:'); installIdentitySchema(db); installSchedulingSchema(db);
  const repo = new IdentityRepository(db), identity = new IdentityService(repo), schedulingRepo = new SchedulingRepository(db);
  repo.put('accounts', { id: 'local-scheduler-admin', status: 'active', revision: 1, permissionVersion: 1,
    memberId: null, grants: CAPABILITIES.map(capability => grant(capability, { type: 'all' })) });
  let selected = new SchedulingService(schedulingRepo, identity);
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.v2Identity = { service: identity, authenticate: async () => ({ actor: identity.actorForAccount('local-scheduler-admin') }) }; next(); });
  app.use('/api/v2', createSchedulingRouter({ getService: () => selected }));
  const server = createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const method of ['GET', 'POST']) {
    const response = await fetch(`${origin}/api/v2/wipes`, { method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}) });
    assert.equal(response.status, 503); assert.equal((await response.json()).error.errorCode, 'SCHEDULING_MIGRATION_REQUIRED');
  }
  assert.equal(schedulingRepo.scalar('v2SchedulingMigration'), null);
  assert.equal(schedulingRepo.all('wipes').length, 0);
  applySchedulingMigration(schedulingRepo, planSchedulingMigration({}));
  assert.equal((await fetch(`${origin}/api/v2/wipes`)).status, 200);
  selected = new SchedulingService(schedulingRepo, new IdentityService(repo));
  const changedIdentity = await fetch(`${origin}/api/v2/wipes`);
  assert.equal(changedIdentity.status, 503); assert.equal((await changedIdentity.json()).error.errorCode, 'SCHEDULING_SETUP_REQUIRED');
});
