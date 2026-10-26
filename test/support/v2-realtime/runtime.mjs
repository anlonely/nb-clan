import '../results.mjs';
import express from 'express';
import { createServer } from 'node:http';
import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { fixture } from './fixture.mjs';
import { createRealtimeRouter } from '../../../server/v2/realtime/routes.js';
import { createIdentityRouter } from '../../../server/v2/identity/routes.js';
import { createMemberSpaceRouter } from '../../../server/v2/member-space/routes.js';
import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';
import { randomBytes } from 'node:crypto';
import { createRealtimeStreamOwner } from '../../../server/v2/realtime/stream.js';
const streamOwner = createRealtimeStreamOwner({
  heartbeatMs: 1000
});
const fixtureKey = randomBytes(24).toString('hex');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'),
  run = process.env.G07_REALTIME_RUN;
assert.ok(run?.startsWith(root + '/test/support/v2-realtime/.runtime/run-'));
assert.deepEqual(Object.keys(process.env).filter(k => !['PATH', 'LANG', 'TZ', 'NODE_ENV', 'NB_DISABLE_BACKGROUND_JOBS', 'NB_DISABLE_EXTERNAL_VITAL', 'NB_DISABLE_EXTERNAL_ATLAS', 'G07_REALTIME_RUN', 'NODE_OPTIONS', '__CF_USER_TEXT_ENCODING'].includes(k)), []);
assert.equal(process.env.NB_DISABLE_BACKGROUND_JOBS, '1');
const dbFile = path.join(run, 'data.sqlite');
await assert.rejects(access(dbFile));
const f = fixture(dbFile),
  app = express(),
  server = createServer(app);
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const identities = createIdentityRouter({
  service: f.identity,
  origin,
  providers: {}
});
let stopped = false;
app.use((req, res, next) => {
  if (req.get('host') !== new URL(origin).host || req.socket.remoteAddress !== '127.0.0.1') return res.sendStatus(403);
  res.set('Cache-Control', 'no-store');
  next();
});
// Constructed account selection issues real G03 session cookies, no external OAuth assertion.
app.get('/__fixture/login/:account', (req, res) => {
  if (!['admin', 'alpha', 'foreign'].includes(req.params.account)) return res.sendStatus(404);
  const account = f.ir.get('accounts', 'g05_account_' + req.params.account),
    session = f.identity.issueSession(account);
  res.cookie('nb_v2_session', session.token, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/api/v2'
  });
  res.cookie('nb_v2_csrf', session.csrfToken, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/api/v2'
  });
  res.redirect('/admin/realtime/info?scope=alpha');
});
app.post('/__fixture/control', express.json({
  limit: '8kb'
}), (req, res) => {
  if (req.get('x-fixture-key') !== fixtureKey) return res.sendStatus(403);
  const {
    action,
    id = 'alpha',
    n = 900
  } = req.body;
  if (action === 'chat') f.chat(id, n);else if (action === 'stale') f.advance(130000);else if (action === 'snapshot') f.seedSnapshot(id);else if (action === 'revoke') f.identity.revokeAccountScope('g05_account_' + id, 'isolated_revoke');else if (action === 'disconnect') {
    streamOwner.stop();
  } else return res.sendStatus(422);
  res.json({
    ok: true
  });
});
app.use('/api/v2', (req, res, next) => {
  req.v2Identity = {
    service: f.identity,
    authenticate: options => identities.authenticate(options)(req)
  };
  next();
});
app.use('/api/v2', identities, createMemberSpaceRouter(), createRealtimeRouter({
  ...f.options,
  streamOwner
}));
app.use('/api', (_req, res) => res.status(404).json({
  error: {
    errorCode: 'ISOLATED_ROUTE_NOT_FOUND'
  }
}));
const dependencyRoot = decodeURIComponent(new URL('../../../node_modules', import.meta.url).pathname);
const vite = await createViteServer({
  root,
  configFile: false,
  envFile: false,
  envDir: false,
  plugins: [react()],
  cacheDir: path.join(run, 'vite-cache'),
  resolve: {
    alias: [{
      find: /^(react(?:-dom)?)(\/.*)?$/,
      replacement: dependencyRoot + '/$1$2'
    }, {
      find: 'lucide-react',
      replacement: dependencyRoot + '/lucide-react/dist/esm/lucide-react.js'
    }]
  },
  server: {
    middlewareMode: true,
    hmr: {
      server
    },
    watch: {
      ignored: ['**/.git/**', '**/output/test-results/**', '**/.runtime/**', '**/work/**', '**/.runtime/**']
    },
    fs: {
      strict: true,
      allow: [root, dependencyRoot],
      deny: ['.env', '.env.*', '**/*.sqlite', '**/*.sqlite-*', '**/.git/**', '**/work/**', '**/.runtime/**']
    }
  },
  appType: 'custom'
});
app.use(vite.middlewares);
app.use(async (req, res, next) => {
  try {
    res.type('html').send(await vite.transformIndexHtml(req.originalUrl, await readFile(path.join(root, 'test/support/v2-realtime/index.html'), 'utf8')));
  } catch (e) {
    next(e);
  }
});
app.use((err, req, res, next) => res.status(err.status || 500).json({
  error: {
    errorCode: err.errorCode || 'RUNTIME_FAILURE'
  }
}));
await writeFile(path.join(run, 'runtime.json'), JSON.stringify({
  origin,
  fixtureKey,
  pid: process.pid,
  root,
  dbFile,
  run,
  environmentKeys: Object.keys(process.env),
  externalCollection: false,
  backgroundLegacyJobs: false,
  adapters: 'controlled fixtures',
  session: 'real G03 cookie/CSRF with constructed account selection'
}, null, 2));
console.log(JSON.stringify({
  ready: true,
  origin,
  run
}));
async function close() {
  stopped = true;
  streamOwner.stop();
  await identities.stopEvents();
  await vite.close();
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  f.db.close();
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, close);
