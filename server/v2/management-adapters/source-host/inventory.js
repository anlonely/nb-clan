import { projectInventoryEnrichment, requiresProjection, sealInventoryHost } from '../../source-providers/projection.js';
import { need, text } from '../../stats/model.js';
import { steamId } from './steam.js';
import { createInventoryGate } from './inventory-gate.js';
const number = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const decode = s => String(s).replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
const optionalCatalogErrors = new Set(['RATE_LIMITED', 'SOURCE_UNAVAILABLE', 'PROXY_UNAVAILABLE', 'SOURCE_NO_MATCH', 'SOURCE_TIMEOUT', 'SOURCE_BUSY']);
export function createInventoryReader({ network, allowed, enrichment, optionalTimeoutMs = 10000, now = Date.now }) {
  need(Number.isInteger(optionalTimeoutMs) && optionalTimeoutMs >= 10 && optionalTimeoutMs <= 10000, 'INVALID_DATA');
  const inventoryRequest = createInventoryGate();
  return async (id, options = {}) => {
    const optionalDeadline = now() + optionalTimeoutMs;
    steamId(id); need(allowed('inventory'), 'SOURCE_NOT_CONFIGURED', 503);
    const assets = new Map(), descriptions = new Map(), cursors = new Set();
    let cursor = '', available = true, complete = false, explicitPrivate = false;
    for (let page = 0; page < 40; page++) {
      const response = await inventoryRequest(() => network.response('community', `/inventory/${id}/252490/2`, { signal: options.signal, expectedCredentialsHash: options.expectedCredentialsHash, query: { l: 'english', count: 100, ...(cursor ? { start_assetid: cursor } : {}) } }), options.signal);
      if ([401, 403].includes(response.status)) { need(!options.riskRead, 'SOURCE_UNAVAILABLE', 503); available = false; break; }
      need(response.ok, 'SOURCE_UNAVAILABLE', 503);
      const raw = await response.json();
      if (raw.success !== 1 && raw.error === 'This profile is private.') { explicitPrivate = true; available = false; break; }
      need(raw.success === 1 && Array.isArray(raw.assets || []) && Array.isArray(raw.descriptions || []), 'SOURCE_INVALID_DATA', 503);
      need((raw.assets || []).length <= 100, 'SOURCE_PAGE_LIMIT', 503);
      for (const a of raw.assets || []) {
        need(/^\d+$/.test(String(a.assetid)) && /^\d+$/.test(String(a.classid)) && /^\d+$/.test(String(a.instanceid)), 'SOURCE_INVALID_DATA', 503);
        need(!assets.has(a.assetid), 'SOURCE_PAGINATION_INVALID', 503); assets.set(a.assetid, a);
      }
      for (const d of raw.descriptions || []) descriptions.set(`${d.classid}:${d.instanceid}`, d);
      need(assets.size <= 2000 && descriptions.size <= 2000, 'SOURCE_PAGE_LIMIT', 503);
      if (!raw.more_items) { complete = true; break; }
      need(/^\d+$/.test(String(raw.last_assetid)) && !cursors.has(String(raw.last_assetid)), 'SOURCE_PAGINATION_INVALID', 503);
      cursor = String(raw.last_assetid); cursors.add(cursor);
    }
    need(!available || complete, 'SOURCE_PAGE_LIMIT', 503);
    const skins = available ? [...assets.values()].map(a => {
      const d = descriptions.get(`${a.classid}:${a.instanceid}`); need(d, 'SOURCE_INVALID_DATA', 503);
      const quantity = Number(a.amount); need(Number.isSafeInteger(quantity) && quantity > 0, 'SOURCE_INVALID_DATA', 503);
      return { id: String(a.assetid), name: text(d.market_hash_name || d.name, 240), quantity, tradable: d.tradable === 1, marketable: d.marketable === 1, price: null, currency: null };
    }) : [];
    const result = { steamId:id, appId:252490, contextId:2, inventoryComplete:available&&complete, inventoryObservedAt:new Date().toISOString(), ...(options.riskRead ? { explicitPrivate } : {}), skins, dlcs: [], storeCatalog: [], errors: [], inventoryAvailable: available, dlcOwnershipAvailable: false, totalSummary: { currency: null, totalValue: null }, coverage: available ? 'inventory_observed_prices_unknown' : 'private' };
    need(!options.signal?.aborted && !network.stopped, 'SOURCE_TIMEOUT', 503);
    // Optional catalog/pricing work must finish before the query's inventory
    // deadline. Its timeout does not cancel the caller or discard observed assets.
    const optional = new AbortController(), remaining = optionalDeadline - now();
    const abortOptional = () => optional.abort();
    const timer = remaining > 0 ? setTimeout(abortOptional, remaining) : null;
    if (remaining <= 0) abortOptional();
    options.signal?.addEventListener('abort', abortOptional, { once: true });
    const optionalJson = (source, path, input) => {
      need(!optional.signal.aborted, 'SOURCE_TIMEOUT', 503);
      return network.json(source, path, { ...input, signal: optional.signal });
    };
    const recordOptionalError = (sourceId, error) => {
      const invalidCatalog = sourceId === 'store' && ['SOURCE_INVALID_DATA', 'SOURCE_PAGE_LIMIT'].includes(error?.errorCode);
      if ((!optionalCatalogErrors.has(error?.errorCode) && !invalidCatalog) || options.signal?.aborted || network.stopped) throw error;
      result.errors.push({ sourceId, errorCode: error.errorCode,
        ...(error.errorCode === 'RATE_LIMITED' ? { retryAfterMs: Math.min(3600000, Math.max(1000, Number(error.retryAfterMs) || 60000)), retryAfterKnown: error.retryAfterKnown === true } : {}) });
    };
    try {
    if (!options.inventoryOnly && options.includeStoreCatalog !== false && allowed('storeCatalog')) {
      try {
      // Reuse the legacy itemstore endpoint/HTML pattern, with a hard page/size bound.
      let ended = false;
      for (let start = 0; start < 240; start += 12) {
        const raw = await optionalJson('store', '/itemstore/252490/ajaxgetitemdefs/', { query: { start, count: 12, filter: 'All', l: 'english', cc: 'us' } });
        need(Number.isSafeInteger(raw.total_count) && raw.total_count >= 0 && raw.total_count <= 240, 'SOURCE_PAGE_LIMIT', 503);
        const pattern = /<div class="item_def_name ellipsis"><a href="(?<url>[^"]+)"[^>]*>(?<name>.*?)<\/a><\/div>\s*<div class="item_def_price">\s*(?<price>.*?)\s*<\/div>/gis;
        let count = 0;
        for (const m of String(raw.results_html || '').matchAll(pattern)) {
          count++; const name = text(decode(m.groups.name), 240), priceText = decode(m.groups.price).trim();
          result.storeCatalog.push({ name, price: /^\$[\d,]+(?:\.\d{2})?$/.test(priceText) ? Number(priceText.slice(1).replaceAll(',', '')) : null, currency: 'USD', quantity: null, tradable: false });
        }
        need(count <= 12 && (raw.total_count === 0 || count > 0), 'SOURCE_INVALID_DATA', 503);
        if (start + 12 >= raw.total_count) { ended = true; break; }
      }
      need(ended, 'SOURCE_PAGE_LIMIT', 503);
      } catch (error) { recordOptionalError('store', error); }
    }
    if (!options.inventoryOnly && allowed('dlcCatalog')) {
      try {
      const root = await optionalJson('store', '/api/appdetails', { query: { appids: 252490, l: 'english' } });
      need(root['252490']?.success === true && Array.isArray(root['252490'].data?.dlc), 'SOURCE_INVALID_DATA', 503);
      const ids = root['252490'].data.dlc;
      need(ids.length <= 40 && new Set(ids).size === ids.length && ids.every(x => Number.isSafeInteger(x) && x > 0), 'SOURCE_PAGE_LIMIT', 503);
      for (const appid of ids) {
        const raw = await optionalJson('store', '/api/appdetails', { query: { appids: appid, l: 'english', cc: 'us' } });
        const d = raw[String(appid)]; need(d?.success && d.data, 'SOURCE_INVALID_DATA', 503);
        const price = d.data.price_overview;
        result.dlcs.push({ appid, name: text(d.data.name, 240), owned: null, price: { currency: price?.currency || null, final: number(price?.final) === null ? null : price.final / 100 } });
      }
      } catch (error) {
        // The DLC catalog is optional: preserve the inventory and any catalog rows
        // already observed, without treating an interrupted read as complete.
        recordOptionalError('store', error);
      }
    }
    // Optional reviewed pricing/entitlement engine. It only gets managed network + public rows,
    // not keys. It must use the supplied signal/request and return evidence-backed values.
    if ((!options.riskRead || available) && !options.skipEnrichment && allowed('inventoryEnrichment')) {
      try {
      need(typeof enrichment === 'function', 'SOURCE_NOT_CONFIGURED', 503);
      need(!optional.signal.aborted, 'SOURCE_TIMEOUT', 503);
      const extra = await network.tracked(signal => enrichment({ steamId: id, inventory: structuredClone(result) }, { signal, request: (source, path, options = {}) => { need(['scmm','rusthelp'].includes(source), 'SOURCE_URL_REJECTED', 503); return network.json(source, path, { ...options, signal }); } }), optional.signal);
      if (requiresProjection(enrichment,extra)) {
        const projected=projectInventoryEnrichment(extra,{steamId:id,inventory:result});
        for(const price of projected.prices){const item=result.skins.find(i=>i.id===price.id);item.price=price.price;item.currency=price.currency;item.priceEvidence=price.evidence;}
        for(const item of projected.entitlements){const dlc=result.dlcs.find(d=>d.appid===item.appid);dlc.owned=item.owned;dlc.ownershipEvidence=item.evidence;}
        result.dlcOwnershipAvailable=result.dlcs.length>0&&result.dlcs.every(d=>d.owned!==null);
        result.totalSummary=projected.totalSummary;result.providerEvidence=projected.providerEvidence;
        result.coverage=projected.providerEvidence.valuation.kind==='aggregate'?'inventory_observed_total_aggregate':projected.providerEvidence.status==='complete'?'inventory_observed_prices_complete':'inventory_observed_prices_partial';
        return sealInventoryHost(result,projected.proof);
      }
      // Legacy host-injected readers keep their original numeric contract; no new evidence/aggregate trust.
      need(extra && Array.isArray(extra.prices || []) && (extra.prices || []).length <= 2000, 'SOURCE_INVALID_DATA', 503);
      for (const p of extra.prices || []) {
        const item = result.skins.find(x => x.id === p.id); need(item && number(p.price) !== null && /^[A-Z]{3}$/.test(p.currency), 'SOURCE_INVALID_DATA', 503);
        item.price = p.price; item.currency = p.currency;
      }
      const known = result.skins.length && result.skins.every(x => x.price !== null) && new Set(result.skins.map(x => x.currency)).size === 1;
      if (known) result.totalSummary = { currency: result.skins[0].currency, totalValue: result.skins.reduce((n, x) => n + x.price * x.quantity, 0) };
      if (Array.isArray(extra.entitlements)) {
        for (const e of extra.entitlements) { const d = result.dlcs.find(x => x.appid === e.appid); need(d && typeof e.owned === 'boolean' && e.evidenceId, 'SOURCE_INVALID_DATA', 503); d.owned = e.owned; }
        result.dlcOwnershipAvailable = result.dlcs.length > 0 && result.dlcs.every(d => d.owned !== null);
      }
      } catch (error) {
        if (!options.riskRead) {
          recordOptionalError(['scmm','rusthelp'].includes(error.sourceId) ? error.sourceId : 'inventoryEnrichment', error);
          return result;
        }
        if (options.signal?.aborted || network.stopped) throw error;
        // Inventory visibility was already observed. Pricing failure does not erase it.
        result.enrichmentError = error?.errorCode === 'RATE_LIMITED' || error?.status === 429 ? 'RATE_LIMITED' : 'SOURCE_PRICE_UNAVAILABLE';
        if (result.enrichmentError === 'RATE_LIMITED') result.retryAfterMs = Math.min(3600000, Math.max(1000, Number(error.retryAfterMs) || 60000));
        result.totalSummary = { currency: null, totalValue: null };
      }
    }
    return result;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abortOptional);
      abortOptional();
    }
  };
}
