import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { installIdentitySchema, IdentityRepository } from '../server/v2/identity/repository.js';
import { planIdentityMigration, applyIdentityMigration } from '../server/v2/identity/migration.js';
import { IdentityService } from '../server/v2/identity/service.js';
import { CAPABILITIES, grant } from '../server/v2/identity/permissions.js';
import { IdentityError } from '../server/v2/identity/errors.js';
import { createLegacyManagementAuthority } from '../server/v2/management-runtime/legacy-authority.js';
import { installRealtimeSchema, RealtimeRepository } from '../server/v2/realtime/repository.js';
import { RealtimeService } from '../server/v2/realtime/service.js';
import { createProductionRelayIngress } from '../server/v2/production/relay.js';

const code = expected => error => error.errorCode === expected;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('production relay auto-binds root-only bounded sources and preserves credentials, deduplication and reset epochs', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  installIdentitySchema(db); installRealtimeSchema(db);
  const ir = new IdentityRepository(db), repo = new RealtimeRepository(db);
  const rootUser = { id: 'user_root', username: 'root', role: 'admin' };
  ir.put('users', rootUser);
  applyIdentityMigration(ir, planIdentityMigration({ users: [rootUser] }));
  ir.setScalar('v2InstallationOwner', { version: 1, accountId: 'user_root' });
  for (const [id, scope] of [['all_scope', { type: 'all' }], ['squad_scope', { type: 'squads', ids: ['squad-a'] }]]) {
    ir.put('accounts', { id, status: 'active', roleId: 'root', permissionVersion: 1, revision: 1,
      grants: CAPABILITIES.map(capability => grant(capability, scope)) });
  }
  let clock = Date.now(), accepting = true, credentialsCurrent = true, operations = 0, nextBarrier;
  let tail = Promise.resolve();
  const now = () => clock;
  const identity = new IdentityService(ir, { providers: {}, now });
  const authority = createLegacyManagementAuthority(identity);
  const service = new RealtimeService(identity, { repository: repo, now,
    authorizeLegacyAction: authority.authorizeRealtimeAction, sourceReset: ({ apply }) => apply() });
  const ingest = createProductionRelayIngress({ getRepository: () => repo, now, isAccepting: () => accepting,
    runOperation: async fn => { operations++; try { return await fn(); } finally { operations--; } },
    serializeWrite: fn => {
      const barrier = nextBarrier; nextBarrier = null;
      const work = tail.then(async () => { if (barrier) { barrier.entered.resolve(); await barrier.release.promise; } return fn(); });
      tail = work.catch(() => {}); return work;
    } });
  const credentials = { assertCredentialsCurrent() { if (!credentialsCurrent) throw new IdentityError('RELAY_CREDENTIALS_CHANGED', 401); } };
  const base = { client: { id: 'new-source', name: 'Collector' }, server: { id: 'new-server', name: 'First server' } };
  const snapshot = { ...base, type: 'clan_snapshot', snapshot: { capturedAt: new Date(clock).toISOString(), members: [] } };
  const chat = id => ({ ...base, type: 'clan_chat_message', message: { id, message: 'Fixture event', sentAt: new Date(clock).toISOString() } });
  await assert.rejects(ingest(snapshot), code('PRODUCTION_RELAY_AUTH_REQUIRED'));
  assert.equal(repo.scopes().length, 0);
  assert.equal((await ingest(snapshot, credentials)).event.inserted, true);
  const scope = repo.scopes()[0];
  assert.deepEqual(scope.resource, { kind: 'system', id: 'relay_unassigned' });
  assert.equal(scope.source, base.client.id);
  assert.equal(scope.server, 'new-source:new-server');
  assert.equal((await ingest(chat('first'), credentials)).event.inserted, true);
  assert.equal((await ingest(chat('first'), credentials)).event.skipped, true);
  assert.equal(repo.scopes().length, 1);
  const root = identity.actorForAccount('user_root');
  assert.deepEqual(service.catalog(root).items.map(item => item.id), [scope.id]);
  assert.equal(service.summary(root, scope.id).commands.reset, true);
  assert.equal(service.page(root, scope.id).items.length, 1);
  for (const id of ['all_scope', 'squad_scope']) {
    const actor = identity.actorForAccount(id);
    assert.deepEqual(service.catalog(actor), { items: [], sourceStatus: 'unavailable' });
    assert.throws(() => service.summary(actor, scope.id), code('ACCESS_DENIED'));
    assert.throws(() => service.page(actor, scope.id), code('ACCESS_DENIED'));
    assert.throws(() => service.events(actor, scope.id), code('ACCESS_DENIED'));
    await assert.rejects(service.command(actor, scope.id, 'clear-chat', {}, 'untrusted_clear_001'), code('ACCESS_DENIED'));
  }
  assert.throws(() => repo.bind({ id: 'bad-system', sourceId: 'bad', serverKey: 'bad:server',
    resource: { kind: 'system', id: 'anything_else' } }), /INVALID_SOURCE_BINDING/);
  repo.bind({ id: 'existing-squad', sourceId: 'old-source', serverKey: 'old-source:server', resource: { kind: 'squad', id: 'squad-a' } });
  await ingest({ ...snapshot, client: { id: 'old-source' }, server: { id: 'server' } }, credentials);
  assert.deepEqual(repo.scope('existing-squad').resource, { kind: 'squad', id: 'squad-a' });
  assert.throws(() => service.summary(identity.actorForAccount('squad_scope'), 'existing-squad'), code('ACCESS_DENIED'));
  assert.equal(service.summary(root, 'existing-squad').status, 'fresh');

  // A clear queued before an admitted event must not let that event use the new epoch.
  const barrier = { entered: deferred(), release: deferred() }; nextBarrier = barrier;
  const pending = ingest(chat('queued-before-clear'), credentials);
  await barrier.entered.promise;
  await service.command(root, scope.id, 'clear-chat', { expectedRevision: repo.scope(scope.id).revision, reason: 'Fixture clear' }, 'trusted_clear_001');
  barrier.release.resolve();
  await assert.rejects(pending, code('SOURCE_EPOCH_CHANGED'));
  assert.equal((await ingest(chat('first'), credentials)).event.reason, 'duplicate_or_cleared');
  assert.equal(service.page(root, scope.id).items.length, 0);
  clock += 1000;
  await service.command(root, scope.id, 'reset', { expectedRevision: repo.scope(scope.id).revision, reason: 'Fixture reset' }, 'trusted_reset_001');
  assert.equal((await ingest(snapshot, credentials)).event.reason, 'before_reset');
  assert.equal(service.summary(root, scope.id).status, 'unavailable');

  const revokedBarrier = { entered: deferred(), release: deferred() }; nextBarrier = revokedBarrier;
  const revoked = ingest({ ...chat('revoked'), client: { id: 'revoked-new-source' } }, credentials);
  await revokedBarrier.entered.promise; credentialsCurrent = false; revokedBarrier.release.resolve();
  await assert.rejects(revoked, code('RELAY_CREDENTIALS_CHANGED'));
  assert.equal(repo.scopes().length, 2);
  credentialsCurrent = true;
  for (let n = 2; n < 500; n++) repo.bind({ id: `capacity-${n}`, sourceId: `capacity-${n}`, serverKey: `capacity-${n}:server`,
    resource: { kind: 'system', id: 'relay_unassigned' } });
  await assert.rejects(ingest({ ...chat('overflow'), client: { id: 'overflow' } }, credentials), code('SOURCE_CATALOG_LIMIT'));
  assert.equal(repo.scopes().length, 500);
  accepting = false;
  await assert.rejects(ingest(chat('stopped'), credentials), code('PRODUCTION_RELAY_NOT_READY'));
  assert.equal(operations, 0);
});
