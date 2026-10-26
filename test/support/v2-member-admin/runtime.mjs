import '../v2-baseline/loopback-only.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import net from 'node:net';
import express from 'express';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { fixture } from './fixtures.mjs';
import { createIdentityRouter } from '../../../server/v2/identity/routes.js';
import { createMemberAdminRouter } from '../../../server/v2/member-admin/routes.js';
import { createMemberAdminWriteAdapter } from '../../../server/v2/member-admin/adapters.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'),
  runDir = process.env.G07_MEMBERS_RUN;
assert.ok(runDir.startsWith(path.join(root, 'test/support/v2-member-admin/.runs/run-')));
assert.equal(process.env.NB_DISABLE_BACKGROUND_JOBS, '1');
const allowed = ['PATH', 'LANG', 'TZ', 'NODE_ENV', 'NB_DATA_DIR', 'NB_SQLITE_FILE', 'NB_STORAGE_MODE', 'NB_DISABLE_BACKGROUND_JOBS', 'NB_DISABLE_EXTERNAL_VITAL', 'NB_DISABLE_EXTERNAL_ATLAS', 'NB_V2_IDENTITY_ENABLED', 'NODE_OPTIONS', 'G07_MEMBERS_RUN', 'G07_MEMBERS_MODE', '__CF_USER_TEXT_ENCODING'];
assert.deepEqual(Object.keys(process.env).filter(k => !allowed.includes(k)), []);
assert.throws(() => net.connect({
  host: 'example.com',
  port: 443
}), e => e.code === 'G01_EGRESS_BLOCKED');
await mkdir(process.env.NB_DATA_DIR, {
  recursive: true
});
const f = fixture(process.env.NB_SQLITE_FILE),
  app = express(),
  server = createServer(app);
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const irouter = createIdentityRouter({
  service: f.identity,
  origin,
  providers: {}
});
let queue = Promise.resolve(),
  cache = {},
  cachePatches = 0;
for (const collection of ['members', 'squads', 'squadMembers', 'joinApplications', 'wechatUsers']) cache[collection] = f.service.repo.all(collection);
const writeDomain = createMemberAdminWriteAdapter({
  runStoreWriteTask: fn => {
    const next = queue.then(fn);
    queue = next.catch(() => {});
    return next;
  },
  patchStoreCache: fn => {
    cachePatches++;
    fn(cache);
  }
});
app.disable('x-powered-by');
app.use((req, res, next) => {
  if (req.get('host') !== new URL(origin).host || req.socket.remoteAddress !== '127.0.0.1') return res.sendStatus(400);
  next();
});
app.post('/__fixture/login', express.json({
  limit: '1kb'
}), (req, res) => {
  if (req.get('origin') !== origin) return res.sendStatus(403);
  const account = f.ir.get('accounts', req.body.account);
  if (!account) return res.sendStatus(403);
  const session = f.identity.issueSession(account);
  res.cookie('nb_v2_session', session.token, {
    path: '/api/v2',
    httpOnly: true,
    sameSite: 'strict'
  });
  res.cookie('nb_v2_csrf', session.csrfToken, {
    path: '/api/v2',
    httpOnly: true,
    sameSite: 'strict'
  });
  res.json({
    isolated: true
  });
});
app.use('/api/v2', (req, res, next) => {
  req.v2Identity = {
    service: f.identity,
    authenticate: options => irouter.authenticate(options)(req)
  };
  irouter(req, res, next);
});
app.use('/api/v2', createMemberAdminRouter({
  writeDomain,
  adapters: f.adapters
}));
app.use('/api', (req, res) => res.status(404).json({
  error: {
    errorCode: 'NOT_FOUND'
  }
}));
app.use((err, req, res, next) => res.status(err.status || 503).json({
  error: {
    errorCode: err.errorCode || 'UNAVAILABLE'
  }
}));
const outDir = path.join(runDir, 'dist');
await build({
  root,
  configFile: false,
  envFile: false,
  envDir: runDir,
  plugins: [react()],
  build: {
    outDir,
    emptyOutDir: false,
    rollupOptions: {
      input: path.join(root, 'test/support/v2-member-admin/index.html')
    }
  }
});
app.use('/assets', express.static(path.join(outDir, 'assets')));
const html = await readFile(path.join(outDir, 'test/support/v2-member-admin/index.html'), 'utf8');
app.use((req, res) => res.type('html').send(html));
await writeFile(path.join(runDir, 'runtime.json'), JSON.stringify({
  origin,
  runDir,
  db: process.env.NB_SQLITE_FILE,
  pid: process.pid,
  node: process.version,
  externalRequests: 'blocked by loopback guard',
  backgroundJobs: 'not imported',
  fixtureAccounts: ['admin', 'root', 'leader', 'member', 'viewer'],
  sharedEntryModified: false
}, null, 2));
console.log(JSON.stringify({
  ready: true,
  origin,
  runDir
}));
const stop = async () => {
  await irouter.stopEvents();
  await new Promise(r => server.close(r));
  f.db.close();
};
process.on('SIGTERM', () => stop().then(() => process.exit()));
process.on('SIGINT', () => stop().then(() => process.exit()));
if (process.env.G07_MEMBERS_MODE === 'verify') {
  try {
    const {
      verify
    } = await import('./verify.mjs');
    await verify({
      origin,
      runDir,
      f,
      cache,
      getCachePatches: () => cachePatches
    });
  } finally {
    await stop();
  }
}
