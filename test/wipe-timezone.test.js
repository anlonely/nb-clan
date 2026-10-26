import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

test('web wipe create stores browser-local input as UTC ISO with source time zone', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-wipe-timezone-'));
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NODE_ENV = 'production';
  delete process.env.NB_COOKIE_SECURE;

  let apiServer = null;
  try {
    const { createApiRouter } = await import('../server/api.js');
    const { ensureStore, readStore } = await import('../server/store.js');
    await ensureStore();

    const app = express();
    app.use('/api', createApiRouter());
    apiServer = createServer(app);
    await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${apiServer.address().port}/api`;
    let cookie = '';

    async function request(url, options = {}) {
      const response = await fetch(`${baseUrl}${url}`, {
        method: options.method || 'GET',
        headers: {
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {})
        },
        body: options.body ? JSON.stringify(options.body) : undefined
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const payload = await response.json();
      return { response, payload };
    }

    let result = await request('/auth/login', {
      method: 'POST',
      body: { username: 'root', password: 'RootPass123!' }
    });
    assert.equal(result.response.status, 200);

    result = await request('/wipes', {
      method: 'POST',
      body: {
        serverName: 'Timezone Server',
        startedAt: '2026-06-22T12:00:00.000Z',
        nextWipeAt: '2026-06-29T12:00:00.000Z',
        timeZone: 'Asia/Shanghai'
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.wipe.startedAt, '2026-06-22T12:00:00.000Z');
    assert.equal(result.payload.wipe.startedAtTimeZone, 'Asia/Shanghai');
    assert.equal(result.payload.wipe.nextWipeAt, '2026-06-29T12:00:00.000Z');
    assert.equal(result.payload.wipe.nextWipeAtTimeZone, 'Asia/Shanghai');

    const store = await readStore();
    const wipe = store.wipes.find((item) => item.id === result.payload.wipe.id);
    assert.equal(wipe.startedAt, '2026-06-22T12:00:00.000Z');
    assert.equal(wipe.nextWipeAt, '2026-06-29T12:00:00.000Z');
  } finally {
    if (apiServer) await new Promise((resolve) => apiServer.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
