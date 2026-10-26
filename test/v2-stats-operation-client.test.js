import test from 'node:test';
import assert from 'node:assert/strict';
import { createStatsOperation } from '../src/v2/stats/operation.js';

function fixture() {
  const calls = [], changes = [], saved = [], invalidations = [];
  let generation = 1, sequence = 0;
  let handler = async () => ({ data: { jobId: 'job1' } });
  const client = {
    getGeneration: () => generation,
    request(path, options) { calls.push({ path, options }); return handler(); },
    invalidateQueries: key => invalidations.push(key)
  };
  const operation = createStatsOperation({ client, onChange: state => changes.push(state),
    onSaved: (...args) => saved.push(args), uuid: () => `operation-${++sequence}` });
  return { operation, calls, changes, saved, invalidations, handler: next => { handler = next; },
    changeIdentity: () => { generation++; } };
}

test('rapid submissions share a synchronous lock even with changed input before React renders', async () => {
  const f = fixture(); let release;
  f.handler(() => new Promise(resolve => { release = resolve; }));
  const pending = f.operation.run('/api/v2/stats/queries', { steamInput: 'first' });
  await assert.rejects(f.operation.run('/api/v2/stats/queries', { steamInput: 'second' }), { errorCode: 'OPERATION_IN_PROGRESS' });
  assert.equal(f.calls.length, 1);
  release({ data: { jobId: 'first-job' } });
  assert.deepEqual(await pending, { jobId: 'first-job' });
  assert.deepEqual(f.changes, [{ busy: true }, { result: { jobId: 'first-job' } }]);
});

test('ambiguous and in-progress retries retain the operation ID until success', async () => {
  const f = fixture(), body = { wipeId: 'w1' };
  f.handler(async () => { throw { errorCode: 'REQUEST_TIMEOUT' }; });
  await assert.rejects(f.operation.run('/api/v2/stats/import', body));
  f.handler(async () => ({ data: { saved: true } }));
  await f.operation.run('/api/v2/stats/import', body, 'saved');
  assert.equal(f.calls[0].options.headers['Idempotency-Key'], f.calls[1].options.headers['Idempotency-Key']);
  assert.equal(f.saved.length, 1);
  f.handler(async () => { throw { status: 409, errorCode: 'OPERATION_IN_PROGRESS' }; });
  await assert.rejects(f.operation.run('/api/v2/stats/import', body));
  f.handler(async () => ({ data: { saved: true } }));
  await f.operation.run('/api/v2/stats/import', body);
  assert.equal(f.calls[2].options.headers['Idempotency-Key'], f.calls[3].options.headers['Idempotency-Key']);
  assert.notEqual(f.calls[1].options.headers['Idempotency-Key'], f.calls[2].options.headers['Idempotency-Key']);
});

test('unmount aborts transport and rejects late results without success UI or cache writes', async () => {
  const f = fixture(); let release;
  f.handler(() => new Promise(resolve => { release = resolve; }));
  const pending = f.operation.run('/api/v2/stats/exports', {}, 'saved');
  const rejected = assert.rejects(pending, { errorCode: 'REQUEST_SUPERSEDED' });
  f.operation.dispose(); assert.equal(f.calls[0].options.signal.aborted, true);
  release({ data: { jobId: 'old-job' } }); await rejected;
  assert.deepEqual(f.changes, [{ busy: true }]);
  assert.equal(f.saved.length, 0); assert.equal(f.invalidations.length, 0);
  await assert.rejects(f.operation.run('/api/v2/stats/exports', {}), { errorCode: 'REQUEST_SUPERSEDED' });
  assert.equal(f.calls.length, 1);
});

test('a changed authorization generation rejects a late result before a caller can navigate', async () => {
  const f = fixture(); let release;
  f.handler(() => new Promise(resolve => { release = resolve; }));
  const pending = f.operation.run('/api/v2/stats/queries', {});
  const rejected = assert.rejects(pending, { errorCode: 'REQUEST_SUPERSEDED' });
  f.changeIdentity(); release({ data: { jobId: 'old-job' } }); await rejected;
  assert.deepEqual(f.changes, [{ busy: true }]); assert.equal(f.invalidations.length, 0);
});
