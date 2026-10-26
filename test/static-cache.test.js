import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { request } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setStaticCacheHeaders } from '../server/static-cache.js';

const immutable = 'public, max-age=31536000, immutable';
const files = {
  'guides/kook-steam-binding.mp4': 'binding-hq-2',
  'guides/kook-steam-binding-poster.jpg': 'binding-hq-2',
  'guides/add-steam-friend.mp4': 'tutorial-hq-2',
  'guides/add-steam-friend-poster.jpg': 'tutorial-hq-2',
};

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'nb-static-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(['guides', 'assets'].map(folder => mkdir(path.join(root, folder))));
  for (const file of [...Object.keys(files), 'guides/other.mp4', 'guides/kook-steam-binding.html',
    'guides/tutorial-video.js', 'guides/tutorial-cache-sw.js', 'guides/tutorial-media-sw.js', 'guides/electricians.css', 'index.html', 'loading-cache-sw.js', 'assets/app-hash.js']) {
    await writeFile(path.join(root, file), '0123456789-static-fixture');
  }
  const app = express();
  app.use(express.static(root, { setHeaders(res, filePath) {
    setStaticCacheHeaders(res, path.relative(root, filePath).split(path.sep).join('/'), res.req.originalUrl);
  } }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return (url, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path: url, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject); req.end();
  });
}

test('versioned tutorial media retain immutable headers on HEAD, Range and conditional 304', async t => {
  const get = await fixture(t);
  for (const [file, version] of Object.entries(files)) {
    const url = `/${file}?v=${version}`;
    const head = await get(url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers['cache-control'], immutable);
    assert.equal(head.headers['accept-ranges'], 'bytes');
    const range = await get(url, { headers: { Range: 'bytes=0-3' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers['cache-control'], immutable);
    assert.equal(range.headers['content-range'], 'bytes 0-3/25');
    assert.equal(range.body.toString(), '0123');
    const conditional = await get(url, { headers: { 'If-None-Match': head.headers.etag } });
    assert.equal(conditional.status, 304);
    assert.equal(conditional.headers['cache-control'], immutable);
    assert.equal(conditional.body.length, 0);
  }
  const next = await get('/guides/kook-steam-binding.mp4?v=binding-hq-3');
  assert.equal(next.status, 200);
  assert.equal(next.headers['cache-control'], immutable);
});

test('unversioned, ambiguous and unrelated files stay out of the immutable tutorial allowlist', async t => {
  const get = await fixture(t);
  for (const query of ['', '?v=binding-hq-0', '?v=binding-hq-02', '?v=binding-hq-1234567',
    '?v=tutorial-hq-2', '?v=binding-hq-2&v=binding-hq-3', '?v=binding-hq-2&extra=1',
    '?extra=1&v=binding-hq-2', '?v=binding-hq-2&', '?%76=binding-hq-2', '?v=binding-hq-2%0A']) {
    const result = await get(`/guides/kook-steam-binding.mp4${query}`);
    assert.equal(result.status, 200);
    assert.equal(result.headers['cache-control'], 'public, max-age=0', query);
  }
  const other = await get('/guides/other.mp4?v=binding-hq-2');
  assert.equal(other.headers['cache-control'], 'public, max-age=0');
});

test('guide entry points revalidate while existing assets and app entry policies remain intact', async t => {
  const get = await fixture(t);
  for (const file of ['guides/kook-steam-binding.html', 'guides/tutorial-video.js', 'guides/tutorial-cache-sw.js',
    'guides/electricians.css', 'index.html', 'loading-cache-sw.js']) {
    const result = await get(`/${file}?v=binding-hq-2`);
    assert.equal(result.headers['cache-control'], 'no-cache', file);
    assert.equal(result.headers['cdn-cache-control'], undefined, file);
    assert.equal(result.headers['cloudflare-cdn-cache-control'], undefined, file);
  }
  assert.equal((await get('/assets/app-hash.js')).headers['cache-control'], immutable);
});

test('tutorial worker disallows browser and CDN storage with or without a version', async t => {
  const get = await fixture(t);
  for (const url of ['/guides/tutorial-media-sw.js', '/guides/tutorial-media-sw.js?v=media-cache-2']) {
    for (const method of ['GET', 'HEAD']) {
      const result = await get(url, { method });
      assert.equal(result.status, 200);
      for (const name of ['cache-control', 'cdn-cache-control', 'cloudflare-cdn-cache-control']) {
        assert.equal(result.headers[name], 'no-store', `${method} ${url} ${name}`);
      }
    }
  }
});
