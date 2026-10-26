import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { fixture } from './support/v2-stats/fixture.mjs';
import { createIdentityRouter } from '../server/v2/identity/routes.js';
import { createStatsRouter } from '../server/v2/stats/routes.js';
test('real G03 cookies, origin and CSRF guard all mutations; hidden/job/error projections do not leak', async t => {
  const f = fixture(),
    app = express(),
    server = createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const identityRouter = createIdentityRouter({
    service: f.identity,
    origin,
    providers: {}
  });
  t.after(async () => {
    await identityRouter.stopEvents();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    f.db.close();
  });
  app.use('/api/v2', (req, res, next) => {
    req.v2Identity = {
      service: f.identity,
      authenticate: opts => identityRouter.authenticate(opts)(req)
    };
    next();
  });
  app.use('/api/v2', createStatsRouter(f.options));
  f.identity.providers.discord = { roles: async (externalId, guildId) => ({ externalId, guildId, roleIds: ['g05_fixture_role'] }) };
  const evidence = await f.identity.checkEligibility('discord', 'discord_g05_admin');
  const session = f.identity.issueSession(f.ir.get('accounts', 'g05_account_admin'), evidence);
  const headers = {
    Cookie: `nb_v2_session=${session.token}`,
    Origin: origin,
    'Content-Type': 'application/json',
    'X-CSRF-Token': session.csrfToken,
    'Idempotency-Key': 'http-query-one'
  };
  let response = await fetch(origin + '/api/v2/stats/rows?wipeId=g07_active&sourceId=vital&metricVersion=nb-kda-1');
  assert.equal(response.status, 401);
  response = await fetch(origin + '/api/v2/stats/rows?wipeId=g07_active&sourceId=vital&metricVersion=nb-kda-1', {
    headers
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.data.items.length, 5);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(JSON.stringify(data).includes('csrfHash'), false);
  const syncHeaders = { ...headers, 'Idempotency-Key': 'http-stats-sync' };
  const syncBody = JSON.stringify({ wipeId: 'g07_active', sourceId: 'vital', expectedRevision: 1 });
  response = await fetch(origin + '/api/v2/stats/sync', { method: 'POST', headers: syncHeaders, body: syncBody });
  assert.equal(response.status, 200);
  const sync = (await response.json()).data;
  assert.equal(sync.job.id, 'http-stats-sync');
  assert.equal(sync.job.status, 'queued');
  response = await fetch(origin + '/api/v2/stats/sync', { method: 'POST', headers: syncHeaders, body: syncBody });
  assert.equal((await response.json()).data.job.id, sync.job.id, 'the fixture preserves command replay');
  response = await fetch(origin + '/api/v2/stats/sync/' + sync.job.id, { headers });
  const runningSync = (await response.json()).data;
  assert.equal(runningSync.status, 'running');
  assert.equal(runningSync.counts.pendingOrRunning, 4);
  response = await fetch(origin + '/api/v2/stats/sync/' + sync.job.id, { headers });
  const completedSync = (await response.json()).data;
  assert.equal(completedSync.status, 'succeeded');
  assert.equal(completedSync.counts.succeeded, completedSync.counts.total);
  const body = JSON.stringify({
    sourceId: 'official',
    steamInput: '76561198000000501'
  });
  for (const patch of [{
    'X-CSRF-Token': 'wrong'
  }, {
    Origin: 'https://other.invalid'
  }]) {
    response = await fetch(origin + '/api/v2/stats/queries', {
      method: 'POST',
      headers: {
        ...headers,
        ...patch
      },
      body
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.errorCode, 'CSRF_INVALID');
  }
  response = await fetch(origin + '/api/v2/stats/queries', {
    method: 'POST',
    headers,
    body
  });
  assert.equal(response.status, 200);
  const job = (await response.json()).data;
  await f.service.runJob(job.jobId);
  response = await fetch(origin + '/api/v2/stats/jobs/' + job.jobId, {
    headers
  });
  assert.equal((await response.json()).data.status, 'succeeded');
  const memberEvidence = await f.identity.checkEligibility('discord', 'discord_g05_alpha');
  const memberSession = f.identity.issueSession(f.ir.get('accounts', 'g05_account_alpha'), memberEvidence);
  response = await fetch(origin + '/api/v2/stats/jobs/' + job.jobId, {
    headers: {
      Cookie: `nb_v2_session=${memberSession.token}`
    }
  });
  assert.equal(response.status, 404);
  f.identity.revokeAccountScope('g05_account_admin', 'test');
  response = await fetch(origin + '/api/v2/stats/rows?wipeId=g07_active&sourceId=vital&metricVersion=nb-kda-1', {
    headers
  });
  assert.equal(response.status, 401);
});
