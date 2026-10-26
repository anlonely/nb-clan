import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { need, SHARE_PAGE, METRICS } from './model.js';

export function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
      a === 192 && [0, 88, 168].includes(b) || a === 198 && [18, 19, 51].includes(b) || a === 203 && b === 0 || a === 100 && b >= 64 && b <= 127);
  }
  // Only globally routed IPv6 unicast. Deny translation/mapped/documentation/Teredo/6to4 ranges.
  if (isIP(address) === 6) {
    const a = address.toLowerCase();
    const parts = a.split(':');
    return /^[23][0-9a-f]{3}:/.test(a) && !['2002', '3fff'].includes(parts[0]) &&
      !(parts[0] === '2001' && (parseInt(parts[1] || '0', 16) < 0x200 || parseInt(parts[1] || '0', 16) === 0xdb8));
  }
  return false;
}

/** No default DNS, request, proxy or environment behavior. Host must inject both capabilities. */
export function createPinnedMediaFetch({ lookup, request, loopbackTestOrigin } = {}) {
  if (loopbackTestOrigin) {
    const u = new URL(loopbackTestOrigin);
    need(u.origin === loopbackTestOrigin && u.protocol === 'http:' && u.hostname === '127.0.0.1', 'MEDIA_TEST_ORIGIN_INVALID');
  }
  return async function fetchPinned(value, { method = 'GET', headers = {}, body, signal, allowedHosts, maxRedirects = 2 } = {}) {
    need(typeof lookup === 'function' && typeof request === 'function', 'MEDIA_FETCH_UNAVAILABLE', 503);
    need(Number.isSafeInteger(maxRedirects) && maxRedirects >= 0 && maxRedirects <= 2, 'MEDIA_REDIRECT_LIMIT_INVALID');
    let url = new URL(value);
    for (let hop = 0; ; hop++) {
      signal.throwIfAborted();
      const local = loopbackTestOrigin && url.origin === loopbackTestOrigin;
      need(!url.username && !url.password && !url.hash && url.href.length <= 2048 &&
        (local || url.protocol === 'https:' && (!url.port || url.port === '443') && allowedHosts?.includes(url.hostname)), 'MEDIA_URL_FORBIDDEN', 403);
      const addresses = await lookup(url.hostname, { all: true, verbatim: true, signal }); signal.throwIfAborted();
      need(Array.isArray(addresses) && addresses.length > 0 && addresses.length <= 16 && addresses.every(a =>
        isIP(a.address) === a.family && (local ? a.address === '127.0.0.1' : publicAddress(a.address))), 'MEDIA_ADDRESS_FORBIDDEN', 403);
      const response = await request({ url, method, headers, body, signal, address: addresses[0] });
      try { signal.throwIfAborted(); } catch (e) { await response.dispose?.(); throw e; }
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers?.get?.('location'); await response.dispose?.();
      need(method === 'GET' && hop < maxRedirects && typeof location === 'string', 'MEDIA_REDIRECT_FORBIDDEN', 502);
      url = new URL(location, url);
    }
  };
}

/** Explicit opt-in Node transport: pinned lookup, normal TLS verification, no env proxy or connection pool. */
export function nodePinnedMediaRequest({ url, method, headers, body, signal, address }) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, { method, headers, signal, agent: false, rejectUnauthorized: true,
      servername: url.hostname, lookup: (_host, opts, callback) => {
        if (opts?.all) callback(null, [address]); else callback(null, address.address, address.family);
      } }, res => {
      const closed = new Promise(r => res.once('close', r));
      resolve({ status: res.statusCode, headers: new Headers(Object.entries(res.headers).filter(([,v]) => v !== undefined).map(([k,v]) => [k, Array.isArray(v) ? v.join(',') : String(v)])),
        body: res, dispose: async () => { if (!res.destroyed) res.destroy(); await closed; } });
    });
    const requestClosed = new Promise(r => req.once('close', r));
    req.once('error', async err => { await requestClosed; reject(err); });
    if (body) req.write(body); req.end();
  });
}

export function createWechatCodeExchange({ fetch } = {}) {
  return async ({ accessToken, page, scene, width, signal, assertCurrent }) => {
    need(typeof fetch === 'function', 'MEDIA_CODE_EXCHANGE_UNAVAILABLE', 503);
    need(page === SHARE_PAGE && METRICS.some(m => scene === `m=${m}`) && width === 360, 'MEDIA_SHARE_INPUT_INVALID');
    assertCurrent();
    const url = new URL('https://api.weixin.qq.com/wxa/getwxacodeunlimit');
    url.searchParams.set('access_token', accessToken);
    return fetch(url, { method: 'POST', signal, allowedHosts: ['api.weixin.qq.com'], maxRedirects: 0,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page, scene, width,
        check_path: true, env_version: 'release', is_hyaline: false }) });
  };
}
