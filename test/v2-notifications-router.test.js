import { authenticatedSession } from './support/authenticated-session.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { installIdentitySchema, IdentityRepository } from '../server/v2/identity/repository.js';
import { IdentityService } from '../server/v2/identity/service.js';
import { createIdentityRouter } from '../server/v2/identity/routes.js';
import { IdentityError } from '../server/v2/identity/errors.js';
import { installSchedulingSchema } from '../server/v2/scheduling/repository.js';
import { installNotificationSchema, NotificationRepository, collections } from '../server/v2/notifications/repository.js';
import { createNotificationRouter } from '../server/v2/notifications/routes.js';

const isSetupError = error => error instanceof IdentityError && error.errorCode === 'NOTIFICATION_SETUP_REQUIRED' && error.status === 503;
function prerequisites(db) {
  installIdentitySchema(db); installSchedulingSchema(db);
  const identityRepo = new IdentityRepository(db);
  identityRepo.setScalar('v2IdentityMigration', { source: 'isolated-notification-test' });
  identityRepo.setScalar('v2SchedulingMigration', { source: 'isolated-notification-test' });
  return identityRepo;
}
function repository(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const identityRepo = prerequisites(db); installNotificationSchema(db);
  return { db, identityRepo, repo: new NotificationRepository(db) };
}

test('notification setup is explicit and rejects missing prerequisite or notification schema without writes', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const objects = () => db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all();
  const before = objects();
  assert.throws(() => new NotificationRepository(db), isSetupError);
  assert.throws(() => installNotificationSchema(db), isSetupError);
  assert.deepEqual(objects(), before);
  const identityRepo = prerequisites(db);
  const uninstalled = objects();
  assert.throws(() => new NotificationRepository(db), isSetupError);
  assert.deepEqual(objects(), uninstalled);
  identityRepo.setScalar('v2SchedulingMigration', null);
  assert.throws(() => installNotificationSchema(db), isSetupError);
  assert.deepEqual(objects(), uninstalled);
  identityRepo.setScalar('v2SchedulingMigration', { source: 'fixture' });
  installNotificationSchema(db);
  const installed = objects(), repo = new NotificationRepository(db), marker = repo.scalar('v2NotificationMigration');
  assert.equal(marker.contractVersion, 'g06-parallel/1');
  installNotificationSchema(db);
  assert.deepEqual(repo.scalar('v2NotificationMigration'), marker);
  assert.deepEqual(objects(), installed);
  const total = db.prepare('SELECT total_changes() AS total').get().total;
  new NotificationRepository(db).listChanges();
  assert.equal(db.prepare('SELECT total_changes() AS total').get().total, total);
  db.exec('DROP INDEX v2_notification_business_key');
  assert.throws(() => new NotificationRepository(db), isSetupError);
});

test('notification storage enforces business, delivery, operation and action reference uniqueness', t => {
  const { repo } = repository(t);
  for (const [name, base] of [
    ['intents', { businessKey: 'business-1' }],
    ['deliveries', { intentId: 'intent-1', targetId: 'target-1', language: 'zh-CN' }],
    ['receipts', { actorAccountId: 'admin', operationId: 'same-key' }],
    ['actionReferences', { tokenHash: 'hash-1' }]
  ]) {
    repo.put(name, { id: `${name}-1`, wipeId: 'wipe-1', ...base });
    assert.throws(() => repo.put(name, { id: `${name}-2`, wipeId: 'wipe-1', ...base }), /UNIQUE constraint/);
    assert.equal(repo.forWipe(name, 'wipe-1').length, 1);
    assert.equal(repo.forWipe(name, 'wipe-2').length, 0);
  }
  repo.put('receipts', { id: 'other-actor', actorAccountId: 'another', operationId: 'same-key' });
  repo.put('deliveries', { id: 'other-language', intentId: 'intent-1', targetId: 'target-1', language: 'en' });
  assert.equal(repo.all('receipts').length, 2);
  assert.equal(repo.all('deliveries').length, 2);
  assert.ok(Object.values(collections).every(name => /^v2(?:Notification|DiscordWipeSignup)/.test(name)));
  assert.throws(() => repo.put('signups', { id: 'forbidden' }), /Unknown notification collection/);
  assert.throws(() => repo.all('__proto__'), /Unknown notification collection/);
  assert.throws(() => repo.setScalar('v2SchedulingMigration', {}), /namespace/);
});

test('notification durable changes commit with business facts and survive reopening with ordered cursors', t => {
  const directory = mkdtempSync(join(tmpdir(), 'nb-v2-notifications-repository-'));
  const path = join(directory, 'isolated.sqlite');
  let db = new DatabaseSync(path);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  prerequisites(db); installNotificationSchema(db);
  let repo = new NotificationRepository(db);
  const change = type => ({ wipeId: 'wipe-1', intentId: 'intent-1', targetId: 'target-1', type, createdAt: '2030-09-08T10:00:00.000Z' });
  repo.transaction(() => {
    repo.put('intents', { id: 'intent-1', wipeId: 'wipe-1', businessKey: 'business-1' });
    assert.equal(repo.appendChange(change('intent.created')).cursor, 1);
  });
  assert.throws(() => repo.transaction(() => {
    repo.put('deliveries', { id: 'rolled-back', intentId: 'intent-1', targetId: 'target-1', language: 'en' });
    repo.appendChange(change('delivery.queued'));
    throw new Error('injected storage failure');
  }), /injected storage failure/);
  assert.equal(repo.get('deliveries', 'rolled-back'), null);
  assert.deepEqual(repo.listChanges().items.map(row => row.cursor), [1]);
  assert.equal(repo.appendChange(change('intent.changed')).cursor, 2);
  assert.throws(() => repo.transaction(() => Promise.resolve('not allowed')), /must be synchronous/);
  assert.equal(db.isTransaction, false);
  db.close(); db = new DatabaseSync(path); repo = new NotificationRepository(db);
  assert.equal(repo.get('intents', 'intent-1').businessKey, 'business-1');
  const first = repo.listChanges({ limit: 1 });
  assert.equal(first.nextCursor, 1); assert.equal(first.items[0].deliveryId, null);
  const second = repo.listChanges({ after: first.nextCursor });
  assert.deepEqual(second.items.map(row => row.cursor), [2]);
  assert.deepEqual(repo.listChanges({ after: 2 }), { items: [], nextCursor: 2 });
  assert.equal(repo.appendChange(change('delivery.changed')).cursor, 3);
  assert.throws(() => repo.put('changes', { ...first.items[0], type: 'overwritten' }), /immutable/);
  assert.throws(() => db.prepare("DELETE FROM json_records WHERE collection='v2NotificationChanges'").run(), /cannot be deleted/);
});

test('independent SQLite connections publish only committed changes and share one monotonic cursor', t => {
  const directory = mkdtempSync(join(tmpdir(), 'nb-v2-notifications-connections-'));
  const path = join(directory, 'isolated.sqlite');
  const firstDb = new DatabaseSync(path); prerequisites(firstDb); installNotificationSchema(firstDb);
  const secondDb = new DatabaseSync(path);
  t.after(() => { firstDb.close(); secondDb.close(); rmSync(directory, { recursive: true, force: true }); });
  const first = new NotificationRepository(firstDb), second = new NotificationRepository(secondDb);
  const event = { wipeId: 'wipe-1', type: 'intent.created', createdAt: '2030-09-08T10:00:00.000Z' };
  first.transaction(() => {
    assert.equal(first.appendChange(event).cursor, 1);
    assert.deepEqual(second.listChanges(), { items: [], nextCursor: 0 });
  });
  assert.equal(second.listChanges().nextCursor, 1);
  assert.equal(second.appendChange(event).cursor, 2);
  assert.equal(first.appendChange(event).cursor, 3);
  assert.deepEqual(second.listChanges().items.map(item => item.cursor), [1, 2, 3]);
  first.setScalar('v2NotificationMigration', null);
  const count = secondDb.prepare('SELECT total_changes() AS count').get().count;
  assert.throws(() => new NotificationRepository(secondDb), isSetupError);
  assert.equal(secondDb.prepare('SELECT total_changes() AS count').get().count, count);
});

async function httpRuntime(t) {
  const { db, identityRepo, repo } = repository(t);
  const now = Date.parse('2030-09-08T10:00:00.000Z');
  const identity = new IdentityService(identityRepo, { now: () => now });
  const account = { id: 'admin', memberId: null, status: 'active', roleId: 'admin', adminAssignedByOwner: true, revision: 1, permissionVersion: 42, grants: [] };
  identityRepo.put('accounts', account);
  const session = await authenticatedSession(identity, account.id);
  const app = express(), server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const identityRouter = createIdentityRouter({ service: identity, origin, providers: {} });
  app.use('/api/v2', (req, _res, next) => {
    req.v2Identity = { service: identity, authenticate: options => identityRouter.authenticate(options)(req) }; next();
  }, identityRouter);
  const state = { systemCalls: 0, calls: [], error: null };
  const service = { now: () => now };
  for (const name of ['listAdminWipes', 'listWipeOptions', 'getOptions', 'createPreview', 'createIntent', 'listIntents',
    'getIntent', 'getDelivery', 'retryFailed', 'commandDelivery', 'getOperation']) {
    service[name] = async (...args) => {
      state.calls.push({ name, args });
      if (state.error) throw state.error;
      return { marker: name };
    };
  }
  app.use('/api/v2', createNotificationRouter({ getSystem: async () => { state.systemCalls++; return { service }; } }));
  const request = async (path, { method = 'GET', body, auth = true, origin: requestOrigin = origin, csrf = session.csrfToken } = {}) => {
    const response = await fetch(`${origin}/api/v2${path}`, { method, headers: {
      ...(auth ? { cookie: `nb_v2_session=${session.token}` } : {}),
      origin: requestOrigin, 'x-csrf-token': csrf, 'Idempotency-Key': 'route-operation-1',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const raw = await response.text();
    return { response, raw, body: response.headers.get('content-type')?.includes('json') ? JSON.parse(raw) : null };
  };
  return { db, repo, identityRepo, identity, state, request, now };
}

test('frozen notification HTTP paths forward the current actor, query, body and operation key with exact success status', async t => {
  const f = await httpRuntime(t);
  const routes = [
    ['GET', '/admin/wipes?limit=1&lifecycle=draft', 'listAdminWipes', 200],
    ['GET', '/admin/wipe-options?kind=members&q=local', 'listWipeOptions', 200],
    ['GET', '/wipes/wipe-1/notification-options', 'getOptions', 200],
    ['POST', '/wipes/wipe-1/notification-previews', 'createPreview', 201],
    ['POST', '/wipes/wipe-1/publish-intents', 'createIntent', 202],
    ['GET', '/wipes/wipe-1/publish-intents?limit=3', 'listIntents', 200],
    ['GET', '/publish-intents/intent-1?cursor=next', 'getIntent', 200],
    ['GET', '/deliveries/delivery-1', 'getDelivery', 200],
    ['POST', '/publish-intents/intent-1/retry-failed', 'retryFailed', 200],
    ['POST', '/deliveries/delivery-1/commands/retry', 'commandDelivery', 200],
    ['POST', '/deliveries/delivery-1/commands/cancel', 'commandDelivery', 200],
    ['POST', '/deliveries/delivery-1/commands/reconcile', 'commandDelivery', 200],
    ['GET', '/notifications/operations/operation-1', 'getOperation', 200]
  ];
  for (const [method, path, expected, status] of routes) {
    const result = await f.request(path, { method, ...(method === 'POST' ? { body: { actor: { id: 'forged' }, expectedRevision: 1 } } : {}) });
    assert.equal(result.response.status, status, path);
    assert.equal(result.response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(result.body.data, { marker: expected });
    assert.equal(result.body.meta.scopeVersion, 42);
    assert.equal(result.body.meta.serverTime, new Date(f.now).toISOString());
    assert.ok(result.body.meta.requestId);
    const call = f.state.calls.at(-1);
    assert.equal(call.name, expected); assert.equal(call.args[0].id, 'admin');
    if (method === 'POST') assert.deepEqual(call.args.at(-1), { operationId: 'route-operation-1' });
    if (expected === 'commandDelivery') assert.equal(call.args[2], path.split('/').at(-1));
  }
  assert.equal((await f.request('/deliveries/delivery-1/commands/send', { method: 'POST', body: {} })).response.status, 404);
  assert.equal(f.state.calls.length, routes.length);
});

test('real identity HTTP authentication, exact origin, CSRF and revocation reject notification calls before system lookup', async t => {
  const f = await httpRuntime(t);
  assert.equal((await f.request('/admin/wipes', { auth: false })).response.status, 401);
  assert.equal((await f.request('/wipes/wipe-1/notification-previews', { method: 'POST', body: {}, origin: 'https://foreign.invalid' })).response.status, 403);
  assert.equal((await f.request('/wipes/wipe-1/notification-previews', { method: 'POST', body: {}, csrf: 'wrong' })).response.status, 403);
  assert.equal(f.state.systemCalls, 0);
  assert.equal(f.state.calls.length, 0);
  assert.equal((await f.request('/admin/wipes')).response.status, 200);
  f.identityRepo.put('accounts', { ...f.identityRepo.get('accounts', 'admin'), permissionVersion: 43 });
  const revoked = await f.request('/admin/wipes');
  assert.equal(revoked.response.status, 401); assert.equal(revoked.body.error.errorCode, 'PERMISSIONS_CHANGED');
  assert.equal(f.state.systemCalls, 1);
});

test('notification HTTP errors have stable envelopes and do not expose untrusted exception properties', async t => {
  const f = await httpRuntime(t);
  f.state.error = new IdentityError('PREVIEW_STALE', 409, { current: { id: 'authorized-intent' }, fieldErrors: { contentHash: 'PREVIEW_STALE' } });
  const stale = await f.request('/wipes/wipe-1/publish-intents', { method: 'POST', body: {} });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.operationId, 'route-operation-1');
  assert.deepEqual(stale.body.error.current, { id: 'authorized-intent' });
  assert.equal(stale.body.error.retryable, false);
  f.state.error = Object.assign(new Error('secret connection string'), {
    errorCode: 'SECRET_ERROR', status: 418, current: { rawPayload: 'secret payload' }, fieldErrors: { private: 'secret' }
  });
  const unknown = await f.request('/admin/wipes');
  assert.equal(unknown.response.status, 503);
  assert.equal(unknown.body.error.errorCode, 'NOTIFICATION_SETUP_REQUIRED');
  assert.equal(unknown.body.error.current, null);
  assert.deepEqual(unknown.body.error.fieldErrors, {});
  assert.equal(unknown.raw.includes('secret'), false);
  assert.equal(unknown.raw.includes('SECRET'), false);
});
