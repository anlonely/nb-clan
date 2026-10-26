import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueryClient } from '../src/v2/query-client.js';
import { createAdminOperation, persistAdminOperation, restoreAdminOperation, clearAdminOperation,
  getAdminOperationSnapshot, subscribeAdminOperations, listPendingAdminOperations } from '../src/v2/admin/operation.js';

function memoryStorage() {
  const records = new Map();
  return { get length() { return records.size; }, key: i => [...records.keys()][i] ?? null,
    getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, String(value)), removeItem: key => records.delete(key) };
}
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
test.beforeEach(() => Object.defineProperty(globalThis, 'sessionStorage', { value: memoryStorage(), configurable: true }));
test.afterEach(() => { if (originalStorage) Object.defineProperty(globalThis, 'sessionStorage', originalStorage); else delete globalThis.sessionStorage; });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const input = () => ({ expectedRevision: 1, reason: '管理员已确认', targets: [{ targetId: 'local-kook', language: 'zh-CN', mention: { mode: 'none', roleIds: [] } }] });
const result = (operationId = 'op1', current = { id: 'w1', revision: 2 }, extra = {}) => ({ current, replayed: false,
  operationReceipt: { operationId, committedAt: '2026-09-08T00:00:00.000Z', action: 'wipe.publish', wipeId: 'w1' }, ...extra });
const response = (data = result(), status = 200) => new Response(JSON.stringify({ data, meta: { scopeVersion: 1 } }), { status });
const failure = (errorCode, status, current) => new Response(JSON.stringify({ error: { errorCode, current } }), { status });
function clientFor(t, fetchImpl, identity = { accountId: 'a1', scopeVersion: 1, csrfToken: 'secret-csrf' }) {
  const client = createQueryClient({ fetchImpl, defaultTimeoutMs: 15 }); client.setIdentity(identity); t.after(() => client.dispose()); return client;
}
const operationFor = (client, options = {}) => createAdminOperation(client, { path: '/api/v2/wipes/w1/commands/publish', body: input(), operationId: 'op1', ...options });
const journals = () => Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.getItem(sessionStorage.key(i)));

test('synchronous duplicate submits share one promise and the first deeply frozen request bytes', async t => {
  const requests = [], pending = deferred(), client = clientFor(t, (path, options) => {
    assert.equal(JSON.parse(journals()[0]).status, 'unknown', 'journal precedes the transport');
    requests.push({ path, body: options.body, key: options.headers.get('Idempotency-Key') }); return pending.promise;
  });
  const body = input(), operation = operationFor(client, { body });
  body.targets[0].mention.mode = 'everyone'; body.targets.push({ targetId: 'changed' });
  assert.equal(operation.body.targets[0].mention.mode, 'none'); assert.equal(operation.body.targets.length, 1);
  assert.throws(() => operation.body.targets[0].mention.roleIds.push('changed'), TypeError);
  assert.throws(() => { operation.path = '/api/v2/changed'; }, TypeError);
  let subscriberPromise; operation.subscribe(() => { if (operation.getState().status === 'submitting') subscriberPromise = operation.retry(); });
  const first = operation.submit(); assert.strictEqual(first, subscriberPromise); assert.strictEqual(first, operation.submit());
  assert.equal(requests.length, 1); pending.resolve(response()); assert.equal((await first).status, 'committed');
  assert.equal(requests[0].body, JSON.stringify(input())); assert.equal(sessionStorage.length, 0);
});

test('HTTP 202 with the persisted intent receipt is committed while current remains queued, not sent', async t => {
  const current = { id: 'intent1', status: 'queued', counts: { total: 1, queued: 1, sent: 0 }, revision: 1 };
  const client = clientFor(t, () => Promise.resolve(response(result('op1', current), 202)));
  const operation = operationFor(client, { path: '/api/v2/wipes/w1/publish-intents', domain: 'notifications' });
  const state = await operation.submit(); assert.equal(state.status, 'committed'); assert.equal(state.current.status, 'queued');
  assert.equal(state.current.counts.sent, 0); assert.equal(state.operationReceipt.operationId, 'op1');
});

for (const [label, data] of [
  ['missing current', { ...result(), current: null }], ['missing receipt', { ...result(), operationReceipt: null }],
  ['wrong receipt key', result('another-operation')], ['invalid receipt timestamp', { ...result(), operationReceipt: { ...result().operationReceipt, committedAt: 'bad-date' } }],
  ['missing replayed flag', { current: result().current, operationReceipt: result().operationReceipt }]
]) test(`invalid mutation envelope (${label}) stays unknown and cannot be reset`, async t => {
  const client = clientFor(t, () => Promise.resolve(response(data))), operation = operationFor(client);
  persistAdminOperation(client, 'wipe:w1', operation);
  assert.equal((await operation.submit()).status, 'unknown'); assert.equal(operation.getState().error.errorCode, 'INVALID_RESPONSE');
  assert.equal(clearAdminOperation(client, 'wipe:w1'), false); assert.equal(sessionStorage.length, 1);
});

test('timeout and temporary scheduling receipt 404 preserve exact body/key for an explicit retry', async t => {
  const requests = []; let calls = 0;
  const client = clientFor(t, (path, options) => {
    requests.push({ path, body: options.body, key: options.headers.get('Idempotency-Key') });
    if (++calls === 1) return new Promise(() => {});
    return Promise.resolve(calls === 2 ? failure('RESOURCE_NOT_FOUND', 404) : response(result('op1', { id: 'w1', revision: 7 }, { replayed: true })));
  });
  const operation = operationFor(client); persistAdminOperation(client, 'wipe:w1', operation);
  assert.equal((await operation.submit()).status, 'unknown'); assert.equal((await operation.reconcile()).status, 'unknown');
  assert.equal(clearAdminOperation(client, 'wipe:w1'), false);
  const confirmed = await operation.retry(); assert.equal(confirmed.status, 'committed'); assert.equal(confirmed.current.revision, 7);
  assert.equal(requests[1].path, '/api/v2/operations/op1'); assert.deepEqual(requests[2], requests[0]); assert.equal(confirmed.replayed, true);
});

test('notification reconciliation uses its separate operation namespace and never resends', async t => {
  const paths = []; const client = clientFor(t, (path, options) => { paths.push([path, options.method]);
    return paths.length === 1 ? Promise.reject(new TypeError('offline')) : Promise.resolve(response()); });
  const operation = operationFor(client, { domain: 'notifications', path: '/api/v2/wipes/w1/notification-previews' });
  assert.equal((await operation.submit()).status, 'unknown'); assert.equal((await operation.reconcile()).status, 'committed');
  assert.deepEqual(paths, [['/api/v2/wipes/w1/notification-previews', 'POST'], ['/api/v2/notifications/operations/op1', 'GET']]);
});

test('route remount retains the same operation and terminal state until explicit reset', async t => {
  const waiting = deferred(), client = clientFor(t, () => waiting.promise), operation = operationFor(client);
  persistAdminOperation(client, 'wipe:w1', operation);
  let updates = 0; const unsubscribe = subscribeAdminOperations(client, () => updates++);
  const pending = operation.submit(); unsubscribe();
  assert.strictEqual(restoreAdminOperation(client, 'wipe:w1'), operation);
  const before = getAdminOperationSnapshot(client, 'wipe:w1'); assert.strictEqual(before, getAdminOperationSnapshot(client, 'wipe:w1'));
  waiting.resolve(response()); await pending;
  const completed = getAdminOperationSnapshot(client, 'wipe:w1'); assert.equal(completed.state.status, 'committed'); assert.notStrictEqual(before, completed);
  assert.equal(updates, 1); assert.equal(clearAdminOperation(client, 'wipe:w1'), true); assert.equal(getAdminOperationSnapshot(client, 'wipe:w1').operation, null);
});

test('refresh restores only the same account/scope command as unknown, then retries exact persisted bytes', async t => {
  const requests = []; const client = clientFor(t, (path, options) => { requests.push({ path, body: options.body, key: options.headers.get('Idempotency-Key') });
    return requests.length === 1 ? Promise.reject(new TypeError('offline')) : Promise.resolve(response()); });
  const original = operationFor(client); persistAdminOperation(client, 'wipe:w1', original); await original.submit();
  const journal = journals()[0]; assert.ok(!journal.includes('secret-csrf')); assert.ok(!journal.includes('csrfToken')); assert.ok(!journal.includes('cookie'));
  original.dispose(); assert.equal(sessionStorage.length, 1);
  const restored = restoreAdminOperation(client, 'wipe:w1'); assert.notStrictEqual(restored, original);
  assert.equal(restored.getState().status, 'unknown'); assert.equal(restored.getState().error.errorCode, 'ADMIN_OPERATION_RESTORED');
  assert.equal(requests.length, 1); assert.equal(restored.path, original.path); assert.equal(restored.method, 'POST'); assert.equal(restored.domain, 'scheduling');
  assert.equal(restored.operationId, 'op1'); assert.deepEqual(restored.body, input());
  assert.equal((await restored.retry()).status, 'committed'); assert.deepEqual(requests[0], requests[1]);
});

test('a fresh query client can recover the same account session without receiving CSRF from storage', async t => {
  const first = clientFor(t, () => Promise.reject(new TypeError('offline'))), original = operationFor(first);
  persistAdminOperation(first, 'wipe:w1', original); await original.submit(); original.dispose();
  const requests = [], next = clientFor(t, (path, options) => { requests.push({ path, csrf: options.headers.get('X-CSRF-Token') }); return Promise.resolve(response()); },
    { accountId: 'a1', scopeVersion: 1, csrfToken: 'new-csrf' });
  const restored = restoreAdminOperation(next, 'wipe:w1'); assert.equal(restored.getState().status, 'unknown');
  await restored.retry(); assert.equal(requests[0].csrf, 'new-csrf');
});

test('unknown slot cannot be overwritten or cleared before restoration; separate slots do not interfere', async t => {
  const client = clientFor(t, () => Promise.reject(new TypeError('offline'))), first = operationFor(client);
  persistAdminOperation(client, 'wipe:w1', first); await first.submit();
  const other = operationFor(client, { operationId: 'op2' });
  assert.throws(() => persistAdminOperation(client, 'wipe:w1', other), { errorCode: 'ADMIN_OPERATION_PENDING' });
  persistAdminOperation(client, 'notification:w1', other); assert.equal(sessionStorage.length, 2);
  first.dispose(); assert.equal(clearAdminOperation(client, 'wipe:w1'), false);
  const restored = restoreAdminOperation(client, 'wipe:w1'); assert.equal(restored.operationId, 'op1'); assert.equal(clearAdminOperation(client, 'wipe:w1'), false);
  assert.equal(getAdminOperationSnapshot(client, 'notification:w1').operation.operationId, 'op2');
});

test('storage write failure prevents any request; the original command can retry when storage becomes writable', async t => {
  let calls = 0; const client = clientFor(t, () => { calls++; return Promise.resolve(response()); }), operation = operationFor(client);
  const target = sessionStorage, originalSet = target.setItem; target.setItem = () => { throw new Error('quota'); };
  const failed = await operation.submit(); assert.equal(failed.status, 'failed'); assert.equal(failed.error.errorCode, 'ADMIN_OPERATION_STORAGE_UNAVAILABLE'); assert.equal(calls, 0);
  target.setItem = originalSet; assert.equal((await operation.retry()).status, 'committed'); assert.equal(calls, 1);
});

test('storage failure during an unknown retry keeps the existing unknown journal and allows read-only reconciliation', async t => {
  let calls = 0; const client = clientFor(t, () => ++calls === 1 ? Promise.reject(new TypeError('offline')) : Promise.resolve(response())), operation = operationFor(client);
  persistAdminOperation(client, 'wipe:w1', operation); await operation.submit();
  const saved = journals()[0]; sessionStorage.setItem = () => { throw new Error('quota'); };
  assert.equal((await operation.retry()).status, 'unknown'); assert.equal(calls, 1); assert.equal(journals()[0], saved);
  assert.equal((await operation.reconcile()).status, 'committed'); assert.equal(calls, 2);
});

test('idempotency collision remains unknown even when the colliding key has a readable receipt', async t => {
  let calls = 0; const client = clientFor(t, () => Promise.resolve(++calls === 1 ? failure('IDEMPOTENCY_CONFLICT', 409) : response()));
  const operation = operationFor(client); persistAdminOperation(client, 'wipe:w1', operation);
  assert.equal((await operation.submit()).status, 'unknown'); assert.equal(clearAdminOperation(client, 'wipe:w1'), false);
  operation.dispose(); const restored = restoreAdminOperation(client, 'wipe:w1');
  assert.equal(restored.getState().error.errorCode, 'IDEMPOTENCY_CONFLICT');
  const checked = await restored.reconcile(); assert.equal(checked.status, 'unknown'); assert.equal(checked.error.errorCode, 'IDEMPOTENCY_CONFLICT');
  assert.equal(checked.operationReceipt.operationId, 'op1'); assert.equal(clearAdminOperation(client, 'wipe:w1'), false);
});

test('revision conflict allows explicit reset and a newly confirmed body/key; old operation never auto-retries', async t => {
  let calls = 0; const client = clientFor(t, () => { calls++; return Promise.resolve(failure('REVISION_CONFLICT', 409, { id: 'w1', revision: 3 })); });
  const operation = operationFor(client); persistAdminOperation(client, 'wipe:w1', operation);
  assert.equal((await operation.submit()).status, 'conflict'); assert.equal(operation.getState().current.revision, 3);
  await operation.retry(); assert.equal(calls, 1); assert.equal(clearAdminOperation(client, 'wipe:w1'), true);
  const confirmed = operationFor(client, { operationId: 'op2', body: { ...input(), expectedRevision: 3 } });
  persistAdminOperation(client, 'wipe:w1', confirmed); assert.equal(confirmed.body.expectedRevision, 3); assert.equal(confirmed.operationId, 'op2');
});

test('account/scope generation change clears all G06 journals and rejects late success from every slot', async t => {
  const waiting = deferred(), client = clientFor(t, () => waiting.promise), operation = operationFor(client);
  persistAdminOperation(client, 'wipe:w1', operation); const pending = operation.submit();
  const second = operationFor(client, { operationId: 'op2' }); persistAdminOperation(client, 'notification:w1', second);
  sessionStorage.setItem('unrelated-session-setting', 'keep');
  client.setIdentity({ accountId: 'a2', scopeVersion: 2, csrfToken: 'new' });
  assert.equal(operation.body, null); assert.equal(second.body, null); assert.equal(operation.getState().status, 'cancelled');
  assert.deepEqual(journals(), ['keep']); assert.equal(restoreAdminOperation(client, 'wipe:w1'), null);
  waiting.resolve(response()); await pending; assert.equal(operation.getState().current, null); assert.equal(operation.getState().operationReceipt, null);
});

test('same account permission change also fences old persisted commands', async t => {
  const client = clientFor(t, () => Promise.reject(new TypeError('offline'))), operation = operationFor(client);
  persistAdminOperation(client, 'wipe:w1', operation); await operation.submit(); client.setIdentity({ accountId: 'a1', scopeVersion: 2 });
  assert.equal(sessionStorage.length, 0); assert.equal(restoreAdminOperation(client, 'wipe:w1'), null); assert.equal((await operation.retry()).status, 'cancelled');
});

test('a different account in a fresh client cannot restore old commands and purges their journals', async t => {
  const first = clientFor(t, () => Promise.reject(new TypeError('offline'))), operation = operationFor(first);
  persistAdminOperation(first, 'wipe:w1', operation); await operation.submit(); operation.dispose();
  const next = clientFor(t, () => assert.fail('must not replay'), { accountId: 'a2', scopeVersion: 1 });
  assert.equal(restoreAdminOperation(next, 'wipe:w1'), null); assert.equal(sessionStorage.length, 0);
});

test('unsafe endpoints, missing identity, invalid bodies and credential fields are rejected before storage or transport', t => {
  const client = clientFor(t, () => assert.fail('must not write'));
  for (const path of ['https://example.invalid/api/v2/wipes', '/api/v2/../../unsafe', '/api/v2/wipes?redirect=bad']) assert.throws(() => operationFor(client, { path }), { errorCode: 'INVALID_API_PATH' });
  for (const key of ['csrfToken', 'cookie', 'access_token', 'Authorization', 'token']) assert.throws(() => operationFor(client, { body: { [key]: 'private' } }), { errorCode: 'ADMIN_OPERATION_SECRET_NOT_ALLOWED' });
  assert.throws(() => operationFor(client, { body: [] }), { errorCode: 'INVALID_ADMIN_OPERATION' });
  assert.throws(() => operationFor(client, { operationId: 'bad key' }), { errorCode: 'IDEMPOTENCY_KEY_REQUIRED' });
  client.clearIdentity(); assert.throws(() => operationFor(client), { errorCode: 'AUTH_REQUIRED' }); assert.equal(sessionStorage.length, 0);
});

test('global recovery enumerates hidden delegated operations from storage without selecting a member or issuing any request', async t => {
  let calls = 0; const client = clientFor(t, () => { calls++; return Promise.reject(new TypeError('offline')); });
  const first = operationFor(client, { path: '/api/v2/wipes/w1/signups/member-not-on-this-page', operationId: 'delegate1' });
  const second = operationFor(client, { path: '/api/v2/wipes/w2/notification-previews', domain: 'notifications', operationId: 'preview2' });
  persistAdminOperation(client, 'delegate:w1:member-not-on-this-page', first); await first.submit();
  persistAdminOperation(client, 'notification:w2', second); await second.submit(); first.dispose(); second.dispose();
  const pending = listPendingAdminOperations(client);
  assert.equal(pending.length, 2); assert.deepEqual(pending.map(x => x.slot), ['delegate:w1:member-not-on-this-page', 'notification:w2']);
  assert.equal(pending[0].operation.operationId, 'delegate1'); assert.equal(pending[0].operation.getState().status, 'unknown');
  assert.equal(pending[1].operation.domain, 'notifications'); assert.equal(calls, 2, 'enumeration and restoration never call the transport');
  assert.strictEqual(listPendingAdminOperations(client)[0].operation, pending[0].operation);
  assert.equal(clearAdminOperation(client, pending[0].slot), false);
});

test('global recovery includes an in-flight command but excludes definitive terminal results', async t => {
  const waiting = deferred(); const client = clientFor(t, () => waiting.promise);
  const operation = operationFor(client); persistAdminOperation(client, 'wipe:w1', operation); const promise = operation.submit();
  assert.equal(listPendingAdminOperations(client)[0].operation.getState().status, 'submitting');
  waiting.resolve(response()); await promise; assert.deepEqual(listPendingAdminOperations(client), []);
  assert.equal(getAdminOperationSnapshot(client, 'wipe:w1').state.status, 'committed', 'enumeration leaves terminal state for its page to consume');
});

test('global recovery retains in-memory unknown operations when storage becomes unavailable', async t => {
  const client = clientFor(t, () => Promise.reject(new TypeError('offline'))), operation = operationFor(client);
  persistAdminOperation(client, 'wipe:w1', operation); await operation.submit();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw new Error('blocked'); } });
  const pending = listPendingAdminOperations(client); assert.equal(pending.length, 1); assert.strictEqual(pending[0].operation, operation);
});

test('global recovery cannot enumerate another account or an older permission scope', async t => {
  const client = clientFor(t, () => Promise.reject(new TypeError('offline'))), operation = operationFor(client);
  persistAdminOperation(client, 'wipe:w1', operation); await operation.submit(); operation.dispose();
  const next = clientFor(t, () => assert.fail('must not query'), { accountId: 'a1', scopeVersion: 2 });
  assert.deepEqual(listPendingAdminOperations(next), []); assert.equal(sessionStorage.length, 0);
  next.clearIdentity(); assert.deepEqual(listPendingAdminOperations(next), []);
});
