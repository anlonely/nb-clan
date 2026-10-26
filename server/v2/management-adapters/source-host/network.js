import { need, hash } from '../../stats/model.js';
export const TRUSTED_ORIGINS = Object.freeze({ discord: 'https://discord.com', steam: 'https://api.steampowered.com', community: 'https://steamcommunity.com', store: 'https://store.steampowered.com', vital: 'https://playerstatistics.vitalgamenetwork.com', battlemetrics: 'https://api.battlemetrics.com', moose: 'https://moose.gg', scmm: 'https://api.scmm.app', rusthelp: 'https://api.rusthelp.com' });
const error = (code, status = 503) => Object.assign(new Error(code), { errorCode: code, status });
const codes = new Set(['SOURCE_CONFIG_SYNC_REQUIRED','SOURCE_NOT_CONFIGURED','SOURCE_BUSY','SOURCE_TIMEOUT','SOURCE_URL_REJECTED','SOURCE_METHOD_REJECTED','SOURCE_REDIRECT_REJECTED','SOURCE_RESPONSE_TOO_LARGE','SOURCE_INVALID_JSON','SOURCE_INVALID_DATA','SOURCE_PAGE_LIMIT','SOURCE_PAGINATION_INVALID','SOURCE_NO_MATCH','RATE_LIMITED','CREDENTIALS_INVALID','PROXY_UNAVAILABLE','INVALID_DATA','CREDENTIALS_CHANGED','ELIGIBILITY_DENIED','ELIGIBILITY_UNAVAILABLE','ADMISSION_ROLE_CONFIG_INVALID']);
const rules = {
  discord: /^\/api\/v10\/guilds\/\d{17,20}\/(?:roles|members\/\d{17,20})$/,
  steam: /^\/(?:ISteamUser\/(?:GetPlayerSummaries\/v0002|GetPlayerBans\/v1|ResolveVanityURL\/v0001)|ISteamUserStats\/GetUserStatsForGame\/v0002|IPlayerService\/GetOwnedGames\/v0001)\/?$/,
  community: /^\/(?:inventory\/7656119\d{10}\/252490\/2|broadcast\/getbroadcastmpd\/|profiles\/7656119\d{10}\/?)$/,
  store: /^\/(?:api\/appdetails|itemstore\/252490\/ajaxgetitemdefs\/)$/,
  vital: /^\/(?:servers(?:\/\d{1,8}\/wipes)?|players\/overview)$/,
  battlemetrics: /^\/players(?:\/match|\/\d{1,30}\/relationships\/sessions)?$/,
  moose: /^\/stats(?:\/.*)?$/,
  scmm: /^\/api\/inventory\/7656119\d{10}(?:\/(?:value|summary))?$/,
  rusthelp: /^\/v1\/inventory\/summary\/7656119\d{10}$/
};
export function createSourceNetwork({ fetchImpl, proxyFetch, origins = {}, allowLoopbackForTests = false, credentials, timeoutMs = 15000, maxBytes = 2 * 1024 * 1024, maxActive = 12 }) {
  need(typeof fetchImpl === 'function' && typeof credentials === 'function', 'SOURCE_NOT_CONFIGURED', 503);
  need(Number.isInteger(timeoutMs) && timeoutMs >= 20 && timeoutMs <= 120000 && Number.isInteger(maxBytes) && maxBytes >= 128 && maxBytes <= 8 * 1024 * 1024 && Number.isInteger(maxActive) && maxActive >= 1 && maxActive <= 100, 'INVALID_DATA');
  const targets = { ...TRUSTED_ORIGINS }, tasks = new Set(), controllers = new Set(); let stopped = false;
  for (const [name, value] of Object.entries(origins)) {
    let u; try { u = new URL(value); } catch { throw error('SOURCE_ORIGIN_INVALID'); }
    need(Object.hasOwn(targets, name) && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash && (u.origin === targets[name] || allowLoopbackForTests && u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname)), 'SOURCE_ORIGIN_INVALID', 503);
    targets[name] = u.origin;
  }
  function assertPath(source, input, method) {
    need(Object.hasOwn(targets, source) && typeof input === 'string' && input.startsWith('/') && !input.startsWith('//') && !input.includes('\\') && !input.includes('#'), 'SOURCE_URL_REJECTED', 503);
    const u = new URL(input, targets[source]);
    need(u.origin === targets[source] && rules[source].test(u.pathname), 'SOURCE_URL_REJECTED', 503);
    need(method === 'GET' || method === 'POST' && (source === 'battlemetrics' && u.pathname === '/players/match' || source === 'vital' && u.pathname === '/players/overview'), 'SOURCE_METHOD_REJECTED', 503);
    return u;
  }
  const scrub = (value, secrets) => {
    if (typeof value === 'string') { for (const s of secrets.filter(x => typeof x === 'string' && x.length >= 4)) value = value.split(s).join('[redacted]'); return value; }
    if (Array.isArray(value)) return value.map(v => scrub(v, secrets));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [scrub(k, secrets), scrub(v, secrets)]));
    return value;
  };
  async function tracked(fn, signal, timeoutMultiplier = 1) {
    need([1, 3].includes(timeoutMultiplier), 'INVALID_DATA');
    need(!stopped && !signal?.aborted, 'SOURCE_TIMEOUT', 503); need(tasks.size < maxActive, 'SOURCE_BUSY', 503);
    const controller = new AbortController(); controllers.add(controller);
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, Math.min(120000, timeoutMs * timeoutMultiplier));
    const work = Promise.resolve().then(() => { need(!stopped && !controller.signal.aborted, 'SOURCE_TIMEOUT', 503); return fn(controller.signal); }); tasks.add(work);
    try {
      const value = await work;
      need(!controller.signal.aborted && !stopped, 'SOURCE_TIMEOUT', 503); return value;
    } catch (e) {
      if (controller.signal.aborted || stopped) throw error('SOURCE_TIMEOUT');
      if (codes.has(e?.errorCode)) { const safe = error(e.errorCode, e.errorCode === 'RATE_LIMITED' ? 429 : e.errorCode === 'SOURCE_NO_MATCH' ? 404 : 503); if (e.errorCode === 'RATE_LIMITED') { safe.retryAfterMs = Math.min(3600000, Math.max(1000, Number(e.retryAfterMs) || 60000)); safe.retryAfterKnown = e.retryAfterKnown === true; if (Object.hasOwn(targets, e.sourceId)) safe.sourceId = e.sourceId; } throw safe; }
      throw error('SOURCE_UNAVAILABLE');
    } finally { controller.abort(); clearTimeout(timer); controllers.delete(controller); tasks.delete(work); signal?.removeEventListener('abort', abort); }
  }
  const response = (source, path, { signal, method = 'GET', body, query, requireKey = false, expectedCredentialsHash, acceptHtml = false } = {}) => tracked(async ownedSignal => {
    const c = credentials(source);
    need(!expectedCredentialsHash || hash(c) === expectedCredentialsHash, 'CREDENTIALS_CHANGED', 503);
    const secrets = [c.key, c.proxyUrl];
    if (c.proxyUrl) { const p = new URL(c.proxyUrl); secrets.push(decodeURIComponent(p.username), decodeURIComponent(p.password)); }
    need(!requireKey || c.key, 'SOURCE_NOT_CONFIGURED', 503);
    let u = assertPath(source, path, method);
    need(!acceptHtml || source === 'community' && /^\/profiles\/7656119\d{10}\/?$/.test(u.pathname), 'SOURCE_URL_REJECTED', 503);
    for (const [k, v] of Object.entries(query || {})) if (v !== null && v !== undefined && v !== '') u.searchParams.set(k, String(v));
    if (source === 'steam' && requireKey) u.searchParams.set('key', c.key);
    const headers = acceptHtml ? { accept: 'text/html', 'accept-language': 'en-US,en;q=0.9' } : { accept: 'application/json' };
    if (source === 'discord') { need(c.key, 'SOURCE_NOT_CONFIGURED', 503); headers.authorization = `Bot ${c.key}`; }
    if (source === 'battlemetrics') { need(c.key, 'SOURCE_NOT_CONFIGURED', 503); headers.authorization = `Bearer ${c.key}`; }
    if (body !== undefined) headers['content-type'] = 'application/json';
    need(body === undefined || JSON.stringify(body).length <= 32768, 'INVALID_DATA');
    const fetcher = c.proxyUrl ? proxyFetch : fetchImpl; need(typeof fetcher === 'function', 'PROXY_UNAVAILABLE', 503);
    // Redirects are never followed. Thus a trusted first hop cannot move credentials to another origin.
    let raw;
    try { raw = await fetcher(u.href, { method, signal: ownedSignal, redirect: 'manual', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(c.proxyUrl ? { proxyUrl: c.proxyUrl } : {}) }); }
    catch (cause) {
      if (ownedSignal.aborted) throw error('SOURCE_TIMEOUT');
      // A failed configured proxy route must remain distinguishable from source data.
      // Never include the transport message: it may contain the credentialed URL.
      if (codes.has(cause?.errorCode)) throw cause;
      throw error(c.proxyUrl ? 'PROXY_UNAVAILABLE' : 'SOURCE_UNAVAILABLE');
    }
    try {
    need(!ownedSignal.aborted, 'SOURCE_TIMEOUT', 503);
    need(!raw.redirected && !(raw.status >= 300 && raw.status < 400), 'SOURCE_REDIRECT_REJECTED', 503);
    if (raw.url) need(new URL(raw.url).origin === targets[source], 'SOURCE_REDIRECT_REJECTED', 503);
    const chunks = []; let bytes = 0;
    if (raw.body) {
      const reader = raw.body.getReader();
      const cancel = () => { void reader.cancel().catch(() => {}); };
      ownedSignal.addEventListener('abort', cancel, { once: true });
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; need(bytes <= maxBytes, 'SOURCE_RESPONSE_TOO_LARGE', 503); chunks.push(value); } }
      catch (e) { await reader.cancel().catch(() => {}); throw e; }
      finally { ownedSignal.removeEventListener('abort', cancel); reader.releaseLock(); }
    }
    const safeHeaders = new Headers();
    for (const k of ['retry-after', 'x-rate-limit-limit', 'x-rate-limit-remaining']) { const v = raw.headers.get(k); if (v && (k === 'retry-after' ? /^\d+(\.\d+)?$/.test(v) || Number.isFinite(Date.parse(v)) : /^\d+$/.test(v))) safeHeaders.set(k, v.slice(0, 100)); }
    let payload = {};
    if ((raw.ok || source === 'discord' && raw.status === 404) && bytes) {
      if (acceptHtml) payload = Buffer.concat(chunks).toString('utf8');
      else { try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw error('SOURCE_INVALID_JSON'); } }
    }
    if (source === 'discord' && !raw.ok) payload = { code: Number.isSafeInteger(payload?.code) ? payload.code : null };
    // Body is fully consumed under owned signal; callers cannot leave hidden response I/O after stop.
    return new Response([204,205,304].includes(raw.status) ? null : acceptHtml ? scrub(payload, secrets) : JSON.stringify(scrub(payload, secrets)), { status: raw.status, headers: safeHeaders });
    } finally { if (raw.body && !raw.body.locked) await raw.body.cancel().catch(() => {}); }
  }, signal);
  const json = async (source, path, options = {}) => {
    const r = await response(source, path, options);
    if (r.status === 429) {
      const retry = r.headers.get('retry-after'), numeric = /^\d+(\.\d+)?$/.test(retry || ''), date = Date.parse(retry);
      const delay = numeric ? Number(retry) * 1000 : date - Date.now();
      const e = error('RATE_LIMITED', 429); e.retryAfterMs = Math.min(3600000, Math.max(1000, Number.isFinite(delay) ? delay : 60000)); e.retryAfterKnown = Boolean(retry && (numeric || Number.isFinite(date))); e.sourceId = source; throw e;
    }
    if ([401, 403].includes(r.status)) throw error('CREDENTIALS_INVALID');
    if (r.status === 404) throw error('SOURCE_NO_MATCH', 404);
    // Steam can return 400 for a valid Rust account with no published game stats.
    if (source === 'steam' && /^\/ISteamUserStats\/GetUserStatsForGame\/v0002\/?$/.test(path) && r.status === 400) throw error('SOURCE_NO_MATCH', 404);
    need(r.ok, 'SOURCE_UNAVAILABLE', 503); return r.json();
  };
  const html = async (source, path, options = {}) => {
    const r = await response(source, path, { ...options, acceptHtml: true });
    if (r.status === 404) throw error('SOURCE_NO_MATCH', 404);
    need(r.ok, 'SOURCE_UNAVAILABLE', 503);
    return r.text();
  };
  return { response, json, html, tracked, origin: name => targets[name], async stop() { stopped = true; for (const c of controllers) c.abort(); await Promise.allSettled([...tasks]); }, get active() { return tasks.size; }, get stopped() { return stopped; } };
}
