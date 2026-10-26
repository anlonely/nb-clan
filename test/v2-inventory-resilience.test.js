import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceHost } from '../server/v2/management-adapters/source-host/index.js';
import { createStatsProviders } from '../server/v2/stats/providers.js';
import { createProviderTransport, safeError } from '../server/v2/source-providers/transport.js';
import { createInventoryEnrichment } from '../server/v2/source-providers/inventory.js';
import { createInventoryReader } from '../server/v2/management-adapters/source-host/inventory.js';

const sid = '76561198000000501';
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...headers }
});
const fault = errorCode => Object.assign(new Error(errorCode), { errorCode });

function fixture(t, { catalog, enrichmentFetch, now = Date.now } = {}) {
  const calls = [];
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    calls.push({ host: url.hostname, path: url.pathname, appid: url.searchParams.get('appids') });
    if (url.hostname === 'api.scmm.app' || url.hostname === 'api.rusthelp.com') {
      assert.ok(enrichmentFetch, 'unexpected enrichment request');
      return enrichmentFetch(url, options);
    }
    if (url.pathname.includes('GetPlayerSummaries')) return json({ response: { players: [{
      steamid: sid, personaname: 'Observed profile', communityvisibilitystate: 3, timecreated: 1577836800
    }] } });
    if (url.pathname.includes('GetOwnedGames')) return json({ response: { games: [{ appid: 252490, playtime_forever: 120 }] } });
    if (url.pathname === `/inventory/${sid}/252490/2`) return json({
      success: 1, assets: [{ assetid: '1', classid: '2', instanceid: '0', amount: '2' }],
      descriptions: [{ classid: '2', instanceid: '0', market_hash_name: 'Observed skin', tradable: 1 }], more_items: 0
    });
    if (url.pathname === '/api/appdetails') {
      if (catalog) return catalog(url, options);
      return json({ 252490: { success: true, data: { dlc: [] } } });
    }
    assert.fail(`Unexpected local fixture request: ${url.hostname}${url.pathname}`);
  };
  const transport = enrichmentFetch ? createProviderTransport({ fetchImpl, now,
    readConfiguration: () => ({ enabled: true, revision: 1 }) }) : null;
  const enrichment = transport ? createInventoryEnrichment({ transport, now,
    readConfiguration: () => ({ enabled: true, revision: 1, prices: true, rusthelp: true }) }) : undefined;
  const host = createSourceHost({ fetchImpl, readSettings: () => ({ steamWebApi: { apiKey: 'test-only-key' } }),
    readWipe: () => null, capabilities: { steam: true, inventory: true, dlcCatalog: true, inventoryEnrichment: Boolean(enrichment) },
    inventoryEnrichment: enrichment });
  t.after(async () => { await host.stop(); await transport?.stop(); assert.equal(host.activeIO, 0); });
  const providers = createStatsProviders(host.readers.stats);
  return { host, calls, query: options => providers.inventory({ steamInput: sid }, options) };
}

test('optional DLC failure preserves observed inventory and earlier DLC rows without a retry', async t => {
  const f = fixture(t, { catalog: url => {
    const appid = url.searchParams.get('appids');
    if (appid === '252490') return json({ 252490: { success: true, data: { dlc: [1409640, 1670430] } } });
    if (appid === '1409640') return json({ 1409640: { success: true, data: { name: 'Observed DLC' } } });
    return json({}, 503);
  } });
  const result = await f.query();
  assert.equal(result.status, 'partial');
  assert.equal(result.inventory.status, 'partial');
  assert.deepEqual(result.inventory.items.map(item => item.name), ['Observed skin', 'Observed DLC']);
  assert.equal(result.inventory.items[0].quantity, 2);
  assert.equal(result.inventory.items[1].quantity, null, 'catalog presence does not prove DLC ownership');
  assert.equal(result.inventory.total, null);
  assert.equal(result.steamProfile.playtimeMinutes, 120);
  assert.deepEqual(result.errors, [{ sourceId: 'store', errorCode: 'SOURCE_UNAVAILABLE' }]);
  assert.equal(f.calls.filter(call => call.appid === '1670430').length, 1);
});

test('an optional DLC request timeout preserves already observed inventory', async t => {
  const f = fixture(t, { catalog: () => { throw fault('SOURCE_TIMEOUT'); } });
  const result = await f.query();
  assert.equal(result.inventory.items[0].name, 'Observed skin');
  assert.deepEqual(result.errors, [{ sourceId: 'store', errorCode: 'SOURCE_TIMEOUT' }]);
});

test('DLC cancellation, owner stop and credential drift still reject', async t => {
  for (const scenario of ['cancel', 'stop', 'credentials']) {
    await t.test(scenario, async t => {
      const controller = new AbortController();
      let stopping;
      const f = fixture(t, { catalog: () => {
        if (scenario === 'cancel') { controller.abort(); throw fault('SOURCE_TIMEOUT'); }
        if (scenario === 'stop') { stopping = f.host.stop(); throw fault('SOURCE_TIMEOUT'); }
        if (scenario === 'credentials') throw fault('CREDENTIALS_CHANGED');
      } });
      const errorCode = scenario === 'credentials' ? 'CREDENTIALS_CHANGED' : 'SOURCE_TIMEOUT';
      await assert.rejects(f.host.readers.stats.inventory(sid, { signal: controller.signal }), { errorCode });
      await stopping;
    });
  }
});

test('wrong AppID, malformed and oversized optional DLC catalogs cannot erase verified skins', async t => {
  for (const [name, payload, errorCode] of [
    ['wrong AppID', { 2511860: { success: true, data: { dlc: [999], name: 'Wrong game' } } }, 'SOURCE_INVALID_DATA'],
    ['malformed DLC list', { 252490: { success: true, data: { dlc: 'invalid' } } }, 'SOURCE_INVALID_DATA'],
    ['oversized DLC list', { 252490: { success: true, data: { dlc: Array.from({ length: 41 }, (_, i) => i + 1) } } }, 'SOURCE_PAGE_LIMIT']
  ]) {
    await t.test(name, async t => {
      const f = fixture(t, { catalog: () => json(payload) });
      const result = await f.query();
      assert.equal(result.status, 'partial');
      assert.deepEqual(result.inventory.items.map(item => [item.name, item.category, item.quantity]), [['Observed skin', 'skins', 2]]);
      assert.equal(result.inventory.total, null);
      assert.equal(result.steamProfile.playtimeMinutes, 120);
      assert.deepEqual(result.errors, [{ sourceId: 'store', errorCode }]);
      assert.deepEqual(f.calls.filter(call => call.appid).map(call => call.appid), ['252490'], 'invalid catalog must not trigger any DLC lookups');
    });
  }
});

test('invalid core inventory and pricing evidence still fail outside the optional store boundary', async t => {
  for (const [source, errorCode] of [
    ['inventory', 'SOURCE_INVALID_DATA'], ['inventory', 'SOURCE_PAGE_LIMIT'],
    ['pricing', 'SOURCE_INVALID_DATA'], ['pricing', 'SOURCE_PAGE_LIMIT'], ['pricing', 'SOURCE_EVIDENCE_UNVERIFIED']
  ]) {
    await t.test(`${source} ${errorCode}`, async () => {
      const read = createInventoryReader({ allowed: () => true,
        network: {
          response: async () => {
            if (source === 'inventory') throw fault(errorCode);
            return json({ success: 1, assets: [], descriptions: [], more_items: 0 });
          },
          tracked: (fn, signal) => fn(signal)
        },
        enrichment: async () => { throw fault(errorCode); }
      });
      await assert.rejects(read(sid, { inventoryOnly: true }), { errorCode });
    });
  }
});

test('native enrichment retains 429 origin and Retry-After evidence through every error boundary', async t => {
  const instant = Date.UTC(2026, 8, 27, 12);
  for (const source of ['scmm', 'rusthelp']) {
    for (const [retry, delay, known] of [['7', 7000, true], [new Date(instant + 9000).toUTCString(), 9000, true], [null, 60000, false], ['invalid', 60000, false]]) {
      await t.test(`${source} / ${retry ?? 'missing Retry-After'}`, async t => {
        const f = fixture(t, { now: () => instant, enrichmentFetch: url => {
          if (source === 'rusthelp' && url.hostname === 'api.scmm.app') {
            if (url.pathname.endsWith('/summary')) return json({ steamId: sid, lastUpdatedInventoryOn: new Date(instant).toISOString() });
            return json(url.pathname.endsWith('/value') ? {} : { items: [], page: 1, pageSize: 500, total: 0, hasMore: false });
          }
          return json({}, 429, retry === null ? {} : { 'retry-after': retry });
        } });
        const result = await f.query();
        assert.equal(result.inventory.items[0].name, 'Observed skin');
        assert.deepEqual(result.errors, [{ sourceId: source, errorCode: 'RATE_LIMITED', retryAfterMs: delay, retryAfterKnown: known }]);
        const host = source === 'scmm' ? 'api.scmm.app' : 'api.rusthelp.com';
        assert.equal(f.calls.filter(call => call.host === host).length, 1, 'no retry or further request to a rate-limited source');
      });
    }
  }
});

test('rate-limit error sanitization preserves only approved metadata', () => {
  const error = safeError({ errorCode: 'RATE_LIMITED', sourceId: 'https://secret.example/token', retryAfterMs: 9999999,
    retryAfterKnown: true, message: 'private credential', token: 'secret' });
  assert.equal(error.message, 'RATE_LIMITED');
  assert.equal(error.retryAfterMs, 3600000);
  assert.equal(error.retryAfterKnown, true);
  assert.equal(error.sourceId, undefined);
  assert.equal(JSON.stringify(error).includes('secret'), false);
});
