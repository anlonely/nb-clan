import test from 'node:test';
import assert from 'node:assert/strict';
import { createInventoryEnrichment } from '../server/v2/source-providers/inventory.js';
import { createProviderTransport } from '../server/v2/source-providers/transport.js';
import { createSourceNetwork } from '../server/v2/management-adapters/source-host/network.js';

const sid = '76561198000000501', instant = Date.parse('2026-09-27T12:00:00Z');
const inventory = () => ({ inventoryAvailable: true, skins: [{ id: '1', name: 'Observed Skin', quantity: 2 }], dlcs: [] });
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
function fixture(t, { rows, summary, value, page, config } = {}) {
  const calls = [], settings = { enabled: true, revision: 1, prices: true, rusthelp: false, ...config };
  rows ??= [{ name: 'Observed Skin', quantity: 2, marketPrice: 250, marketValue: 500, currency: 'USD' }];
  const fetchImpl = async (input, options) => {
    const url = new URL(input); calls.push({ url, options });
    assert.equal(url.origin, 'https://api.scmm.app');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.authorization, undefined);
    assert.equal(options.headers.cookie, undefined);
    if (url.pathname.endsWith('/summary')) return json(summary ?? { steamId: sid, lastUpdatedInventoryOn: new Date(instant - 1000).toISOString() });
    assert.equal(url.searchParams.get('currency'), 'USD');
    if (url.pathname.endsWith('/value')) return json(value ?? { totalValue: 500, itemCount: 2, currency: 'USD' });
    assert.equal(url.pathname, `/api/inventory/${sid}`);
    const currentPage = Number(url.searchParams.get('page') || 1), pageSize = Number(url.searchParams.get('pageSize') || 500);
    const result = { items: rows.slice((currentPage - 1) * pageSize, currentPage * pageSize), page: currentPage, pageSize, total: rows.length, hasMore: currentPage * pageSize < rows.length };
    return json(page ? page(result) : result);
  };
  const transport = createProviderTransport({ fetchImpl, readConfiguration: () => settings, now: () => instant });
  t.after(() => transport.stop());
  const read = createInventoryEnrichment({ transport, readConfiguration: () => settings, now: () => instant });
  return { read: (data = inventory()) => read({ steamId: sid, inventory: data }), calls, transport, fetchImpl };
}

test('new SCMM inventory routes preserve cents, per-unit prices and real snapshot evidence', async t => {
  const f = fixture(t), result = await f.read();
  assert.deepEqual(f.calls.map(call => call.url.pathname), [`/api/inventory/${sid}/summary`, `/api/inventory/${sid}`, `/api/inventory/${sid}/value`]);
  assert.deepEqual(result.prices.map(p => [p.id, p.price, p.currency]), [['1', 2.5, 'USD']]);
  assert.equal(result.summary.totalValue, 5);
  assert.equal(result.summary.sourceObservedAt, new Date(instant - 1000).toISOString());
  assert.equal(result.prices[0].evidence.sourceObservedAt, result.summary.sourceObservedAt);
  assert.equal(f.calls[1].url.searchParams.get('includeUnpriced'), 'true');
  assert.equal(f.calls[1].url.searchParams.get('market'), 'steam');
});

test('paginated rows use one-based page/pageSize and nameHash, combining exact quantities', async t => {
  const rows = Array.from({ length: 501 }, () => ({ nameHash: 'Observed Skin', name: 'Localized display', quantity: 1, marketPrice: 100, currency: 'USD' }));
  const f = fixture(t, { rows, value: { totalValue: 50100, itemCount: 501, currency: 'USD' } });
  const input = inventory(); input.skins[0].quantity = 501;
  const result = await f.read(input);
  assert.equal(result.prices[0].price, 1);
  assert.equal(result.summary.totalValue, 501);
  assert.deepEqual(f.calls.filter(c => c.url.pathname === `/api/inventory/${sid}`).map(c => c.url.searchParams.get('page')), ['1', '2']);
});

for (const [name, summary] of [
  ['missing owner', {}], ['wrong owner', { steamId: '76561198000000509', lastUpdatedInventoryOn: new Date(instant).toISOString() }],
  ['unimported', { steamId: sid, lastUpdatedInventoryOn: null }],
  ['stale', { steamId: sid, lastUpdatedInventoryOn: new Date(instant - 300001).toISOString() }],
  ['future', { steamId: sid, lastUpdatedInventoryOn: new Date(instant + 1).toISOString() }]
]) test(`SCMM ${name} summary leaves all values unknown without reading priced endpoints`, async t => {
  const f = fixture(t, { summary }), result = await f.read();
  assert.deepEqual(result.prices, []); assert.equal(result.summary, null); assert.equal(f.calls.length, 1);
  assert.equal(result.evidence.sources.scmmSummary.status, 'unavailable');
});

for (const [name, change] of [
  ['inconsistent page', page => ({ ...page, page: 2 })],
  ['inconsistent total', page => ({ ...page, total: 5 })],
  ['inconsistent hasMore', page => ({ ...page, hasMore: true })],
  ['future page evidence', page => ({ ...page, observedAt: new Date(instant + 1).toISOString() })],
  ['too many rows', page => ({ ...page, total: 2001, hasMore: true })]
]) test(`SCMM ${name} cannot publish partial page prices`, async t => {
  const f = fixture(t, { page: change, value: {} }), result = await f.read();
  assert.deepEqual(result.prices, []); assert.equal(result.summary, null); assert.equal(f.calls.length, 3);
});

test('missing, fractional, negative, foreign-currency and mismatched quantity prices remain unknown', async t => {
  for (const patch of [{ marketPrice: null }, { marketPrice: 0.5 }, { marketPrice: -1 }, { currency: 'EUR' }, { quantity: 1 }]) {
    const rows = [{ name: 'Observed Skin', quantity: 2, marketPrice: 250, currency: 'USD', ...patch }];
    const result = await fixture(t, { rows, value: { totalValue: 500, itemCount: 1, currency: 'USD' } }).read();
    assert.deepEqual(result.prices, []); assert.equal(result.summary, null);
  }
  const zero = await fixture(t, { rows: [{ name: 'Observed Skin', quantity: 2, marketPrice: 0, currency: 'USD' }], value: { totalValue: 0, itemCount: 2, currency: 'USD' } }).read();
  assert.equal(zero.prices[0].price, 0); assert.equal(zero.summary.totalValue, 0);
});

test('transport forces currency query and rejects legacy URLs and import writes', async t => {
  const f = fixture(t), session = f.transport.open('scmm'); t.after(() => session.close());
  await session.json(`/api/inventory/${sid}/value`, { query: { currency: 'EUR' }, headers: { authorization: 'untrusted', Currency: 'EUR' } });
  assert.equal(f.calls.at(-1).url.searchParams.get('currency'), 'USD');
  assert.equal(f.calls.at(-1).options.headers.Currency, undefined);
  await assert.rejects(session.json(`/api/profile/${sid}/inventory/value`), { errorCode: 'SOURCE_URL_REJECTED' });
  const next = f.transport.open('scmm'); t.after(() => next.close());
  await assert.rejects(next.json(`/api/inventory/${sid}/value`, { method: 'POST' }), { errorCode: 'SOURCE_METHOD_REJECTED' });
});

test('compatibility source network accepts only the new SCMM read origin and paths', async t => {
  const calls = [];
  const network = createSourceNetwork({ credentials: () => ({}), fetchImpl: async (url) => { calls.push(new URL(url)); return json({}); } });
  t.after(() => network.stop());
  await network.json('scmm', `/api/inventory/${sid}/summary`);
  await network.json('scmm', `/api/inventory/${sid}`, { query: { currency: 'USD' } });
  await network.json('scmm', `/api/inventory/${sid}/value`, { query: { currency: 'USD' } });
  assert.ok(calls.every(url => url.origin === 'https://api.scmm.app'));
  await assert.rejects(network.json('scmm', `/api/profile/${sid}/inventory/value`), { errorCode: 'SOURCE_URL_REJECTED' });
});
