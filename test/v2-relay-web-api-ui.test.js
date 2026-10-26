import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebApiState, webApiHasCredentials } from '../src/v2/relay-admin/web-api-state.js';

const id = '33333333-3333-4333-8333-333333333333';
const secret = 'fixture-web-api-key-do-not-persist';
const config = overrides => ({ revision: 4, baseUrl: 'https://rust-go.example/api/v1', tenantId: '',
  apiKeyConfigured: true, serverIds: ['live', 'paused'], infoEnabled: true, chatEnabled: false,
  canWrite: true, status: { state: 'ok' }, lastOperationId: null, ...overrides });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function setup(initial = config()) {
  const storage = new Map(), calls = [], changes = [];
  let generation = 1, identity = { accountId: 'a' }, handler = async () => ({ data: initial });
  const session = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  const client = { getGeneration: () => generation, getIdentity: () => identity, request: async (path, options = {}) => {
    calls.push({ path, ...options, ...(options.body ? { body: structuredClone(options.body) } : {}) });
    return handler(path, options);
  } };
  const make = () => createWebApiState({ client, storage: session, onChange: state => changes.push(state), uuid: () => id });
  return { make, client, storage, session, calls, changes, handler: next => { handler = next; },
    switchAccount: () => { generation++; identity = { accountId: 'b' }; } };
}

test('status refresh preserves edits and selected paused servers; conflict blocks saving until deliberate discard', async () => {
  const f = setup(), model = f.make(); await model.refresh();
  model.change('chatEnabled', true);
  f.handler(async () => ({ data: config({ revision: 5, infoEnabled: false, status: { state: 'syncing' } }) }));
  await model.refresh();
  assert.equal(model.snapshot().draft.expectedRevision, 4);
  assert.equal(model.snapshot().draft.chatEnabled, true);
  assert.equal(model.snapshot().draft.infoEnabled, true);
  assert.deepEqual(model.snapshot().draft.serverIds, ['live', 'paused']);
  assert.equal(model.snapshot().config.status.state, 'syncing');
  await model.save();
  assert.equal(model.snapshot().error.errorCode, 'REVISION_CONFLICT');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
  model.discard(); assert.equal(model.snapshot().draft.expectedRevision, 5);
  assert.equal(model.snapshot().draft.chatEnabled, false); assert.equal(model.snapshot().dirty, false);
});

test('server discovery uses draft credentials, filters stopped servers and ignores responses from an older draft', async () => {
  const f = setup(), model = f.make(); await model.refresh();
  model.change('baseUrl', 'https://rust-go.example/');
  assert.equal(webApiHasCredentials(model.snapshot().draft, model.snapshot().config), true);
  model.change('baseUrl', 'https://next.example');
  assert.equal(webApiHasCredentials(model.snapshot().draft, model.snapshot().config), false);
  model.change('apiKey', secret);
  const older = deferred(); f.handler(() => older.promise);
  const read = model.readServers();
  assert.equal(f.calls.at(-1).body.input.apiKey, secret);
  model.change('baseUrl', 'https://newer.example');
  assert.equal(f.calls.at(-1).signal.aborted, true);
  older.resolve({ data: { items: [{ id: 'wrong', name: 'Wrong source', state: 'running' }] } }); await read;
  assert.equal(model.snapshot().servers, null);
  f.handler(async () => ({ data: { items: [{ id: 'live', name: 'Live', state: 'running' },
    { id: 'live', name: 'Duplicate', state: 'running' }, { id: 'paused', name: 'Paused', state: 'stopped' }] } }));
  await model.readServers();
  assert.deepEqual(model.snapshot().servers.map(server => server.id), ['live']);
  assert.deepEqual(model.snapshot().draft.serverIds, ['live', 'paused']);
  assert.equal(f.storage.size, 0);
});

test('save journals only safe metadata, preserves independent toggles, and never echoes the key', async () => {
  const f = setup(), model = f.make(); await model.refresh(); model.change('apiKey', secret); model.change('chatEnabled', true);
  const saving = deferred(); f.handler(() => saving.promise); const pending = model.save();
  assert.equal(model.snapshot().phase, 'saving'); assert.equal(model.snapshot().draft.apiKey, '');
  assert.equal(f.calls.at(-1).headers['Idempotency-Key'], id);
  assert.deepEqual(f.calls.at(-1).body.input, { expectedRevision: 4, baseUrl: config().baseUrl, tenantId: '',
    apiKey: secret, serverIds: ['live', 'paused'], infoEnabled: true, chatEnabled: true });
  assert.ok(!JSON.stringify([...f.storage]).includes(secret));
  saving.resolve({ data: config({ revision: 5, chatEnabled: true, lastOperationId: id }) }); await pending;
  assert.equal(model.snapshot().phase, 'saved'); assert.equal(model.snapshot().dirty, false);
  assert.equal(model.snapshot().draft.apiKey, ''); assert.equal(f.storage.size, 0);
});

test('unknown save is confirmed from a fresh revision and operation ID without sending the key again', async () => {
  const f = setup(), model = f.make(); await model.refresh(); model.change('chatEnabled', true); model.change('apiKey', secret);
  f.handler(async (path, options) => {
    if (options.method === 'POST') throw { errorCode: 'NETWORK_UNAVAILABLE', status: 0 };
    return { data: config({ revision: 5, lastOperationId: id, chatEnabled: true }) };
  });
  await model.save();
  assert.equal(model.snapshot().phase, 'saved');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(f.storage.size, 0);
});

test('unresolved operation blocks another save and survives reload with no secret in its journal', async () => {
  const f = setup(), model = f.make(); await model.refresh(); model.change('apiKey', secret);
  f.handler(async (path, options) => {
    if (options.method === 'POST' || path.includes('/operations/')) throw { errorCode: 'OPERATION_IN_PROGRESS', status: 503 };
    return { data: config() };
  });
  await model.save(); assert.equal(model.snapshot().phase, 'unknown');
  model.change('chatEnabled', true); await model.save();
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(model.snapshot().draft.chatEnabled, false);
  assert.ok(!JSON.stringify([...f.storage]).includes(secret));
  const reloaded = f.make(); assert.equal(reloaded.snapshot().phase, 'unknown');
  await reloaded.checkResult(); assert.equal(reloaded.snapshot().phase, 'unknown');
  assert.equal(reloaded.snapshot().draft.apiKey, '');
});

test('not-recorded receipt requires a replacement key to be re-entered and stale revisions remain protected', async () => {
  const f = setup(), model = f.make(); await model.refresh(); model.change('apiKey', secret);
  f.handler(async (path, options) => {
    if (options.method === 'POST') throw { errorCode: 'REQUEST_TIMEOUT', status: 0 };
    if (path.includes('/operations/')) throw { errorCode: 'RESOURCE_NOT_FOUND', status: 404 };
    return { data: config() };
  });
  await model.save(); assert.equal(model.snapshot().phase, 'not-recorded');
  assert.equal(model.snapshot().keyInputCleared, true); await model.save();
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  model.change('apiKey', secret); assert.equal(model.snapshot().keyInputCleared, false);
});

test('receipt discovered after an older config read refreshes the actual saved configuration', async () => {
  const f = setup(), model = f.make(); await model.refresh(); model.change('chatEnabled', true);
  let gets = 0;
  f.handler(async (path, options) => {
    if (options.method === 'POST') throw { errorCode: 'REQUEST_TIMEOUT', status: 0 };
    if (path.includes('/operations/')) return { data: { state: 'succeeded' } };
    gets++; return { data: config(gets === 1 ? {} : { revision: 5, lastOperationId: id, chatEnabled: true }) };
  });
  await model.save(); assert.equal(model.snapshot().phase, 'saved');
  assert.equal(model.snapshot().draft.expectedRevision, 5); assert.equal(model.snapshot().draft.chatEnabled, true);
});

test('permissions and account changes prevent mutation and late results from being applied', async () => {
  const denied = setup(config({ canWrite: false })), locked = denied.make(); await locked.refresh();
  locked.change('apiKey', secret); await locked.readServers(); await locked.save();
  assert.equal(locked.snapshot().draft.apiKey, ''); assert.equal(denied.calls.length, 1);
  const f = setup(), model = f.make(); await model.refresh(); model.change('chatEnabled', true);
  const wait = deferred(); f.handler(() => wait.promise); const pending = model.save();
  f.switchAccount(); wait.resolve({ data: config({ revision: 5, lastOperationId: id }) }); await pending;
  assert.ok(!f.changes.some(state => state.phase === 'saved'));
});

test('an earlier status request cannot overwrite a successfully saved revision; disposal aborts discovery', async () => {
  const f = setup(), model = f.make(); await model.refresh(); model.change('chatEnabled', true);
  const old = deferred(); f.handler(async (_path, options) => options.method === 'POST'
    ? { data: config({ revision: 5, lastOperationId: id, chatEnabled: true }) } : old.promise);
  const refresh = model.refresh(); await model.save(); old.resolve({ data: config() }); await refresh;
  assert.equal(model.snapshot().config.revision, 5); assert.equal(model.snapshot().draft.chatEnabled, true);
  const discovery = deferred(); f.handler(() => discovery.promise); const read = model.readServers(); model.dispose();
  assert.equal(f.calls.at(-1).signal.aborted, true); discovery.resolve({ data: { items: [] } }); await read;
  assert.equal(model.snapshot().draft, null);
});
