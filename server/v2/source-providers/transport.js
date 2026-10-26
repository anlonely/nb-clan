import { createHash } from 'node:crypto';
import WebSocket from 'ws';

export const ORIGINS = Object.freeze({ moose: 'https://moose.gg', scmm: 'https://api.scmm.app', rusthelp: 'https://api.rusthelp.com' });
export const fault = (errorCode, status = 503) => Object.assign(new Error(errorCode), { errorCode, status });
export function requireFact(ok, code = 'SOURCE_INVALID_DATA') { if (!ok) throw fault(code); }
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safeCodes = new Set(['SOURCE_NOT_CONFIGURED','SOURCE_CONFIG_SYNC_REQUIRED','SOURCE_TIMEOUT','SOURCE_BUSY','SOURCE_URL_REJECTED','SOURCE_METHOD_REJECTED','SOURCE_REDIRECT_REJECTED','SOURCE_RESPONSE_TOO_LARGE','SOURCE_PAGE_LIMIT','SOURCE_INVALID_JSON','SOURCE_INVALID_DATA','SOURCE_EVIDENCE_EXPIRED','SOURCE_NO_MATCH','CREDENTIALS_CHANGED','PROXY_UNAVAILABLE','RATE_LIMITED']);
export function safeError(e) {
  const out = fault(safeCodes.has(e?.errorCode) ? e.errorCode : 'SOURCE_UNAVAILABLE', e?.errorCode === 'RATE_LIMITED' ? 429 : 503);
  if (out.errorCode === 'RATE_LIMITED') {
    out.retryAfterMs = Math.min(3600000, Math.max(1000, Number(e.retryAfterMs) || 60000));
    out.retryAfterKnown = e.retryAfterKnown === true;
    if (Object.hasOwn(ORIGINS, e.sourceId)) out.sourceId = e.sourceId;
  }
  return out;
}
function rateLimited(source, retry, now) {
  const numeric = /^\d+(\.\d+)?$/.test(retry || ''), date = Date.parse(retry);
  const ms = numeric ? Number(retry) * 1000 : date - now;
  return Object.assign(fault('RATE_LIMITED', 429), { sourceId: source,
    retryAfterMs: Number.isFinite(ms) ? ms : 60000,
    retryAfterKnown: Boolean(retry && (numeric || Number.isFinite(date))) });
}
const paths = {
  moose: /^\/(?:stats(?:\/[^?#]*)?|_framework\/[A-Za-z0-9_./-]+|_content\/[A-Za-z0-9_./-]+|(?:css|js)\/[A-Za-z0-9_./-]+|_blazor(?:\/negotiate)?)$/,
  scmm: /^\/api\/inventory\/7656119\d{10}(?:\/(?:value|summary))?$/,
  rusthelp: /^\/v1\/inventory\/summary\/7656119\d{10}$/
};
const bounded = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;
/** No ambient credentials, cookies, browser profile or fetch. One owner supplies config and transport. */
export function createProviderTransport({ readConfiguration, fetchImpl, proxyFetch, proxyWebSocket, origins = {}, allowLoopbackForTests = false,
  timeoutMs = 15000, maxBytes = 2097152, maxTotalBytes = 16777216, maxRequests = 256, maxSessions = 4, now = Date.now } = {}) {
  requireFact(typeof readConfiguration === 'function' && typeof fetchImpl === 'function', 'SOURCE_NOT_CONFIGURED');
  requireFact(bounded(timeoutMs, 20, 120000) && bounded(maxBytes, 128, 8388608) && bounded(maxTotalBytes, maxBytes, 33554432) && bounded(maxRequests, 1, 1000) && bounded(maxSessions, 1, 12));
  const targets = { ...ORIGINS }, sessions = new Set(); let stopped = false;
  for (const [source, origin] of Object.entries(origins)) {
    let u; try { u = new URL(origin); } catch { throw fault('SOURCE_URL_REJECTED'); }
    requireFact(Object.hasOwn(targets, source) && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash &&
      (u.origin === ORIGINS[source] || allowLoopbackForTests && u.protocol === 'http:' && ['127.0.0.1','[::1]'].includes(u.hostname)), 'SOURCE_URL_REJECTED');
    targets[source] = u.origin;
  }
  const configuration = source => {
    try {
    const raw = readConfiguration(source); requireFact(!raw?.then, 'SOURCE_CONFIG_SYNC_REQUIRED');
    requireFact(raw?.enabled === true && (typeof raw.revision === 'string' && raw.revision.length > 0 && raw.revision.length <= 160 || Number.isSafeInteger(raw.revision) && raw.revision >= 0), 'SOURCE_NOT_CONFIGURED');
    const proxyUrl = raw.proxyUrl || ''; requireFact(typeof proxyUrl === 'string');
    if (proxyUrl) { let p; try { p = new URL(proxyUrl); } catch { throw fault('PROXY_UNAVAILABLE'); } requireFact(['http:','https:','socks:','socks4:','socks4a:','socks5:','socks5h:'].includes(p.protocol), 'PROXY_UNAVAILABLE'); }
    return { revision: raw.revision, proxyUrl, ...(raw.binding === undefined ? {} : { binding: raw.binding }) };
    } catch(e) { throw safeError(e); }
  };
  function open(source, { signal, origin } = {}) {
    requireFact(Object.hasOwn(targets, source), 'SOURCE_URL_REJECTED');
    requireFact(!stopped && !signal?.aborted, 'SOURCE_TIMEOUT'); requireFact(sessions.size < maxSessions, 'SOURCE_BUSY');
    requireFact(!origin || origin === targets[source], 'SOURCE_URL_REJECTED');
    const config = configuration(source), binding = digest(config), controller = new AbortController(), pending = new Set(), sockets = new Set();
    let failure, closePromise, closed = false, totalBytes = 0, requests = 0, frames = 0;
    const cleanups = new Set();
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    const check = () => { if (failure) throw failure; requireFact(!closed && !stopped && !controller.signal.aborted, 'SOURCE_TIMEOUT'); requireFact(digest(configuration(source)) === binding, 'CREDENTIALS_CHANGED'); };
    const fail = e => { failure ||= safeError(e); controller.abort(); return failure; };
    const count = bytes => { totalBytes += bytes; requireFact(totalBytes <= maxTotalBytes, 'SOURCE_RESPONSE_TOO_LARGE'); };
    const urlFor = (input, method, socket = false) => {
      requireFact(typeof input === 'string' && input.length <= 4096 && !input.includes('\\') && !/%(?:2f|5c|2e)/i.test(input) && !/(?:^|\/)\.{1,2}(?:\/|$|\?)/.test(input), 'SOURCE_URL_REJECTED');
      const u = new URL(input, targets[source]);
      if (socket) { requireFact(source === 'moose' && ['ws:','wss:'].includes(u.protocol), 'SOURCE_URL_REJECTED'); u.protocol = u.protocol === 'ws:' ? 'http:' : 'https:'; }
      requireFact(u.origin === targets[source] && !u.username && !u.password && !u.hash && paths[source].test(u.pathname) && (!socket || u.pathname === '/_blazor'), 'SOURCE_URL_REJECTED');
      requireFact(method === 'GET' || source === 'moose' && ['POST','DELETE'].includes(method) && /^\/_blazor(?:\/negotiate)?$/.test(u.pathname), 'SOURCE_METHOD_REJECTED');
      return u;
    };
    const track = fn => {
      const p = Promise.resolve().then(() => { check(); return fn(); }).catch(e => { throw controller.signal.aborted ? failure || fault('SOURCE_TIMEOUT') : safeError(e); });
      pending.add(p); p.then(() => pending.delete(p), () => pending.delete(p)); return p;
    };
    const request = (path, { method = 'GET', body, contentType, query } = {}) => track(async () => {
      const u = urlFor(path, method); for (const [k,v] of Object.entries(query || {})) u.searchParams.set(k, String(v));
      requireFact(++requests <= maxRequests, 'SOURCE_PAGE_LIMIT');
      requireFact(body === undefined || typeof body === 'string' || Buffer.isBuffer(body));
      requireFact(body === undefined || Buffer.byteLength(body) <= 32768, 'SOURCE_RESPONSE_TOO_LARGE');
      const headers = { accept: source === 'moose' ? '*/*' : 'application/json' };
      if (source === 'scmm' && !u.pathname.endsWith('/summary')) u.searchParams.set('currency', 'USD');
      if (source === 'rusthelp') { headers['x-currency-code'] = 'USD'; headers['user-agent'] = 'nb-clan-inventory/2.0'; }
      if (body !== undefined) { requireFact(['application/json','application/octet-stream','text/plain;charset=UTF-8','text/plain'].includes(contentType)); headers['content-type'] = contentType; }
      const fetcher = config.proxyUrl ? proxyFetch : fetchImpl; requireFact(typeof fetcher === 'function', 'PROXY_UNAVAILABLE');
      let raw;
      try {
        raw = await fetcher(u.href, { method, signal: controller.signal, redirect: 'manual', headers, ...(body === undefined ? {} : { body }), ...(config.proxyUrl ? { proxyUrl: config.proxyUrl } : {}) });
        check(); requireFact(!raw.redirected && !(raw.status >= 300 && raw.status < 400) && (!raw.url || new URL(raw.url).origin === targets[source]), 'SOURCE_REDIRECT_REJECTED');
        if (raw.status === 429) throw rateLimited(source, raw.headers.get('retry-after'), now());
        requireFact(raw.ok, raw.status === 404 ? 'SOURCE_NO_MATCH' : 'SOURCE_UNAVAILABLE');
        let size = 0; const chunks = [];
        if (raw.body) {
          const reader = raw.body.getReader(), cancel = () => { void reader.cancel().catch(() => {}); };
          controller.signal.addEventListener('abort', cancel, { once: true });
          try { for (;;) { check(); const {done,value} = await reader.read(); if (done) break; size += value.length; count(value.length); requireFact(size <= maxBytes, 'SOURCE_RESPONSE_TOO_LARGE'); chunks.push(value); } }
          catch (e) { await reader.cancel().catch(() => {}); throw e; }
          finally { controller.signal.removeEventListener('abort', cancel); reader.releaseLock(); }
        }
        check(); return { status: raw.status, body: Buffer.concat(chunks), contentType: raw.headers.get('content-type')?.slice(0, 160) || 'application/octet-stream', observedAt: new Date(now()).toISOString() };
      } finally { if (raw?.body && !raw.body.locked) await raw.body.cancel().catch(() => {}); }
    });
    const json = async (path, options) => { const r = await request(path, options); try { return JSON.parse(r.body.toString('utf8')); } catch { throw fault('SOURCE_INVALID_JSON'); } };
    const socket = (input, protocols = [], onEvent) => {
      check(); const u = urlFor(input, 'GET', true); requireFact(sockets.size < 2 && ++requests <= maxRequests, 'SOURCE_PAGE_LIMIT');
      requireFact(Array.isArray(protocols) && protocols.length <= 4 && protocols.every(p => /^[\w.-]{1,80}$/.test(p)));
      u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
      const options = { headers: { origin: targets[source] }, followRedirects: false, handshakeTimeout: Math.min(timeoutMs,10000), maxPayload: Math.min(maxBytes,262144), perMessageDeflate: false };
      requireFact(!config.proxyUrl || typeof proxyWebSocket === 'function', 'PROXY_UNAVAILABLE');
      const ws = config.proxyUrl ? proxyWebSocket(u.href, protocols, { ...options, proxyUrl: config.proxyUrl }) : new WebSocket(u.href, protocols, options);
      const done = new Promise(resolve => ws.once('close', resolve)); sockets.add(ws); pending.add(done); done.then(() => { sockets.delete(ws); pending.delete(done); });
      const event = value => { try { check(); onEvent(value); } catch (e) { fail(e); ws.terminate(); } };
      ws.on('open', () => event({ type: 'open', protocol: ws.protocol }));
      ws.on('message', (data, binary) => { try { check(); requireFact(++frames <= 1000 && data.length <= Math.min(maxBytes,262144), 'SOURCE_RESPONSE_TOO_LARGE'); count(data.length); event({ type:'message', binary, data: Buffer.from(data).toString('base64') }); } catch(e) { fail(e); ws.terminate(); } });
      ws.on('unexpected-response', (_req,res) => { res.resume(); fail(res.statusCode === 429 ? rateLimited(source, res.headers['retry-after'], now()) : fault(res.statusCode >= 300 && res.statusCode < 400 ? 'SOURCE_REDIRECT_REJECTED' : 'SOURCE_UNAVAILABLE')); ws.terminate(); });
      ws.on('error', e => { if (!closed && !controller.signal.aborted) fail(fault(e?.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' ? 'SOURCE_RESPONSE_TOO_LARGE' : 'SOURCE_UNAVAILABLE')); });
      ws.on('close', code => { if (!closed && !controller.signal.aborted) onEvent({type:'close',code}); });
      const abortSocket = () => ws.terminate(); controller.signal.addEventListener('abort', abortSocket, {once:true}); done.then(() => controller.signal.removeEventListener('abort',abortSocket));
      return { send(data, binary) { check(); requireFact(typeof data === 'string' && data.length <= 350000, 'SOURCE_RESPONSE_TOO_LARGE'); const bytes = Buffer.from(data,'base64'); requireFact(++frames <= 1000 && bytes.length <= 262144, 'SOURCE_RESPONSE_TOO_LARGE'); count(bytes.length); requireFact(ws.readyState === WebSocket.OPEN); ws.send(bytes, { binary }); }, close() { ws.terminate(); } };
    };
    const session = { source, origin: targets[source], signal: controller.signal, binding, revision: config.revision, check, fail, request, json, socket,
      onClose(fn) { check(); requireFact(typeof fn === 'function'); cleanups.add(fn); },
      evidence: () => ({ source, origin:targets[source], binding, revision:config.revision, requests, bytes:totalBytes, observedAt:new Date(now()).toISOString(), cached:false }),
      close() { return closePromise ||= (async () => { closed = true; controller.abort(); clearTimeout(timer); signal?.removeEventListener('abort',abort); for (const ws of sockets) ws.terminate(); await Promise.allSettled([...cleanups].map(fn=>Promise.resolve().then(fn))); await Promise.allSettled([...pending]); sessions.delete(session); })(); }
    };
    sessions.add(session); return session;
  }
  return { open, binding(source) { requireFact(!stopped,'SOURCE_TIMEOUT');requireFact(Object.hasOwn(targets,source),'SOURCE_URL_REJECTED');return digest(configuration(source)); }, get active() { return sessions.size; }, async stop() { stopped = true; await Promise.allSettled([...sessions].map(s => s.close())); } };
}
