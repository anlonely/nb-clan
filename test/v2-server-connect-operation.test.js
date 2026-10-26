import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerConnectOperation } from '../src/v2/server-connect-operation.js';

const input = () => ({ platform: 'discord', targetId: 'server_connect_target1', expectedRevision: 4,
  wipeId: 'wipe1', language: 'en', serverConnectOverride: { name: 'Atlas',
    serverScheduledWipeAt: '2026-09-27T12:00:00.000Z', command: 'connect example.com:28015' } });
const card = (id = 'preview1') => ({ id, contentHash: `hash-${id}`, title: 'Server Direct Connect', body: 'Server: Atlas' });
const previewResult = (preview = card()) => ({ data: { status: 'succeeded', result: { state: 'succeeded', preview } } });
const result = (state, extra = {}) => ({ data: { status: state === 'unknown' ? 'result_unknown' : state,
  result: { state, reference: 'delivery1', ...extra } } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture() {
  let generation = 1, nextId = 0, handler = async () => previewResult();
  const calls = [], changes = [];
  const client = { getGeneration: () => generation, request(path, options = {}) {
    calls.push({ path, ...options }); return handler(path, options);
  } };
  const operation = createServerConnectOperation({ client, onChange: state => changes.push(state), uuid: () => `op-${++nextId}` });
  return { operation, calls, changes, client, handler: fn => { handler = fn; }, changeGeneration: () => { generation++; } };
}

test('preview only renders the card; publish uses the immutable approved target, wipe and content binding', async () => {
  const f = fixture(), submitted = input(), remotePreview = card();
  f.handler(async () => previewResult(remotePreview));
  const preview = await f.operation.preview(submitted);
  assert.deepEqual(preview, card());
  assert.equal(f.calls.length, 1); assert.match(f.calls[0].path, /\/discord\/actions\/card_preview$/);
  assert.deepEqual(f.calls[0].body, {
    targetId: submitted.targetId, expectedRevision: 4, wipeId: 'wipe1', language: 'en',
    serverConnectOverride: submitted.serverConnectOverride, cardType: 'server_connect'
  });
  submitted.platform = 'kook'; submitted.targetId = 'wrong-target'; submitted.expectedRevision = 99;
  submitted.serverConnectOverride.command = 'connect wrong.example:28015'; remotePreview.id = 'wrong-preview';
  assert.equal(f.calls[0].body.serverConnectOverride.command, 'connect example.com:28015');
  f.handler(async () => result('queued'));
  const published = await f.operation.publish();
  assert.equal(published.status, 'queued'); assert.match(f.calls[1].path, /\/discord\/actions\/card_publish$/);
  assert.deepEqual(f.calls[1].body, { expectedRevision: 4, targetId: 'server_connect_target1', wipeId: 'wipe1',
    cardType: 'server_connect', previewId: 'preview1', contentHash: 'hash-preview1', mentionMode: 'none' });
  assert.equal(f.calls[1].headers['Idempotency-Key'], f.operation.getState().operationId);
  assert.notEqual(f.calls[0].headers['Idempotency-Key'], f.calls[1].headers['Idempotency-Key']);
  for (const state of f.changes) assert.deepEqual(Object.keys(state).sort(), ['error','operationId','preview','previewBusy','publishBusy','result']);
});

test('refresh updates the original card with the same approved preview', async () => {
  const f = fixture();
  await f.operation.preview(input());
  f.handler(async () => result('queued'));
  assert.equal((await f.operation.publish('refresh')).status, 'queued');
  assert.match(f.calls[1].path, /\/discord\/actions\/card_refresh$/);
  assert.deepEqual(f.calls[1].body, { expectedRevision: 4, targetId: 'server_connect_target1', wipeId: 'wipe1',
    cardType: 'server_connect', previewId: 'preview1', contentHash: 'hash-preview1', mentionMode: 'none' });
});

test('changed fields immediately invalidate the preview and late successful reads cannot restore it', async () => {
  const f = fixture(), read = deferred(); f.handler(() => read.promise);
  const pending = f.operation.preview(input());
  assert.equal(f.operation.getState().previewBusy, true);
  f.operation.invalidatePreview(); assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(f.operation.getState().previewBusy, false);
  read.resolve(previewResult()); assert.equal(await pending, null);
  assert.equal(f.operation.getState().preview, null);
  await f.operation.publish(); assert.equal(f.calls.length, 1);
  assert.equal(f.operation.getState().error.errorCode, 'CARD_PREVIEW_REQUIRED');
});

test('a later preview wins even when an older aborted request succeeds afterward', async () => {
  const f = fixture(), old = deferred(); f.handler(() => old.promise);
  const pending = f.operation.preview(input());
  f.handler(async () => previewResult(card('preview2')));
  await f.operation.preview({ ...input(), targetId: 'target2' });
  old.resolve(previewResult(card('preview1'))); await pending;
  assert.equal(f.operation.getState().preview.id, 'preview2'); assert.equal(f.calls[0].signal.aborted, true);
  f.handler(async () => result('succeeded')); await f.operation.publish();
  assert.equal(f.calls[2].body.targetId, 'target2'); assert.equal(f.calls[2].body.previewId, 'preview2');
});

test('publish locks synchronously, ignores preview edits while pending, and never auto-resends', async () => {
  const f = fixture(); await f.operation.preview(input());
  const send = deferred(); f.handler(() => send.promise);
  const pending = f.operation.publish(), operationId = f.operation.getState().operationId;
  await f.operation.publish(); await f.operation.checkReceipt();
  f.operation.invalidatePreview(); await f.operation.preview({ ...input(), targetId: 'other' });
  assert.equal(f.calls.length, 2); assert.equal(f.operation.getState().operationId, operationId);
  send.resolve(result('running')); await pending;
  assert.equal(f.operation.getState().operationId, operationId); assert.equal(f.operation.getState().publishBusy, false);
  await f.operation.publish(); assert.equal(f.calls.length, 2);
});

test('receipt has a synchronous lock, uses only the pending ID, and successful delivery consumes the preview', async () => {
  const f = fixture(); await f.operation.preview(input()); f.handler(async () => result('queued')); await f.operation.publish();
  const operationId = f.operation.getState().operationId, read = deferred(); f.handler(() => read.promise);
  const pending = f.operation.checkReceipt(); await f.operation.checkReceipt(); await f.operation.publish();
  assert.equal(f.calls.length, 3); assert.equal(f.calls[2].path, `/api/v2/platform-admin/operations/${operationId}`);
  assert.equal(f.calls[2].method, undefined); assert.equal(f.calls[2].body, undefined);
  read.resolve(result('succeeded')); await pending;
  assert.equal(f.operation.getState().operationId, null); assert.equal(f.operation.getState().preview, null);
  assert.equal(f.operation.getState().result.status, 'succeeded');
  await f.operation.publish(); assert.equal(f.calls.length, 3);
});

test('transport errors and absent receipts retain the operation ID and require manual receipt checks', async () => {
  const f = fixture(); await f.operation.preview(input());
  f.handler(async () => { throw { errorCode: 'REQUEST_TIMEOUT' }; }); await f.operation.publish();
  const operationId = f.operation.getState().operationId;
  assert.ok(operationId); assert.equal(f.operation.getState().result.status, 'unknown');
  f.handler(async () => { throw { status: 404, errorCode: 'RESOURCE_NOT_FOUND' }; }); await f.operation.checkReceipt();
  assert.equal(f.operation.getState().operationId, operationId);
  await f.operation.publish(); assert.equal(f.calls.filter(call => call.path.endsWith('/card_publish')).length, 1);
  f.handler(async () => result('unknown')); await f.operation.checkReceipt();
  assert.equal(f.operation.getState().operationId, operationId);
  f.handler(async () => result('failed', { errorCode: 'CHANNEL_UNAVAILABLE' })); await f.operation.checkReceipt();
  assert.equal(f.operation.getState().operationId, null); assert.equal(f.operation.getState().error.errorCode, 'CHANNEL_UNAVAILABLE');
});

test('server preflight rejection clears the lock and requires a fresh preview', async () => {
  const f = fixture(); await f.operation.preview(input());
  f.handler(async () => { throw { status: 409, errorCode: 'REVISION_CONFLICT' }; }); await f.operation.publish();
  assert.equal(f.operation.getState().result.status, 'failed'); assert.equal(f.operation.getState().operationId, null);
  assert.equal(f.operation.getState().preview, null);
  await f.operation.publish(); assert.equal(f.calls.length, 2);
});

test('server in-progress conflict and unexpected delivery state remain unresolved', async () => {
  const f = fixture(); await f.operation.preview(input());
  f.handler(async () => { throw { status: 409, errorCode: 'OPERATION_IN_PROGRESS' }; }); await f.operation.publish();
  const operationId = f.operation.getState().operationId; assert.ok(operationId);
  f.handler(async () => result('unexpected')); await f.operation.checkReceipt();
  assert.equal(f.operation.getState().result.status, 'unknown'); assert.equal(f.operation.getState().operationId, operationId);
});

test('malformed preview and invalid platform do not unlock publish', async () => {
  const f = fixture(); await f.operation.preview({ ...input(), platform: '../other' }); assert.equal(f.calls.length, 0);
  f.handler(async () => previewResult({ title: 'Missing content binding' })); await f.operation.preview(input());
  assert.equal(f.operation.getState().error.errorCode, 'CARD_PREVIEW_FAILED'); assert.equal(f.operation.getState().preview, null);
  await f.operation.publish(); assert.equal(f.calls.length, 1);
});

test('domain error details take precedence over a generic outer operation error', async () => {
  const f = fixture();
  f.handler(async () => ({ data: { status: 'failed', errorCode: 'PLATFORM_EXECUTION_UNAVAILABLE',
    result: { state: 'failed', errorCode: 'SERVER_CONNECT_INPUT_INVALID' } } }));
  await f.operation.preview(input());
  assert.equal(f.operation.getState().error.errorCode, 'SERVER_CONNECT_INPUT_INVALID');
  f.handler(async () => previewResult()); await f.operation.preview(input());
  f.handler(async () => ({ data: { status: 'failed', errorCode: 'PLATFORM_EXECUTION_UNAVAILABLE',
    result: { state: 'failed', errorCode: 'CHANNEL_UNAVAILABLE' } } }));
  await f.operation.publish();
  assert.equal(f.operation.getState().result.errorCode, 'CHANNEL_UNAVAILABLE');
  assert.equal(f.operation.getState().error.errorCode, 'CHANNEL_UNAVAILABLE');
});

test('generation change rejects late preview and publish results without UI updates', async () => {
  const f = fixture(), read = deferred(); f.handler(() => read.promise);
  const pending = f.operation.preview(input()), before = f.changes.length; f.changeGeneration();
  read.resolve(previewResult()); await pending; await f.operation.publish();
  assert.equal(f.changes.length, before); assert.equal(f.calls.length, 1);
  const g = fixture(); await g.operation.preview(input()); const send = deferred(); g.handler(() => send.promise);
  const publishing = g.operation.publish(), changes = g.changes.length; g.changeGeneration();
  send.resolve(result('succeeded')); await publishing;
  assert.equal(g.changes.length, changes); assert.equal(g.operation.getState().result, null);
});

test('dispose aborts preview and receipt reads, fences late UI, and supports a newly mounted controller', async () => {
  const f = fixture(), read = deferred(); f.handler(() => read.promise);
  const pending = f.operation.preview(input()), before = f.changes.length; f.operation.dispose();
  assert.equal(f.calls[0].signal.aborted, true); read.resolve(previewResult()); await pending;
  assert.equal(f.changes.length, before); await f.operation.preview(input()); assert.equal(f.calls.length, 1);
  f.handler(async () => previewResult());
  const replacement = createServerConnectOperation({ client: f.client });
  assert.equal((await replacement.preview(input())).id, 'preview1'); replacement.dispose();
  const g = fixture(); await g.operation.preview(input()); g.handler(async () => result('queued')); await g.operation.publish();
  const receipt = deferred(); g.handler(() => receipt.promise);
  const checking = g.operation.checkReceipt(), changes = g.changes.length; g.operation.dispose();
  assert.equal(g.calls[2].signal.aborted, true); receipt.resolve(result('succeeded')); await checking;
  assert.equal(g.changes.length, changes);
});
