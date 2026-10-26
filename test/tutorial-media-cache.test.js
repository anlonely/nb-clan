import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const script = await readFile(new URL('../public/guides/tutorial-media-sw.js', import.meta.url), 'utf8');
const origin = 'https://clan.example';
const binding = `${origin}/guides/kook-steam-binding.mp4`;
const friends = `${origin}/guides/add-steam-friend.mp4`;
const videoUrl = `${binding}?v=binding-hq-2`;
const cacheName = 'rsg-tutorial-media-v1';
const versionHeader = 'X-RSG-Tutorial-Version';
const mp4 = (size = 64) => {
  const bytes = new Uint8Array(size);
  new DataView(bytes.buffer).setUint32(0, 24);
  bytes.set(new TextEncoder().encode('ftypisom'), 4);
  for (let i = 12; i < size; i++) bytes[i] = i % 256;
  return bytes;
};
const video = (bytes = mp4(), options = {}) => new Response(bytes, {
  status: options.status || 200,
  headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(bytes.length),
    ETag: '"tutorial-2"', 'Last-Modified': 'Mon, 28 Sep 2026 12:00:00 GMT', ...options.headers },
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function storage() {
  const buckets = new Map();
  const state = { openError: false, matchError: false, putError: false, puts: 0, maxEntries: 0 };
  const caches = {
    async open(name) {
      if (state.openError) throw Error('Storage is unavailable');
      if (!buckets.has(name)) buckets.set(name, new Map());
      const entries = buckets.get(name);
      return {
        async match(key) {
          if (state.matchError) throw Error('Cannot read cache');
          return entries.get(typeof key === 'string' ? key : key.url)?.clone();
        },
        async put(key, response) {
          if (state.putError) throw new DOMException('Quota exceeded', 'QuotaExceededError');
          assert.equal(response.status, 200, 'only full responses may be stored');
          const body = await response.arrayBuffer();
          entries.set(typeof key === 'string' ? key : key.url, new Response(body, { status: response.status, headers: response.headers }));
          state.puts++;
          state.maxEntries = Math.max(state.maxEntries, entries.size);
        },
      };
    },
  };
  return { caches, buckets, state };
}

function worker(fetcher = async () => video(), store = storage()) {
  const listeners = new Map();
  const calls = [];
  let skipped = 0, claimed = 0;
  const self = {
    location: new URL(`${origin}/guides/tutorial-media-sw.js`), caches: store.caches,
    skipWaiting: async () => { skipped++; }, clients: { claim: async () => { claimed++; } },
    addEventListener: (type, listener) => listeners.set(type, listener),
  };
  vm.runInNewContext(script, { self, URL, Headers, Request, Response, TextEncoder, Uint8Array, DataView,
    fetch: (input, init) => { const request = new Request(input, init); calls.push(request); return fetcher(request); },
  }, { filename: 'tutorial-media-sw.js' });
  function dispatch(type, fields = {}) {
    const waits = [];
    let response;
    listeners.get(type)({ ...fields, waitUntil: promise => waits.push(promise), respondWith: promise => { response = promise; } });
    return { response, done: Promise.all(waits), waitCount: waits.length };
  }
  return {
    ...store, calls, dispatch,
    request: (url = videoUrl, headers = {}, method = 'GET') => dispatch('fetch', { request: new Request(url, { method, headers }) }).response,
    warm: (url = videoUrl) => dispatch('message', { data: { type: 'CACHE_TUTORIAL', url } }),
    lifecycle: () => ({ skipped, claimed }),
  };
}

const body = async response => new Uint8Array(await response.arrayBuffer());

test('worker immediately activates and claims clients without touching unrelated caches', async () => {
  const w = worker();
  const unrelated = new Map([['app-shell', 'preserved']]); w.buckets.set('existing-app', unrelated);
  await w.dispatch('install').done;
  await w.dispatch('activate').done;
  assert.deepEqual(w.lifecycle(), { skipped: 1, claimed: 1 });
  assert.deepEqual([...w.buckets], [['existing-app', unrelated]]);
});

test('only GET requests for the two same-origin, explicitly versioned videos are intercepted', async () => {
  const w = worker();
  for (const url of [binding, `${binding}?v=`, `${binding}?v=a&x=1`, `${binding}?v=a&v=b`,
    `${binding}?v=%61`, `${binding}?v=${'a'.repeat(65)}`, `${origin}/guides/other.mp4?v=a`,
    `https://other.example/guides/kook-steam-binding.mp4?v=a`, `${videoUrl}#fragment`, `${binding}?v=a&`,
  ]) assert.equal(w.request(url), undefined, url);
  assert.equal(w.request(videoUrl, {}, 'HEAD'), undefined);
  assert.equal(w.request(videoUrl, {}, 'POST'), undefined);
  assert.equal(w.warm('/guides/other.mp4?v=a').waitCount, 0);
  assert.equal(w.dispatch('message', { origin: 'https://other.example', data: { type: 'CACHE_TUTORIAL', url: videoUrl } }).waitCount, 0);
  assert.equal(w.calls.length, 0);
  await w.request(videoUrl);
  await w.request(`${friends}?v=tutorial-hq-2`);
  assert.equal(w.calls.length, 2);
});

test('warming and concurrent playback share one full credential-free download', async () => {
  const gate = deferred();
  const w = worker(() => gate.promise);
  const warmed = w.warm('/guides/kook-steam-binding.mp4?v=binding-hq-2');
  const first = w.request(videoUrl, { Range: 'bytes=0-3' });
  const second = w.request(videoUrl, { Range: 'bytes=-4' });
  assert.equal(warmed.waitCount, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(w.calls.length, 1);
  assert.equal(w.calls[0].headers.has('Range'), false);
  assert.equal(w.calls[0].credentials, 'omit');
  assert.equal(w.calls[0].redirect, 'error');
  gate.resolve(video());
  const [a, b] = await Promise.all([first, second, warmed.done]);
  assert.equal(a.status, 206); assert.deepEqual(await body(a), mp4().slice(0, 4));
  assert.equal(b.status, 206); assert.deepEqual(await body(b), mp4().slice(-4));
  assert.equal(w.state.puts, 1);
});

test('a fresh worker serves persisted full and single-range responses entirely offline', async () => {
  const store = storage(); const first = worker(undefined, store);
  await first.warm().done;
  const w = worker(() => { throw Error('Offline'); }, store);
  const cases = [
    ['bytes=0-', 0, 63], ['bytes=0-0', 0, 0], ['bytes=12-24', 12, 24], ['bytes=60-', 60, 63],
    ['bytes=-5', 59, 63], ['bytes=-999999999999999999999999', 0, 63],
    ['bytes=60-999999999999999999999999', 60, 63],
  ];
  for (const [range, start, end] of cases) {
    const response = await w.request(videoUrl, { Range: range });
    assert.equal(response.status, 206, range);
    assert.equal(response.headers.get('Content-Range'), `bytes ${start}-${end}/64`);
    assert.equal(response.headers.get('Content-Length'), String(end - start + 1));
    assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
    assert.equal(response.headers.get('X-RSG-Tutorial-Cache'), 'hit');
    assert.deepEqual(await body(response), mp4().slice(start, end + 1));
  }
  const full = await w.request(); assert.equal(full.status, 200); assert.deepEqual(await body(full), mp4());
  assert.equal(w.calls.length, 0);
});

test('unsatisfiable or malformed single ranges return empty 416 with resource size', async () => {
  const w = worker(); await w.warm().done;
  for (const range of ['bytes=64-', 'bytes=100-200', 'bytes=9999999999999999999999-', 'bytes=20-10', 'bytes=-0', 'bytes=-', 'bytes=abc-5']) {
    const response = await w.request(videoUrl, { Range: range });
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('Content-Range'), 'bytes */64');
    assert.equal(response.headers.get('Content-Length'), '0');
    assert.equal((await body(response)).length, 0);
  }
  assert.equal(w.calls.length, 1);
});

test('unsupported multipart/unit ranges and stale If-Range validators safely return full 200', async () => {
  const w = worker(); await w.warm().done;
  for (const headers of [
    { Range: 'bytes=0-1,4-5' }, { Range: 'items=0-1' },
    { Range: 'bytes=0-1', 'If-Range': '"stale"' }, { Range: 'bytes=0-1', 'If-Range': 'W/"tutorial-2"' },
    { Range: 'bytes=0-1', 'If-Range': 'Sun, 27 Sep 2026 12:00:00 GMT' },
  ]) {
    const response = await w.request(videoUrl, headers); assert.equal(response.status, 200); assert.deepEqual(await body(response), mp4());
  }
  for (const condition of ['"tutorial-2"', 'Mon, 28 Sep 2026 12:00:00 GMT']) {
    const response = await w.request(videoUrl, { Range: 'bytes=0-1', 'If-Range': condition });
    assert.equal(response.status, 206); assert.deepEqual(await body(response), mp4().slice(0, 2));
  }
});

test('disabled cache, read errors, and quota errors preserve playback without a second fetch', async () => {
  for (const issue of ['openError', 'matchError', 'putError']) {
    const w = worker(); w.state[issue] = true;
    const response = await w.request(videoUrl, { Range: 'bytes=12-20' });
    assert.equal(response.status, 206, issue);
    assert.equal(response.headers.get('X-RSG-Tutorial-Cache'), 'network');
    assert.deepEqual(await body(response), mp4().slice(12, 21));
    assert.equal(w.calls.length, 1, issue);
  }
});

test('only two cache entries remain across version updates; unrelated caches are intact', async () => {
  const w = worker(); const unrelated = new Map([['shell', 'kept']]); w.buckets.set('app-cache', unrelated);
  await w.warm().done; await w.warm(`${friends}?v=tutorial-hq-2`).done;
  await w.warm(`${binding}?v=binding-hq-3`).done;
  await w.warm(`${friends}?v=tutorial-hq-3`).done;
  const entries = w.buckets.get(cacheName);
  assert.equal(entries.size, 2); assert.equal(w.state.maxEntries, 2);
  assert.equal(entries.get(binding).headers.get(versionHeader), 'binding-hq-3');
  assert.equal(entries.get(friends).headers.get(versionHeader), 'tutorial-hq-3');
  assert.equal(w.buckets.get('app-cache'), unrelated);
  assert.equal(w.calls.length, 4);
});

test('an older slow download cannot overwrite a newer completed version', async () => {
  const old = deferred(), recent = deferred();
  const w = worker(request => request.url.endsWith('-2') ? old.promise : recent.promise);
  const oldWarm = w.warm(); const recentWarm = w.warm(`${binding}?v=binding-hq-3`);
  recent.resolve(video()); await recentWarm.done;
  old.resolve(video()); await oldWarm.done;
  assert.equal(w.buckets.get(cacheName).get(binding).headers.get(versionHeader), 'binding-hq-3');
  assert.equal(w.state.puts, 1);
});

test('failed new-version writes preserve the last usable version', async () => {
  const w = worker(); await w.warm().done; w.state.putError = true;
  const response = await w.request(`${binding}?v=binding-hq-3`, { Range: 'bytes=0-3' });
  assert.equal(response.status, 206); assert.deepEqual(await body(response), mp4().slice(0, 4));
  assert.equal(w.buckets.get(cacheName).get(binding).headers.get(versionHeader), 'binding-hq-2');
  assert.equal(w.calls.length, 2);
});

test('error pages, partial responses, incomplete bodies, invalid MIME and oversized files are not stored', async () => {
  const cases = [
    () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/html', 'Content-Length': '9' } }),
    () => video(mp4(), { status: 206 }),
    () => video(mp4(), { headers: { 'Content-Type': 'text/html' } }),
    () => video(mp4(), { headers: { 'Content-Range': 'bytes 0-63/128' } }),
    () => video(mp4(), { headers: { 'Content-Length': '65' } }),
    () => video(mp4(), { headers: { 'Content-Length': '63' } }),
    () => video(mp4(), { headers: { 'Content-Length': String(16 * 1024 * 1024 + 1) } }),
    () => video(mp4(), { headers: { 'Content-Encoding': 'gzip' } }),
    () => video(new Uint8Array(64)),
    () => new Response(mp4(), { headers: { 'Content-Type': 'video/mp4' } }),
  ];
  for (const response of cases) {
    const w = worker(response); await w.warm().done;
    assert.equal(w.state.puts, 0); assert.equal(w.buckets.get(cacheName).size, 0); assert.equal(w.calls.length, 1);
  }
});

test('16 MiB files are accepted, and smaller chunked transport with exact length is fully consumed', async () => {
  const bytes = mp4(16 * 1024 * 1024); const w = worker(() => video(bytes));
  await w.warm().done;
  assert.equal(w.state.puts, 1);
  const cached = await w.request(videoUrl, { Range: 'bytes=-4' });
  assert.deepEqual(await body(cached), bytes.slice(-4));
  const small = mp4();
  const chunked = worker(() => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(small.slice(0, 17)); controller.enqueue(small.slice(17)); controller.close();
  } }), { headers: { 'Content-Type': 'video/mp4; codecs="avc1"', 'Content-Length': '64' } }));
  await chunked.warm().done; assert.equal(chunked.state.puts, 1);
});

test('prefetch network/stream failure is contained without automatic retries and allows an explicit later retry', async () => {
  const w = worker(() => { throw Error('Offline'); });
  await w.warm().done;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(w.calls.length, 1);
  await w.warm().done; assert.equal(w.calls.length, 2);
  const broken = worker(() => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(mp4().slice(0, 20)); controller.error(Error('Connection interrupted'));
  } }), { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '64' } }));
  await broken.warm().done;
  assert.equal(broken.state.puts, 0); assert.equal(broken.calls.length, 1);
});

for (const name of ['add-steam-friend-en', 'kook-steam-binding-en', 'discord-steam-binding']) test(`${name} is cached once and plays ranges offline`, async () => {
  const url = `${origin}/guides/${name}.mp4?v=en-hq-1`;
  const store = storage(), first = worker(undefined, store);
  await first.warm(url).done;
  assert.equal(first.calls.length, 1);
  const offline = worker(() => { throw Error('offline'); }, store);
  const response = await offline.request(url, { Range: 'bytes=0-15' });
  assert.equal(response.status, 206);
  assert.equal((await body(response)).length, 16);
  assert.equal(offline.calls.length, 0);
});
