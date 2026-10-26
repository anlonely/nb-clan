import { fixtureSessionFactory } from '../authenticated-session.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import express from 'express';
import { fixture as baseFixture } from '../v2-system-admin/fixtures.mjs';
import { createIdentityRouter } from '../../../server/v2/identity/routes.js';
import { createSourceAdmin, createSourceAdminRouter, installSourceAdminSchema } from '../../../server/v2/source-admin/index.js';
export async function fixture(options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'g07-source-admin-')), base = await baseFixture(dir);
  installSourceAdminSchema(base.db, { apply: true }); const hooks = {}, cache = { settings: {} }; let patches = 0;
  const service = createSourceAdmin({ identity: base.identity, readRuntimeStatus: options.readRuntimeStatus,
    patchStoreCache: async mutator => { patches++; await hooks.beforeCache?.(); mutator(cache); } });
  service.start();
  const f = { ...base, service, hooks, cache, patches: () => patches,
    revision: (source = 'battlemetrics', actor = 'root') => service.read(base.actor(actor), source).revision,
    async close() { await service.stop(); await base.close(); await rm(dir, { recursive: true, force: true }); } };
  return f;
}
export async function httpFixture() {
  const f = await fixture(), app = express(), server = createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const origin = `http://127.0.0.1:${server.address().port}`;
  const identityRouter = createIdentityRouter({ service: f.identity, contexts: f.contexts, origin, providers: {} });
  app.use('/api/v2', (req, res, next) => { req.v2Identity = { service: f.identity, authenticate: opts => identityRouter.authenticate(opts)(req) }; identityRouter(req, res, next); });
  app.use('/api/v2', createSourceAdminRouter({ service: f.service }));
  app.use((e, req, res, next) => res.status(e.status || 503).json({ error: { errorCode: e.errorCode || 'UNAVAILABLE' } }));
  const session = await fixtureSessionFactory(f.identity);
  return { ...f, app, origin, session,
    async close() { await identityRouter.stopEvents(); server.closeAllConnections(); await new Promise(r => server.close(r)); await f.close(); } };
}
