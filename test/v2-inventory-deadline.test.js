import test from 'node:test';
import assert from 'node:assert/strict';
import { createInventoryReader } from '../server/v2/management-adapters/source-host/inventory.js';
import { createSourceNetwork } from '../server/v2/management-adapters/source-host/network.js';
import { createStatsProviders } from '../server/v2/stats/providers.js';

const sid = '76561198000000501';
const json = body => new Response(JSON.stringify(body));
const assets = { success: 1, assets: [{ assetid: '1', classid: '2', instanceid: '0', amount: '2' }],
  descriptions: [{ classid: '2', instanceid: '0', market_hash_name: 'Observed skin' }], more_items: 0 };
function fixture(t, { kind, now = Date.now, afterCore = () => {} }) {
  const calls = [], entered = Promise.withResolvers();
  let optionalSignal;
  const waitUntilAborted = signal => {
    optionalSignal = signal;
    entered.resolve();
    return new Promise((_resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('SOURCE_TIMEOUT'), { errorCode: 'SOURCE_TIMEOUT' }));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  };
  const network = createSourceNetwork({ credentials: () => ({}), timeoutMs: 1000,
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path.startsWith('/inventory/')) { afterCore(); return json(assets); }
      assert.equal(path, '/api/appdetails');
      if (new URL(url).searchParams.get('appids') === '252490') return json({ 252490: { success: true, data: { dlc: [1409640] } } });
      return waitUntilAborted(options.signal);
    } });
  const read = createInventoryReader({ network, now, optionalTimeoutMs: 25,
    allowed: name => name === 'inventory' || name === (kind === 'dlc' ? 'dlcCatalog' : 'inventoryEnrichment'),
    enrichment: (_input, { signal }) => waitUntilAborted(signal) });
  t.after(async () => { await network.stop(); assert.equal(network.active, 0); });
  const providers = createStatsProviders({ inventory: read, summary: async () => ({ steamId: sid, name: 'Observed profile', playtimeMinutes: 120 }) });
  return { calls, entered: entered.promise, signal: () => optionalSignal,
    query: signal => providers.inventory({ steamInput: sid }, { signal }) };
}

for (const kind of ['dlc', 'enrichment']) {
  test(`slow optional ${kind} is cancelled while completed assets and profile survive`, async t => {
    // Core parsing and optional setup must not compete with the runner's wall
    // clock. Advance only the owned optional timer after the slow work starts.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t, { kind, now: () => 1000 }), caller = new AbortController();
    const pending = f.query(caller.signal);
    await f.entered;
    assert.equal(f.signal().aborted, false);
    t.mock.timers.tick(24);
    assert.equal(f.signal().aborted, false);
    t.mock.timers.tick(1);
    assert.equal(f.signal().aborted, true);
    const result = await pending;
    assert.equal(caller.signal.aborted, false);
    assert.equal(f.signal().aborted, true);
    assert.equal(result.inventory.items[0].name, 'Observed skin');
    assert.equal(result.inventory.items[0].quantity, 2);
    assert.equal(result.inventory.total, null);
    assert.equal(result.status, 'partial');
    assert.equal(result.steamProfile.playtimeMinutes, 120);
    assert.deepEqual(result.errors, [{ sourceId: kind === 'dlc' ? 'store' : 'inventoryEnrichment', errorCode: 'SOURCE_TIMEOUT' }]);
    assert.equal(f.calls.filter(path => path.startsWith('/inventory/')).length, 1);
  });

  test(`caller cancellation during optional ${kind} still terminates the query`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t, { kind, now: () => 1000 }), caller = new AbortController();
    const rejected = assert.rejects(f.query(caller.signal), { errorCode: 'SOURCE_TIMEOUT' });
    await f.entered;
    assert.equal(f.signal().aborted, false);
    caller.abort();
    await rejected;
    assert.equal(f.signal().aborted, true);
  });
}

test('optional budget counts core inventory time and skips optional network after it expires', async t => {
  let now = 1000;
  const f = fixture(t, { kind: 'dlc', now: () => now, afterCore: () => { now += 25; } });
  const result = await f.query();
  assert.equal(result.inventory.items[0].name, 'Observed skin');
  assert.deepEqual(result.errors, [{ sourceId: 'store', errorCode: 'SOURCE_TIMEOUT' }]);
  assert.deepEqual(f.calls, [`/inventory/${sid}/252490/2`]);
  assert.equal(f.signal(), undefined, 'An expired budget must skip optional work entirely');
});
