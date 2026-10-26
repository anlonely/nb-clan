import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { wechatRetirementGuard } from '../server/wechat-retirement.js';

test('retired review cannot be reached and mini tokens cannot reach fallback management', async t => {
  const app = express(); app.use('/api', wechatRetirementGuard); app.use((req, res) => res.json({ reached: true }));
  const server = createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  for (const path of ['/wechat/join-applications', '/wechat/join-applications/me', '/wechat/admin/join-applications/a/review', '/wechat/admin/member-bind-requests']) {
    const response = await fetch(base + path, { method: 'POST' });
    assert.equal(response.status, 410, path);
  }
  assert.equal((await fetch(base + '/wechat/admin/wipes', { headers: { Authorization: 'Bearer old-mini-token' } })).status, 410);
  assert.equal((await fetch(base + '/wechat/admin/wipes', { headers: { 'x-nb-wechat-session': 'legacy-mini-token' } })).status, 410);
  assert.equal((await fetch(base + '/wechat/admin/wipes', { headers: { Cookie: 'browser=session' } })).status, 200);
  assert.equal((await fetch(base + '/v2/mini-program/login', { method: 'POST' })).status, 200);
});
