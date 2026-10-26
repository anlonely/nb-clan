import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueryClient } from '../src/v2/query-client.js';
import { createSignupOperation } from '../src/v2/signup-operation.js';

const body = () => ({ response: 'attending_on_time', expectedArrivalAt: null, timeZone: 'Asia/Shanghai', expectedSignupRevision: 0, confirmedContentRevision: 1 });
const response = data => new Response(JSON.stringify({ data, meta: { scopeVersion: 1 } }));
const failure = (errorCode, status, current) => new Response(JSON.stringify({ error: { errorCode, current } }), { status });
const result = (revision = 1, receiptRevision = 1) => ({ operationReceipt: { operationId: 'op1', signupRevision: receiptRevision, result: 'committed' },
  current: { response: revision === 1 ? 'attending_on_time' : 'not_attending', signupRevision: revision }, replayed: revision !== receiptRevision });
function setup(t, fetchImpl, options = {}) {
  const client = createQueryClient({ fetchImpl, ...options }); t.after(() => client.dispose());
  client.setIdentity({ accountId: 'a1', scopeVersion: 1, csrfToken: 'csrf' });
  return { client, operation: createSignupOperation(client, { wipeId: 'w1', body: body(), operationId: 'op1', timeoutMs: 10 }) };
}

test('double submit shares one write; original body is cloned and deeply frozen', async t => {
  let calls = 0, finish; const client = createQueryClient({ fetchImpl: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  t.after(() => client.dispose()); client.setIdentity({ accountId: 'a1', scopeVersion: 1 });
  const input = body(), operation = createSignupOperation(client, { wipeId: 'w1', body: input, operationId: 'op1' });
  input.response = 'not_attending'; assert.equal(operation.body.response, 'attending_on_time');
  assert.throws(() => { operation.body.expectedSignupRevision = 7; }, TypeError);
  const first = operation.submit(), second = operation.submit(); assert.equal(calls, 1); finish(response(result()));
  assert.equal((await first).status, 'committed'); assert.equal((await second).status, 'committed'); assert.equal(calls, 1);
});

test('timeout then temporary receipt 404 remains unknown; retry preserves exact key/body bytes', async t => {
  const requests = []; let calls = 0;
  const { operation } = setup(t, (path, options) => {
    requests.push({ path, body: options.body, key: options.headers.get('Idempotency-Key') });
    calls++; if (calls === 1) return new Promise(() => {});
    if (calls === 2) return Promise.resolve(failure('RESOURCE_NOT_FOUND', 404));
    return Promise.resolve(response(result(3, 1)));
  });
  assert.equal((await operation.submit()).status, 'unknown');
  assert.equal((await operation.reconcile()).status, 'unknown');
  const confirmed = await operation.retry(); assert.equal(confirmed.status, 'committed');
  assert.equal(confirmed.current.signupRevision, 3); assert.equal(confirmed.operationReceipt.signupRevision, 1);
  assert.equal(confirmed.current.response, 'not_attending'); assert.equal(requests[1].path, '/api/v2/operations/op1');
  assert.equal(requests[0].key, requests[2].key); assert.equal(requests[0].body, requests[2].body);
  assert.equal(requests[2].body, JSON.stringify(body()));
});

test('unknown write can be reconciled by actual receipt and uses current instead of receipt revision', async t => {
  let calls = 0;
  const { operation } = setup(t, () => ++calls === 1 ? Promise.reject(new TypeError('connection lost')) : Promise.resolve(response(result(2, 1))));
  assert.equal((await operation.submit()).status, 'unknown');
  const current = await operation.reconcile(); assert.equal(current.status, 'committed'); assert.equal(current.current.signupRevision, 2); assert.equal(current.replayed, true);
});

for (const errorCode of ['REVISION_CONFLICT']) {
  test(`${errorCode} requires explicit new confirmation; retry cannot rewrite old revisions`, async t => {
    let writes = 0;
    const { client, operation } = setup(t, () => { writes++; return Promise.resolve(failure(errorCode, 409, { signupRevision: 3, confirmedContentRevision: 2 })); });
    const conflict = await operation.submit(); assert.equal(conflict.status, 'conflict'); assert.equal(conflict.error.errorCode, errorCode);
    assert.equal(conflict.current.signupRevision, 3); await operation.retry(); assert.equal(writes, 1);
    assert.equal(operation.body.expectedSignupRevision, 0); assert.equal(operation.body.confirmedContentRevision, 1);
    const confirmedNewOperation = createSignupOperation(client, { wipeId: 'w1', operationId: 'op2', body: { ...body(), expectedSignupRevision: 3, confirmedContentRevision: 2 } });
    assert.notEqual(confirmedNewOperation.operationId, operation.operationId); assert.equal(confirmedNewOperation.body.confirmedContentRevision, 2);
  });
}

test('server uncertainty stays unknown but definitive input rejection fails without retry', async t => {
  let calls = 0;
  const { operation } = setup(t, () => { calls++; return Promise.resolve(failure(calls === 1 ? 'SCHEDULING_UNAVAILABLE' : 'SIGNUP_CLOSED', calls === 1 ? 500 : 409)); });
  assert.equal((await operation.submit()).status, 'unknown'); assert.equal((await operation.retry()).status, 'failed');
  await operation.retry(); assert.equal(calls, 2);
});

test('account/scope revocation clears pending body and ignores a late successful write', async t => {
  let finish;
  const { client, operation } = setup(t, () => new Promise(resolve => { finish = resolve; }));
  const pending = operation.submit(); client.clearScope('authorization-revoked');
  assert.equal(operation.body, null); assert.equal(operation.getState().status, 'cancelled');
  finish(response(result())); await pending;
  assert.equal(operation.getState().current, null); assert.equal(operation.getState().operationReceipt, null);
  client.setIdentity({ accountId: 'a2', scopeVersion: 1 }); assert.equal((await operation.retry()).status, 'cancelled');
});
