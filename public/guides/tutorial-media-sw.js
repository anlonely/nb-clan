/* Full, versioned tutorial videos only; unrelated application caches are untouched. */
(() => {
  const CACHE_NAME = 'rsg-tutorial-media-v1';
  const VERSION_HEADER = 'X-RSG-Tutorial-Version';
  const MAX_BYTES = 16 * 1024 * 1024;
  const PATHS = new Set(['/guides/kook-steam-binding.mp4', '/guides/add-steam-friend.mp4', '/guides/add-steam-friend-en.mp4', '/guides/discord-steam-binding.mp4', '/guides/kook-steam-binding-en.mp4']);
  const pending = new Map();
  const storedOrder = new Map();
  let sequence = 0;
  let writes = Promise.resolve();

  function tutorialUrl(value) {
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value, self.location.origin);
      if (url.origin !== self.location.origin || url.username || url.password || url.hash || !PATHS.has(url.pathname) ||
        !/^\?v=[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(url.search)) return null;
      return url;
    } catch { return null; }
  }

  function expectedSize(response) {
    const length = response.headers.get('Content-Length');
    const encoding = response.headers.get('Content-Encoding');
    if (response.status !== 200 || response.redirected || response.headers.has('Content-Range') ||
      response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'video/mp4' ||
      (encoding && encoding.toLowerCase() !== 'identity') || !/^\d+$/.test(length || '')) return 0;
    const size = Number(length);
    return Number.isSafeInteger(size) && size > 0 && size <= MAX_BYTES ? size : 0;
  }

  async function completeBytes(response, expected) {
    // Keep the network response available even if validation or storage fails.
    const reader = response.clone().body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > expected) throw Error('Incomplete or oversized video');
        chunks.push(item.value);
      }
      if (size !== expected) throw Error('Incomplete video');
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      // MP4 begins with an ISO BMFF file-type box, not an HTML error document.
      const firstBoxSize = size >= 16 ? new DataView(bytes.buffer).getUint32(0) : 0;
      if (firstBoxSize < 16 || firstBoxSize > size || bytes[4] !== 102 || bytes[5] !== 116 || bytes[6] !== 121 || bytes[7] !== 112) {
        throw Error('Invalid MP4');
      }
      return bytes;
    } finally {
      // A cancelled tee branch waits for its sibling, so do not await cancellation.
      reader.cancel().catch(() => {});
    }
  }

  async function save(cache, key, response, order) {
    if (!cache) return;
    const operation = writes.then(async () => {
      if (order < (storedOrder.get(key) || 0)) return;
      // Fixed path keys atomically replace a version, keeping one entry per tutorial.
      await cache.put(key, response.clone());
      storedOrder.set(key, order);
    });
    writes = operation.catch(() => {});
    await writes;
  }

  async function load(url, order) {
    const key = `${url.origin}${url.pathname}`;
    const version = url.searchParams.get('v');
    let cache;
    try {
      cache = await self.caches.open(CACHE_NAME);
      const cached = await cache.match(key);
      if (cached && cached.headers.get(VERSION_HEADER) === version && expectedSize(cached)) {
        return { response: cached, full: true, source: 'hit' };
      }
    } catch { /* Storage may be disabled; the same download can still play. */ }

    // Strip Range and credentials: both warming and playback share this full GET.
    const response = await fetch(url.href, {
      method: 'GET', mode: 'same-origin', credentials: 'omit', redirect: 'error',
      headers: { Accept: 'video/mp4' },
    });
    const expected = expectedSize(response);
    if (!expected) return { response, full: false, source: 'network' };
    let bytes;
    try { bytes = await completeBytes(response, expected); }
    catch { return { response, full: false, source: 'network' }; }
    response.body?.cancel().catch(() => {});
    const headers = new Headers(response.headers);
    headers.delete('Content-Encoding');
    headers.delete('Transfer-Encoding');
    headers.set('Accept-Ranges', 'bytes');
    headers.set(VERSION_HEADER, version);
    const full = new Response(bytes, { status: 200, headers });
    await save(cache, key, full, order);
    return { response: full, full: true, source: 'network' };
  }

  function media(url) {
    if (!pending.has(url.href)) {
      const operation = load(url, ++sequence);
      pending.set(url.href, operation);
      const clear = () => { if (pending.get(url.href) === operation) pending.delete(url.href); };
      operation.then(clear, clear);
    }
    return pending.get(url.href);
  }

  function ifRangeMatches(request, headers) {
    const condition = request.headers.get('If-Range');
    if (!condition) return true;
    if (condition.startsWith('"')) return condition === headers.get('ETag');
    const modified = Date.parse(headers.get('Last-Modified'));
    const date = Date.parse(condition);
    return Number.isFinite(modified) && Number.isFinite(date) && modified <= date;
  }

  async function serve(request, result) {
    const response = result.response.clone();
    if (!result.full) return response;
    const headers = new Headers(response.headers);
    headers.delete(VERSION_HEADER);
    headers.set('X-RSG-Tutorial-Cache', result.source);
    const range = request.headers.get('Range');
    // Ignoring unsupported units/multipart ranges with a full 200 is valid HTTP.
    if (!range || !range.startsWith('bytes=') || range.includes(',') || !ifRangeMatches(request, headers)) {
      return new Response(response.body, { status: 200, headers });
    }
    const size = Number(headers.get('Content-Length'));
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start, end;
    if (match && (match[1] || match[2])) {
      if (!match[1]) {
        const suffix = BigInt(match[2]);
        if (suffix > 0n) { start = Number(BigInt(size) > suffix ? BigInt(size) - suffix : 0n); end = size - 1; }
      } else {
        const first = BigInt(match[1]);
        const last = match[2] ? BigInt(match[2]) : BigInt(size - 1);
        if (first < BigInt(size) && first <= last) { start = Number(first); end = Number(last < BigInt(size) ? last : BigInt(size - 1)); }
      }
    }
    if (start === undefined) {
      response.body?.cancel().catch(() => {});
      headers.set('Content-Range', `bytes */${size}`);
      headers.set('Content-Length', '0');
      return new Response(null, { status: 416, headers });
    }
    const bytes = await response.arrayBuffer();
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    headers.set('Content-Length', String(end - start + 1));
    return new Response(bytes.slice(start, end + 1), { status: 206, headers });
  }

  self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
  self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
  self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;
    const url = tutorialUrl(event.request.url);
    if (url) event.respondWith(media(url).then(result => serve(event.request, result)));
  });
  self.addEventListener('message', event => {
    if (event.data?.type !== 'CACHE_TUTORIAL' || (event.origin && event.origin !== self.location.origin)) return;
    const url = tutorialUrl(event.data.url);
    if (url) event.waitUntil(media(url).then(() => {}, () => {}));
  });
})();
