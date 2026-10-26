import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueryClient } from '../src/v2/query-client.js';
import { createProfileOperation, dismissProfileOperation, getProfileOperation } from '../src/v2/profile-operation.js';

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const current = (revision, displayName = `Name ${revision}`) => ({ profile: { revision, displayName, specialty: ['建筑'], timeZone: 'Asia/Shanghai', theme: 'light' }, editableFields: ['displayName', 'specialty', 'timeZone', 'theme'], bindings: { steam: { status: 'verified' }, platforms: [] } });
const body = (expectedRevision = 1, displayName = 'New name') => ({ expectedRevision, displayName, specialty: ['建筑'], timeZone: 'Asia/Shanghai', theme: 'light' });
const response = (revision = 2, receiptRevision = revision) => new Response(JSON.stringify({ data: { current: current(revision),
  operationReceipt: { operationId: 'p1', revision: receiptRevision, result: 'committed' }, replayed: revision !== receiptRevision }, meta: { scopeVersion: 1 } }));
function setup(t, fetchImpl, options = {}) {
  const client = createQueryClient({ fetchImpl, defaultTimeoutMs: 12, ...options });
  client.setIdentity({ accountId: 'a1', scopeVersion: 1, csrfToken: 'csrf1' }); t.after(() => client.dispose()); return client;
}

test('rapid duplicate saves have one in-flight request, one immutable payload, and one operation key', async t => {
  let calls = 0; const reply = deferred(), client = setup(t, () => { calls++; return reply.promise; });
  const input = body(), operation = createProfileOperation(client, { body: input, operationId: 'p1' });
  input.specialty.push('侦察'); input.displayName = 'Mutated later';
  assert.equal(operation.body.displayName, 'New name'); assert.deepEqual(operation.body.specialty, ['建筑']);
  assert.throws(() => operation.body.specialty.push('Changed'), TypeError);
  const one = operation.submit(), two = operation.submit(), three = operation.retry();
  assert.strictEqual(one, two); assert.strictEqual(one, three); assert.equal(calls, 1);
  reply.resolve(response()); assert.equal((await one).status, 'committed');
});

test('an unknown profile save survives leaving/returning and retries exact original bytes and key', async t => {
  const requests = []; let calls = 0;
  const client = setup(t, (_path, options) => { requests.push({ body: options.body, key: options.headers.get('Idempotency-Key') });
    return ++calls === 1 ? new Promise(() => {}) : Promise.resolve(response()); });
  const original = createProfileOperation(client, { body: body(), operationId: 'p1' });
  const unsubscribe = original.subscribe(() => {}); assert.equal((await original.submit()).status, 'unknown'); unsubscribe();
  const returnedToPage = getProfileOperation(client); assert.strictEqual(returnedToPage, original);
  assert.equal(dismissProfileOperation(client, original), false);
  assert.throws(() => createProfileOperation(client, { body: body(1, 'Different intent') }), { errorCode: 'PROFILE_OPERATION_PENDING' });
  assert.equal((await returnedToPage.retry()).status, 'committed');
  assert.equal(requests.length, 2); assert.deepEqual(requests[0], requests[1]);
  assert.equal(client.getQueryState(['me']).data.profile.revision, 2);
});

test('a save finishing while its page is absent updates shared cache and current profile exactly once', async t => {
  const remote = deferred(), adopted = [], client = setup(t, () => remote.promise);
  const operation = createProfileOperation(client, { body: body(), operationId: 'p1', onCommitted: data => adopted.push(data.profile.revision) });
  const unsubscribe = operation.subscribe(() => {}), pending = operation.submit(); unsubscribe();
  remote.resolve(response(3, 2)); await pending;
  assert.equal(getProfileOperation(client).getState().current.profile.revision, 3);
  assert.equal(client.getQueryState(['me']).data.profile.revision, 3); assert.deepEqual(adopted, [3]);
});

test('an older successful response cannot downgrade a profile revision already established by another read', async t => {
  const remote = deferred(), adopted = [], client = setup(t, () => remote.promise);
  const operation = createProfileOperation(client, { body: body(), operationId: 'p1', onCommitted: data => adopted.push(data.profile.displayName) });
  const pending = operation.submit(); client.setQueryData(['me'], current(4, 'Latest confirmed name'));
  remote.resolve(response(2)); const result = await pending;
  assert.equal(result.operationReceipt.revision, 2); assert.equal(result.current.profile.revision, 4);
  assert.equal(client.getQueryState(['me']).data.profile.displayName, 'Latest confirmed name'); assert.deepEqual(adopted, ['Latest confirmed name']);
});

test('a timed-out old transport cannot overwrite or clear a later profile operation', async t => {
  const oldTransport = deferred(), nextTransport = deferred(); let calls = 0;
  const client = setup(t, () => ++calls === 1 ? oldTransport.promise : calls === 2 ? Promise.resolve(response(2)) : nextTransport.promise);
  const old = createProfileOperation(client, { body: body(), operationId: 'p1' });
  assert.equal((await old.submit()).status, 'unknown'); await old.retry();
  const next = createProfileOperation(client, { body: body(2, 'Third revision'), operationId: 'p2' });
  const pending = next.submit(); oldTransport.resolve(response(2)); await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(getProfileOperation(client), next); assert.equal(next.getState().status, 'submitting');
  assert.equal(next.body.expectedRevision, 2); nextTransport.resolve(response(3)); await pending;
  assert.equal(client.getQueryState(['me']).data.profile.revision, 3); assert.strictEqual(getProfileOperation(client), next);
});

test('a damaged HTTP 200 response remains unknown and retains the same retryable save', async t => {
  let calls = 0; const client = setup(t, () => Promise.resolve(++calls === 1 ? new Response('{broken json', { status: 200 }) : response()));
  const operation = createProfileOperation(client, { body: body(), operationId: 'p1' });
  assert.equal((await operation.submit()).status, 'unknown'); assert.equal(operation.getState().error.errorCode, 'INVALID_RESPONSE');
  assert.strictEqual(getProfileOperation(client), operation); assert.equal((await operation.retry()).status, 'committed');
});

test('conflicts require an explicit latest-profile read/new operation and do not automatically rewrite revision', async t => {
  let calls = 0; const client = setup(t, () => { calls++; return Promise.resolve(new Response(JSON.stringify({ error: { errorCode: 'REVISION_CONFLICT', current: current(3) } }), { status: 409 })); });
  const operation = createProfileOperation(client, { body: body(), operationId: 'p1' });
  assert.equal((await operation.submit()).status, 'conflict'); await operation.retry(); assert.equal(calls, 1);
  assert.equal(operation.body.expectedRevision, 1); assert.equal(dismissProfileOperation(client, operation), true);
  assert.equal(getProfileOperation(client), null);
  const confirmed = createProfileOperation(client, { body: body(3), operationId: 'p2' });
  assert.equal(confirmed.body.expectedRevision, 3); assert.notEqual(confirmed.operationId, operation.operationId);
});

test('scope change clears pending profile material and a late success cannot update cache or session', async t => {
  const remote = deferred(), adopted = [], client = setup(t, () => remote.promise);
  const operation = createProfileOperation(client, { body: body(), operationId: 'p1', onCommitted: data => adopted.push(data) });
  const pending = operation.submit(); client.setIdentity({ accountId: 'a1', scopeVersion: 2, csrfToken: 'new-scope' });
  assert.equal(getProfileOperation(client), null); assert.equal(operation.body, null);
  remote.resolve(response()); await pending;
  assert.equal(client.getQueryState(['me']).data, undefined); assert.equal(adopted.length, 0); assert.equal(operation.getState().status, 'cancelled');
});
