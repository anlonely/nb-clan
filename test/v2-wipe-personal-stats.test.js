import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { fixture } from './support/v2-stats/fixture.mjs';
import { can } from '../server/v2/identity/permissions.js';
import { createIdentityRouter } from '../server/v2/identity/routes.js';
import { createStatsRouter } from '../server/v2/stats/routes.js';

const query = { wipeId: 'g07_active', sourceId: 'vital', metricVersion: 'nb-kda-1' };
function setup(t) {
  const f = fixture();
  t.after(() => f.db.close());
  const wipe = f.sr.get('wipes', query.wipeId);
  f.sr.put('wipes', { ...wipe, audience: { allMembers: true, squadIds: [], memberIds: [], includeUnassigned: true },
    serverSnapshot: { provider: 'vital', kdaProvider: 'vital', vitalServerId: '19', vitalWipeId: 'period-9' } });
  return f;
}

test('ordinary member reads their exact current-wipe row without a signup or management permission', t => {
  const f = setup(t), actor = f.member(), relations = f.identity.relations();
  assert.equal(actor.roleId, 'member');
  assert.equal(can(actor, 'stats.read', { kind: 'stat', memberId: actor.memberId, wipeId: query.wipeId }, relations), true);
  assert.equal(can(actor, 'stats.read', { kind: 'stat', memberId: 'g05_beta', wipeId: query.wipeId }, relations), false);
  assert.equal(can(actor, 'stats.export', { kind: 'wipe', id: query.wipeId }, relations), false);
  assert.equal(can(actor, 'sync.run', { kind: 'wipe', id: query.wipeId }, relations), false);
  assert.equal(f.db.prepare("SELECT count(*) n FROM json_records WHERE collection IN ('v2Signups','wipeParticipants')").get().n, 0);
  const before = f.db.prepare('SELECT total_changes() n').get().n;
  const result = f.service.list(actor, { ...query, memberId: actor.memberId });
  assert.deepEqual(result.items.map(row => [row.wipeId, row.memberId, row.providerWipeId]), [[query.wipeId, actor.memberId, 'period-9']]);
  assert.equal(result.items[0].steamId, '76561198000000501');
  assert.equal(result.nextCursor, null);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, before);
  assert.equal(f.sourceCalls(), 0);
});

test('memberId filter is exact and cannot widen the ordinary member self scope', t => {
  const f = setup(t), actor = f.member();
  for (const memberId of ['g05_beta', 'g05_foreign', 'g05_alph', "g05_alpha' OR 1=1 --"])
    assert.deepEqual(f.service.list(actor, { ...query, memberId }).items, []);
  const unfiltered = f.service.list(actor, query);
  assert.deepEqual(unfiltered.items.map(row => row.memberId), [actor.memberId]);
  const adminFiltered = f.service.list(f.admin(), { ...query, memberId: actor.memberId });
  assert.deepEqual(adminFiltered.items.map(row => row.memberId), [actor.memberId]);
  assert.deepEqual(f.service.list(f.admin(), { ...query, memberId: 'g05_alph' }).items, []);
});

test('an inaccessible wipe remains hidden even when a member has a saved stats row', t => {
  const f = setup(t), wipe = f.sr.get('wipes', query.wipeId);
  f.sr.put('wipes', { ...wipe, audience: { allMembers: false, squadIds: ['g05_foreign_squad'], memberIds: [], includeUnassigned: false } });
  assert.throws(() => f.service.list(f.member(), { ...query, memberId: f.member().memberId }), { errorCode: 'RESOURCE_NOT_FOUND', status: 404 });
  assert.equal(f.service.list(f.foreign(), { ...query, memberId: f.foreign().memberId }).items.length, 1);
});

test('statistics visibility hides the personal row and its existence until restored', t => {
  const f = setup(t), actor = f.member();
  f.sr.put('wipes', { ...f.sr.get('wipes', query.wipeId), lifecycle: 'ended' });
  f.service.visibility(f.admin(), { wipeId: query.wipeId, expectedRevision: 0, hidden: true, reason: 'test hidden period' }, 'personal-hide-one');
  assert.throws(() => f.service.list(actor, { ...query, memberId: actor.memberId }), { errorCode: 'RESOURCE_NOT_FOUND', status: 404 });
  assert.throws(() => f.service.sources(actor, query.wipeId), { errorCode: 'RESOURCE_NOT_FOUND', status: 404 });
  assert.equal(f.service.catalog(actor, { provider: 'vital', hidden: '1' }).items.some(wipe => wipe.id === query.wipeId), false);
  f.service.visibility(f.admin(), { wipeId: query.wipeId, expectedRevision: 1, hidden: false, reason: 'test restored period' }, 'personal-hide-two');
  assert.deepEqual(f.service.list(actor, { ...query, memberId: actor.memberId }).items.map(row => row.memberId), [actor.memberId]);
});

test('real member cookie can read personal stats; guessed member IDs and hidden periods do not expose others', async t => {
  const f = fixture(), app = express(), server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const identityRouter = createIdentityRouter({ service: f.identity, origin, providers: {} });
  t.after(async () => {
    await identityRouter.stopEvents(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); f.db.close();
  });
  app.use('/api/v2', (req, _res, next) => {
    req.v2Identity = { service: f.identity, authenticate: options => identityRouter.authenticate(options)(req) };
    next();
  });
  app.use('/api/v2', createStatsRouter(f.options));
  f.identity.providers.discord = { roles: async (externalId, guildId) => ({ externalId, guildId, roleIds: ['g05_fixture_role'] }) };
  const evidence = await f.identity.checkEligibility('discord', 'discord_g05_alpha');
  const session = f.identity.issueSession(f.ir.get('accounts', 'g05_account_alpha'), evidence);
  const headers = { Cookie: `nb_v2_session=${session.token}`, Origin: origin };
  const url = memberId => `${origin}/api/v2/stats/rows?${new URLSearchParams({ ...query, memberId })}`;
  assert.equal((await fetch(url('g05_alpha'))).status, 401);
  const response = await fetch(url('g05_alpha'), { headers });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = (await response.json()).data;
  assert.deepEqual(result.items.map(row => row.memberId), ['g05_alpha']);
  const other = await fetch(url('g05_beta'), { headers });
  assert.equal(other.status, 200); assert.deepEqual((await other.json()).data.items, []);
  f.sr.put('wipes', { ...f.sr.get('wipes', query.wipeId), lifecycle: 'ended' });
  f.service.visibility(f.admin(), { wipeId: query.wipeId, expectedRevision: 0, hidden: true, reason: 'test hidden period' }, 'personal-http-hide');
  const hidden = await fetch(url('g05_alpha'), { headers });
  assert.equal(hidden.status, 404); assert.equal((await hidden.json()).error.errorCode, 'RESOURCE_NOT_FOUND');
});
