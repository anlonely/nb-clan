import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueryClient, queryKey } from '../src/v2/query-client.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const response = (data, scopeVersion = 1) => new Response(JSON.stringify({ data, meta: { scopeVersion } }), { status: 200 });
const failure = (errorCode, status, details = {}) => new Response(JSON.stringify({ error: { errorCode, ...details } }), { status });
function clientFor(t, fetchImpl, options = {}) {
  const client = createQueryClient({ fetchImpl, ...options }); t.after(() => client.dispose());
  client.setIdentity({ accountId: 'a1', scopeVersion: 1, csrfToken: 'csrf-a1' }); return client;
}

test('query deduplicates, caches only its resource key, and exposes live loading/refreshing/stale states', async t => {
  let callCount = 0, resolveResponse = deferred();
  const client = clientFor(t, () => { callCount++; return resolveResponse.promise; });
  const key = ['wipe', 'w1', { page: 1, serverId: 's1' }];
  const a = client.fetchQuery(key, '/api/v2/wipes/w1/summary', { ttlMs: 10 });
  const b = client.fetchQuery(['wipe', 'w1', { serverId: 's1', page: 1 }], '/api/v2/wipes/w1/summary');
  assert.strictEqual(a, b); assert.equal(callCount, 1); assert.equal(client.getQueryState(key).loading, true);
  resolveResponse.resolve(response({ countScope: 'authorized_members', counts: { eligibleTotal: 2 } }));
  await a; assert.equal(client.getQueryState(key).status, 'success');
  await client.fetchQuery(key, '/api/v2/wipes/w1/summary'); assert.equal(callCount, 1);
  assert.equal(client.getQueryState(['wipe', 'w1', { page: 2, serverId: 's1' }]).data, undefined);
  await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(client.getQueryState(key).stale, true);
  resolveResponse = deferred(); const refresh = client.fetchQuery(key, '/api/v2/wipes/w1/summary');
  assert.equal(client.getQueryState(key).refreshing, true); assert.equal(client.getQueryState(key).loading, false);
  assert.equal(client.getQueryState(key).data.counts.eligibleTotal, 2);
  resolveResponse.resolve(response({ countScope: 'authorized_members', counts: { eligibleTotal: 3 } })); await refresh;
  assert.equal(client.getQueryState(key).data.counts.eligibleTotal, 3);
});

test('same-origin cookies, no HTTP cache, and bootstrap CSRF are mandatory request defaults', async t => {
  let observed;
  const client = clientFor(t, (path, options) => { observed = { path, options }; return Promise.resolve(response({ saved: true })); });
  await client.request('/api/v2/me', { method: 'PATCH', body: { displayName: 'Test' } });
  assert.equal(observed.options.credentials, 'same-origin'); assert.equal(observed.options.cache, 'no-store');
  assert.equal(observed.options.headers.get('X-CSRF-Token'), 'csrf-a1');
  assert.equal(observed.options.headers.get('Content-Type'), 'application/json');
  assert.deepEqual(JSON.parse(observed.options.body), { displayName: 'Test' });
  await client.request('/api/v2/auth/steam/start', { method: 'POST', body: {}, csrfToken: 'onboard' });
  assert.equal(observed.options.headers.get('X-CSRF-Token'), 'onboard');
  for (const path of ['https://example.com/api/v2/me', '//example.com/api/v2/me', '/api/v2/../../other', '/api/v2/\\evil', '/api/v2/me#secret']) {
    await assert.rejects(client.request(path), { errorCode: 'INVALID_API_PATH' });
  }
});

test('switching account cancels every request and rejects late data even when fetch ignores abort', async t => {
  const oldResponse = deferred(); let signal;
  const client = clientFor(t, (_path, options) => { signal = options.signal; return oldResponse.promise; });
  const old = client.fetchQuery(['home'], '/api/v2/me/home');
  const oldResult = assert.rejects(old, { errorCode: 'REQUEST_SUPERSEDED' });
  client.setIdentity({ accountId: 'a2', scopeVersion: 1, csrfToken: 'csrf-a2' });
  assert.equal(signal.aborted, true); await oldResult;
  client.setQueryData(['home'], { account: 'a2' });
  oldResponse.resolve(response({ secret: 'account-a1-only' })); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(client.getQueryState(['home']).data, { account: 'a2' });
  assert.equal(client.getIdentity().csrfToken, 'csrf-a2');
});

test('same account scope change and clearScope fence late body parsing and notify subscribers', async t => {
  const body = deferred(); let notices = 0;
  const client = clientFor(t, () => Promise.resolve({ ok: true, status: 200, json: () => body.promise }));
  const unsubscribe = client.subscribeQuery(['home'], () => notices++); t.after(unsubscribe);
  const before = client.fetchQuery(['home'], '/api/v2/me/home');
  const rejection = assert.rejects(before, { errorCode: 'REQUEST_SUPERSEDED' });
  await Promise.resolve(); client.setIdentity({ accountId: 'a1', scopeVersion: 2, csrfToken: 'new-scope' });
  await rejection; body.resolve({ data: { restricted: true }, meta: { scopeVersion: 1 } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(client.getQueryState(['home']).data, undefined);
  client.setQueryData(['home'], { safe: true }); client.clearScope('authorization-revoked');
  assert.equal(client.getIdentity(), null); assert.equal(client.getQueryState(['home']).data, undefined); assert.ok(notices >= 3);
});

test('same-account scope change prevents a late mutation from returning old current to callers', async t => {
  const remote = deferred(); const client = clientFor(t, () => remote.promise);
  const write = client.request('/api/v2/me', { method: 'PATCH', body: { displayName: 'Old scope' } });
  const rejection = assert.rejects(write, { errorCode: 'REQUEST_SUPERSEDED' });
  client.setIdentity({ accountId: 'a1', scopeVersion: 2, csrfToken: 'scope-2' }); await rejection;
  remote.resolve(response({ current: { displayName: 'Old scope', restricted: true } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.getIdentity().scopeVersion, 2); assert.equal(client.getQueryState('me').data, undefined);
});

test('ordinary scope denial remains local; explicit revocation and 401 clear identity and cache', async t => {
  let next = failure('RESOURCE_FORBIDDEN', 403); const lost = [];
  const client = clientFor(t, () => Promise.resolve(next), { onAuthorizationLost: event => lost.push(event.reason) });
  client.setQueryData('me', { name: 'Visible' });
  await assert.rejects(client.request('/api/v2/wipes/other/summary'), { errorCode: 'RESOURCE_FORBIDDEN' });
  assert.equal(client.getIdentity().accountId, 'a1'); assert.equal(client.getQueryState('me').data.name, 'Visible'); assert.equal(lost.length, 0);
  next = failure('ACCOUNT_DISABLED', 403);
  await assert.rejects(client.request('/api/v2/me'), { errorCode: 'ACCOUNT_DISABLED' });
  assert.equal(client.getIdentity(), null); assert.equal(client.getQueryState('me').data, undefined); assert.deepEqual(lost, ['ACCOUNT_DISABLED']);
  client.setIdentity({ accountId: 'a2', scopeVersion: 2 }); next = failure('AUTH_REQUIRED', 401);
  await assert.rejects(client.request('/api/v2/me'), { errorCode: 'AUTH_REQUIRED' }); assert.equal(client.getIdentity(), null);
  assert.deepEqual(lost, ['ACCOUNT_DISABLED', 'AUTH_REQUIRED']);
});

test('a stale account 401 cannot clear the newly signed-in account', async t => {
  const remote = deferred(); const lost = [];
  const client = clientFor(t, () => remote.promise, { onAuthorizationLost: event => lost.push(event.reason) });
  const pending = client.request('/api/v2/me'); const rejected = assert.rejects(pending, { errorCode: 'REQUEST_SUPERSEDED' });
  client.setIdentity({ accountId: 'a2', scopeVersion: 1 }); await rejected;
  remote.resolve(failure('AUTH_REQUIRED', 401)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.getIdentity().accountId, 'a2'); assert.equal(lost.length, 0);
});

test('scope mismatch in a successful response is rejected before it enters cache', async t => {
  const lost = []; const client = clientFor(t, () => Promise.resolve(response({ restricted: true }, 2)), { onAuthorizationLost: event => lost.push(event.reason) });
  await assert.rejects(client.fetchQuery('me', '/api/v2/me'), { errorCode: 'PERMISSIONS_CHANGED' });
  assert.equal(client.getQueryState('me').data, undefined); assert.deepEqual(lost, ['PERMISSIONS_CHANGED']);
});

test('network refresh failure keeps reliable stale content and explicit retry succeeds', async t => {
  let online = false;
  const client = clientFor(t, () => online ? Promise.resolve(response({ revision: 2 })) : Promise.reject(new TypeError('offline')));
  client.setQueryData('home', { revision: 1 });
  await assert.rejects(client.fetchQuery('home', '/api/v2/me/home', { force: true }), { errorCode: 'NETWORK_UNAVAILABLE' });
  const stale = client.getQueryState('home'); assert.equal(stale.status, 'error'); assert.equal(stale.stale, true); assert.equal(stale.data.revision, 1);
  online = true; await client.fetchQuery('home', '/api/v2/me/home', { force: true }); assert.equal(client.getQueryState('home').data.revision, 2);
});

test('timeouts and explicit cancellation settle even if the transport ignores AbortSignal', async t => {
  const client = clientFor(t, () => new Promise(() => {}), { defaultTimeoutMs: 8 });
  await assert.rejects(client.request('/api/v2/me'), { errorCode: 'REQUEST_TIMEOUT' });
  const controller = new AbortController(); const request = client.request('/api/v2/me', { signal: controller.signal, timeoutMs: 0 });
  const rejection = assert.rejects(request, { errorCode: 'REQUEST_CANCELLED' }); controller.abort(); await rejection;
  assert.equal(client.getIdentity().accountId, 'a1');
});

test('invalidation cancels a stale fetch and refetches only active matching resources', async t => {
  const old = deferred(); let calls = 0;
  const client = clientFor(t, () => ++calls === 1 ? old.promise : Promise.resolve(response({ revision: 2 })));
  const unsubscribe = client.subscribeQuery(['wipe', 'w1'], () => {}); t.after(unsubscribe);
  client.setQueryData(['team'], { name: 'Team' });
  const pending = client.fetchQuery(['wipe', 'w1'], '/api/v2/wipes/w1/summary');
  const rejection = assert.rejects(pending, { errorCode: 'REQUEST_CANCELLED' });
  client.invalidateQueries(['wipe']); await rejection; await new Promise(resolve => setImmediate(resolve));
  old.resolve(response({ revision: 1 })); await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.getQueryState(['wipe', 'w1']).data.revision, 2); assert.equal(client.getQueryState(['team']).stale, false); assert.equal(calls, 2);
});

test('last query observer leaving cancels route request; canonical keys preserve range separation', async t => {
  const client = clientFor(t, () => new Promise(() => {}));
  const unsubscribe = client.subscribeQuery(['detail', 'w1'], () => {});
  const pending = client.fetchQuery(['detail', 'w1'], '/api/v2/wipes/w1/summary');
  const rejection = assert.rejects(pending, { errorCode: 'REQUEST_CANCELLED' }); unsubscribe(); await rejection;
  assert.equal(client.getQueryState(['detail', 'w1']).status, 'idle');
  assert.notEqual(queryKey(['stats', { wipeId: 'w1' }]), queryKey(['stats', { wipeId: 'w2' }]));
});

test('overlapping invalidations cancel stale work but coalesce replacement requests for active resources', async t => {
  const old = deferred(); let calls = 0;
  const client = clientFor(t, () => ++calls === 1 ? old.promise : Promise.resolve(response({ revision: 2 })));
  const unsubscribe = client.subscribeQuery(['wipe', 'w1'], () => {}); t.after(unsubscribe);
  const pending = client.fetchQuery(['wipe', 'w1'], '/api/v2/wipes/w1/summary');
  const rejected = assert.rejects(pending, { errorCode: 'REQUEST_CANCELLED' });
  for (let n = 0; n < 30; n++) {
    client.invalidateQueries(['wipe']);
    client.invalidateQueries(['wipe', 'w1']);
  }
  await rejected; await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2, 'one old request and one replacement, regardless of overlapping events');
  old.resolve(response({ revision: 1 })); await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.getQueryState(['wipe', 'w1']).data.revision, 2);
});

test('queued invalidation cannot refetch after observers leave, refetch is disabled, or account changes', async t => {
  let calls = 0;
  const client = clientFor(t, () => { calls++; return Promise.resolve(response({ revision: 1 })); });
  let unsubscribe = client.subscribeQuery(['home'], () => {});
  await client.fetchQuery(['home'], '/api/v2/me/home');
  client.invalidateQueries(['home']); unsubscribe();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
  unsubscribe = client.subscribeQuery(['home'], () => {}); t.after(unsubscribe);
  client.invalidateQueries(['home']); client.invalidateQueries(['home'], { refetch: false });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
  client.invalidateQueries(['home']); client.setIdentity({ accountId: 'a2', scopeVersion: 1 });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
});

test('explicit cancellation and authoritative cache updates cancel a queued invalidation refresh', async t => {
  let calls = 0;
  const client = clientFor(t, () => { calls++; return Promise.resolve(response({ revision: 1 })); });
  const unsubscribe = client.subscribeQuery(['home'], () => {}); t.after(unsubscribe);
  await client.fetchQuery(['home'], '/api/v2/me/home');
  client.invalidateQueries(['home']); client.cancelQuery(['home']);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
  client.invalidateQueries(['home']); client.setQueryData(['home'], { revision: 2 }, { ttlMs: 0 });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
  assert.equal(client.getQueryState(['home']).data.revision, 2);
});
