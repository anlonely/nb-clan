import '../results.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
const runtime = JSON.parse(await readFile(process.argv[2], 'utf8')),
  origin = runtime.origin;
const cases = [];
async function login(key) {
  const r = await fetch(origin + '/__fixture/login/' + key, {
    redirect: 'manual'
  });
  return r.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
}
const admin = await login('admin'),
  member = await login('alpha');
async function request(cookie, path, options = {}) {
  const r = await fetch(origin + path, {
    ...options,
    headers: {
      cookie,
      ...options.headers
    }
  });
  const body = await r.json();
  return {
    status: r.status,
    body,
    cache: r.headers.get('cache-control')
  };
}
let r = await request('', '/api/v2/realtime/alpha/chats');
assert.equal(r.status, 401);
cases.push('unauthenticated 401');
r = await request(member, '/api/v2/realtime/beta/chats');
assert.equal(r.status, 403);
cases.push('cross-squad 403');
r = await request(admin, '/api/v2/realtime/alpha/chats?limit=100000');
assert.equal(r.status, 422);
cases.push('bounded limit 422');
const bootstrap = await request(admin, '/api/v2/bootstrap'),
  csrf = bootstrap.body.data.csrfToken;
const summary = await request(admin, '/api/v2/realtime/alpha/summary');
assert.equal(summary.status, 200);
assert.equal(summary.cache, 'no-store');
assert.equal(summary.body.data.counts.online, 1);
const headers = {
    'Content-Type': 'application/json',
    'Origin': origin,
    'Idempotency-Key': 'http_clear_0000001'
  },
  body = JSON.stringify({
    expectedRevision: summary.body.data.revision,
    reason: '隔离 HTTP 清理'
  });
r = await request(admin, '/api/v2/realtime/alpha/commands/clear-chat', {
  method: 'POST',
  headers,
  body
});
assert.equal(r.status, 403);
cases.push('missing CSRF rejected');
r = await request(member, '/api/v2/realtime/alpha/commands/clear-chat', {
  method: 'POST',
  headers: {
    ...headers,
    'X-CSRF-Token': (await request(member, '/api/v2/bootstrap')).body.data.csrfToken
  },
  body
});
assert.equal(r.status, 403);
cases.push('member management rejected');
const p = (await request(admin, '/api/v2/realtime/alpha/chats')).body.data;
const controller = new AbortController();
const stream = await fetch(origin + '/api/v2/realtime/alpha/stream?after=' + encodeURIComponent(p.tailCursor), {
  headers: {
    cookie: admin
  },
  signal: controller.signal
});
assert.equal(stream.status, 200);
const reader = stream.body.getReader();
await reader.read();
await fetch(origin + '/__fixture/control', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-fixture-key': runtime.fixtureKey
  },
  body: JSON.stringify({
    action: 'chat',
    n: 77777
  })
});
const timer = setTimeout(() => controller.abort(), 5000);
let text = '';
while (!text.includes('77777')) {
  const r = await reader.read();
  if (r.done) break;
  text += new TextDecoder().decode(r.value);
}
clearTimeout(timer);
controller.abort();
assert.ok(text.includes('77777'));
cases.push('real HTTP SSE append');
r = await request(admin, '/api/v2/realtime/alpha/commands/import-member', {
  method: 'POST',
  headers: {
    ...headers,
    'X-CSRF-Token': csrf,
    'Idempotency-Key': 'http_import_000001'
  },
  body: JSON.stringify({
    expectedRevision: summary.body.data.revision,
    steamId: '76561198000000999',
    squadId: 'g05_squad'
  })
});
assert.equal(r.status, 503);
assert.equal(r.body.error.errorCode, 'MEMBERS_ADAPTER_REQUIRED');
cases.push('missing member adapter fails closed');
await writeFile('output/test-results/g07-realtime/http.json', JSON.stringify({
  passed: true,
  cases,
  origin,
  realG03: true,
  externalRequests: false
}, null, 2));
console.log(JSON.stringify({
  passed: true,
  cases
}));
