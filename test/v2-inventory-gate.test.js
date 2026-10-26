import test from 'node:test';
import assert from 'node:assert/strict';
import { createInventoryGate } from '../server/v2/management-adapters/source-host/inventory-gate.js';
import { createInventoryReader } from '../server/v2/management-adapters/source-host/inventory.js';

test('manual and risk inventory reads share cooldown and make only one upstream request', async () => {
  let requests = 0;
  const read = createInventoryReader({ allowed: () => true, network: {
    response: async () => { requests++; return new Response('', { status: 429, headers: { 'retry-after': '120' } }); }
  } });
  const results = await Promise.allSettled([
    read('76561198000000501', { inventoryOnly: true }),
    read('76561198000000502', { riskRead: true, inventoryOnly: true })
  ]);
  assert.equal(requests, 1);
  for (const r of results) {
    assert.equal(r.status, 'rejected');
    assert.equal(r.reason.errorCode, 'RATE_LIMITED');
    assert.equal(r.reason.sourceId, 'community');
    assert.equal(r.reason.retryAfterKnown, true);
    assert.ok(r.reason.retryAfterMs > 119000);
  }
});

test('unknown cooldown backs off without retries and a successful read resets it', async () => {
  let now = 100000, calls = 0;
  const run = createInventoryGate({ now: () => now });
  const limited = () => { calls++; return new Response('', { status: 429 }); };
  const check = ms => e => e.errorCode === 'RATE_LIMITED' && e.retryAfterMs === ms && !e.retryAfterKnown;
  await assert.rejects(run(limited), check(60000));
  now += 20000;
  await assert.rejects(run(limited), check(40000));
  assert.equal(calls, 1);
  now += 40000;
  await assert.rejects(run(limited), check(120000));
  now += 120000;
  assert.equal((await run(() => new Response('{}'))).status, 200);
  await assert.rejects(run(limited), check(60000));
  assert.equal(calls, 3);
});

test('honors Retry-After date, bounds cooldown, and rejects aborted queued reads', async () => {
  const now = Date.parse('2026-09-27T10:00:00Z');
  const run = createInventoryGate({ now: () => now });
  await assert.rejects(run(() => new Response('', { status: 429, headers: { 'retry-after': 'Sun, 27 Sep 2026 10:02:00 GMT' } })), e => e.retryAfterKnown && e.retryAfterMs === 120000);
  const aborted = AbortSignal.abort();
  await assert.rejects(run(() => assert.fail('must not send cancelled request'), aborted), e => e.errorCode === 'SOURCE_TIMEOUT');
  const bounded = createInventoryGate({ now: () => now });
  await assert.rejects(bounded(() => new Response('', { status: 429, headers: { 'retry-after': '999999999' } })), e => e.retryAfterMs === 3600000);
});

test('queued cancellation settles immediately without releasing the active serial slot', async () => {
  const run = createInventoryGate(), controller = new AbortController();
  let release, thirdStarted = false;
  const first = run(() => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const cancelled = run(() => assert.fail('cancelled queued work must not run'), controller.signal);
  let settled = false;
  const checked = assert.rejects(cancelled, { errorCode: 'SOURCE_TIMEOUT' }).then(() => { settled = true; });
  const third = run(() => { thirdStarted = true; return new Response('{}'); });
  controller.abort();
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.equal(settled, true, 'caller must not wait for an unrelated active request');
    assert.equal(thirdStarted, false, 'cancelled caller must not allow concurrent upstream work');
  } finally { release(new Response('{}')); await Promise.all([first, checked, third]); }
  assert.equal(thirdStarted, true);
});

test('active cancellation does not release the slot until owned I/O has drained', async () => {
  const run = createInventoryGate(), controller = new AbortController();
  let release, nextStarted = false;
  const active = run(() => new Promise(resolve => { release = resolve; }), controller.signal);
  const checked = assert.rejects(active, { errorCode: 'SOURCE_TIMEOUT' });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await checked;
  const next = run(() => { nextStarted = true; return new Response('{}'); });
  await new Promise(resolve => setImmediate(resolve));
  try { assert.equal(nextStarted, false); }
  finally { release(new Response('{}')); await next; }
});
