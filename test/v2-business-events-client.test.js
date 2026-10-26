import test from 'node:test';
import assert from 'node:assert/strict';
import { connectBusinessEvents } from '../src/v2/business-events.js';
import { createQueryClient } from '../src/v2/query-client.js';

class FakeEventSource {
  static all = [];
  constructor(url) { this.url = url; this.handlers = new Map(); this.closed = false; FakeEventSource.all.push(this); }
  addEventListener(type, fn) { this.handlers.set(type, fn); }
  removeEventListener(type, fn) { if (this.handlers.get(type) === fn) this.handlers.delete(type); }
  emit(type, data) { this.handlers.get(type)?.({ data: typeof data === 'string' ? data : JSON.stringify(data) }); }
  close() { this.closed = true; }
}
const envelope = changes => ({ schemaVersion: 1, scopeVersion: 1, changes });
const hint = { kind: 'notification', wipeId: 'w1', intentId: 'i1', deliveryId: 'd1' };
function fixture(t) {
  let authorizationLost = 0, refreshed = 0;
  const client = createQueryClient({ onAuthorizationLost: () => authorizationLost++ });
  client.setIdentity({ accountId: 'a1', scopeVersion: 1 });
  const calls = [], invalidate = client.invalidateQueries;
  client.invalidateQueries = (...args) => { calls.push(args); return invalidate(...args); };
  const close = connectBusinessEvents({ client, session: { accountId: 'a1' }, online: true,
    refreshSession: () => { refreshed++; }, EventSourceImpl: FakeEventSource });
  t.after(() => { close(); client.dispose(); });
  return { client, source: FakeEventSource.all.at(-1), calls, close,
    status: () => ({ authorizationLost, refreshed }), reset: () => FakeEventSource.all.at(-1).emit('reset', { schemaVersion: 1, scopeVersion: 1, reason: 'initial' }) };
}

test('business stream is same-origin and reset precedes bounded allowlisted invalidations', t => {
  const f = fixture(t); assert.equal(f.source.url, '/api/v2/events');
  f.source.emit('invalidate', envelope([hint])); assert.equal(f.calls.length, 0);
  f.reset(); assert.deepEqual(f.calls, [[]]);
  f.source.emit('invalidate', envelope([hint]));
  const keys = f.calls.slice(1).map(([key]) => JSON.stringify(key));
  for (const key of [['home'], ['wipes'], ['history'], ['admin-wipes'], ['wipe', 'w1'], ['notification-intents', 'w1'],
    ['notification-intent', 'i1'], ['notification-delivery', 'd1'], ['notification-options', 'w1']]) assert.ok(keys.includes(JSON.stringify(key)));
});

test('signup/wipe events invalidate actual member and admin detail, history, archive and delivery cache keys', t => {
  const f = fixture(t); f.reset(); f.calls.length = 0;
  f.source.emit('invalidate', envelope([{ kind: 'signup', wipeId: 'w1' }, { kind: 'wipe', wipeId: 'w1' }]));
  const keys = f.calls.map(([key]) => JSON.stringify(key));
  for (const key of [['signups', 'w1'], ['admin-signup', 'w1'], ['admin-history', 'w1'], ['admin-archive', 'w1'],
    ['notification-intent'], ['notification-delivery']]) assert.ok(keys.includes(JSON.stringify(key)));
  assert.equal(new Set(keys).size, keys.length);
});

test('wrong scope, unknown fields/types, raw identities and excessive events never invalidate caches', t => {
  const f = fixture(t); f.reset(); f.calls.length = 0;
  for (const value of [
    'bad json', { ...envelope([hint]), schemaVersion: 2 }, { ...envelope([hint]), scopeVersion: 2 },
    { ...envelope([hint]), cursor: 'untrusted' }, envelope([{ ...hint, memberId: 'private' }]),
    envelope([{ kind: 'arbitrary-query', wipeId: 'w1' }]), envelope([]), envelope(Array(101).fill(hint)),
    envelope([{ kind: 'signup', wipeId: 'w1', memberId: 'm2' }]), envelope([{ ...hint, deliveryId: '' }]),
    ' '.repeat(32769)
  ]) f.source.emit('invalidate', value);
  f.source.emit('reset', { schemaVersion: 1, scopeVersion: 1, reason: 'any' });
  assert.equal(f.calls.length, 0); assert.equal(f.client.getIdentity().accountId, 'a1');
});

test('native reconnect requires a new reset before accepting incremental events', t => {
  const f = fixture(t); f.reset(); f.calls.length = 0; f.source.onerror();
  f.source.emit('invalidate', envelope([hint])); assert.equal(f.calls.length, 0);
  f.source.emit('reset', { schemaVersion: 1, scopeVersion: 1, reason: 'reconnect' });
  assert.deepEqual(f.calls, [[]]); f.source.emit('invalidate', envelope([hint])); assert.ok(f.calls.length > 1);
});

test('identity changes close immediately and even queued old listeners cannot touch a new account', t => {
  const f = fixture(t); f.reset(); f.calls.length = 0;
  const old = f.source.handlers.get('authorization-revoked'), oldInvalidate = f.source.handlers.get('invalidate');
  f.client.setIdentity({ accountId: 'a2', scopeVersion: 1 });
  assert.equal(f.source.closed, true); assert.equal(f.source.handlers.size, 0);
  old({ data: JSON.stringify({ schemaVersion: 1, scopeVersion: 1 }) });
  oldInvalidate({ data: JSON.stringify(envelope([hint])) });
  assert.equal(f.client.getIdentity().accountId, 'a2'); assert.equal(f.calls.length, 0);
});

test('scope changes immediately purge data and unmount private session before one bootstrap refresh', async t => {
  const f = fixture(t); f.reset(); f.client.setQueryData(['wipe', 'w1'], { private: 'old audience' });
  f.source.emit('reset', { schemaVersion: 1, scopeVersion: 1, reason: 'scope_changed' });
  assert.equal(f.source.closed, true); assert.equal(f.client.getIdentity(), null);
  assert.equal(f.client.getQueryState(['wipe', 'w1']).data, undefined);
  assert.equal(f.status().authorizationLost, 1);
  await Promise.resolve(); assert.equal(f.status().refreshed, 1);
});

test('scope refresh is fenced when another login occurs before the refresh microtask', async t => {
  const f = fixture(t);
  f.source.emit('reset', { schemaVersion: 1, scopeVersion: 1, reason: 'scope_changed' });
  f.client.setIdentity({ accountId: 'a2', scopeVersion: 1 });
  await Promise.resolve(); assert.equal(f.status().refreshed, 0);
});

test('revocation and logout clear data/close stream; cleanup is idempotent and has no reconnect timers', t => {
  const f = fixture(t); f.client.setQueryData(['home'], { private: true });
  f.source.emit('authorization-revoked', { schemaVersion: 1, scopeVersion: 1 });
  assert.equal(f.client.getIdentity(), null); assert.equal(f.client.getQueryState(['home']).data, undefined);
  assert.equal(f.source.closed, true); assert.equal(f.source.onerror, null); f.close(); f.close();
  assert.equal(f.status().refreshed, 0);
});

test('offline, missing session and mismatched account create no streams', () => {
  const client = createQueryClient(); client.setIdentity({ accountId: 'a1', scopeVersion: 1 });
  const before = FakeEventSource.all.length;
  for (const options of [{ online: false, session: { accountId: 'a1' } }, { online: true },
    { online: true, session: { accountId: 'a2' } }])
    connectBusinessEvents({ client, EventSourceImpl: FakeEventSource, ...options })();
  assert.equal(FakeEventSource.all.length, before); client.dispose();
});

test('domain reset refreshes shared bootstrap and reconnect without an event ID refreshes again', async t => {
  const f = fixture(t); f.reset();
  await Promise.resolve(); assert.equal(f.status().refreshed, 0);
  f.source.emit('reset', { schemaVersion: 1, scopeVersion: 1, reason: 'domain_changed' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.status().refreshed, 1);
  f.source.onerror(); f.reset();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.status().refreshed, 2);
});

test('domain bootstrap refresh is fenced before a queued callback reaches a different account', async t => {
  const f = fixture(t); f.reset();
  f.source.emit('reset', { schemaVersion: 1, scopeVersion: 1, reason: 'domain_changed' });
  f.client.setIdentity({ accountId: 'a2', scopeVersion: 1 });
  await Promise.resolve(); assert.equal(f.status().refreshed, 0);
});

test('same-account same-scope bootstrap after a generation change opens a fresh controller and fences old callbacks', async t => {
  const client = createQueryClient(), session = { accountId: 'a1' };
  client.setIdentity({ accountId: 'a1', scopeVersion: 1 });
  const firstGeneration = client.getGeneration();
  const refreshSession = async () => { client.setIdentity({ accountId: 'a1', scopeVersion: 1 }); return session; };
  const options = { client, session, online: true, refreshSession, EventSourceImpl: FakeEventSource };
  const firstCleanup = connectBusinessEvents(options), first = FakeEventSource.all.at(-1);
  const queuedOldRevocation = first.handlers.get('authorization-revoked');
  first.emit('reset', { schemaVersion: 1, scopeVersion: 1, reason: 'scope_changed' });
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(client.getIdentity(), { accountId: 'a1', scopeVersion: 1 });
  assert.ok(client.getGeneration() > firstGeneration); assert.equal(first.closed, true);
  // Exercise the effect's cleanup/setup lifecycle with restored identical props.
  // The hook also depends on generation, so that lifecycle runs after restoration.
  firstCleanup(); const secondCleanup = connectBusinessEvents(options), second = FakeEventSource.all.at(-1);
  t.after(() => { secondCleanup(); client.dispose(); });
  assert.notEqual(second, first); assert.equal(second.closed, false);
  client.setQueryData(['wipe', 'w1'], { revision: 2 });
  queuedOldRevocation({ data: JSON.stringify({ schemaVersion: 1, scopeVersion: 1 }) });
  assert.equal(client.getIdentity().accountId, 'a1'); assert.equal(second.closed, false);
  second.emit('reset', { schemaVersion: 1, scopeVersion: 1, reason: 'initial' });
  assert.equal(client.getQueryState(['wipe', 'w1']).stale, true);
});
