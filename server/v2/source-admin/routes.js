import express from 'express';
import { randomUUID } from 'node:crypto';
import { need, SourceAdminError, fields } from './model.js';
export function createSourceAdminRouter({ service }) {
  need(service?.identity, 'SOURCE_ADMIN_HOST_REQUIRED', 503);
  const router = express.Router(), base = '/source-admin';
  const wrap = fn => (req, res, next) => Promise.resolve().then(() => {
    need(req.v2Identity?.service === service.identity, 'IDENTITY_CONTEXT_REQUIRED', 503);
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); return fn(req, res);
  }).catch(next);
  const send = (req, res, data) => res.json({ data, meta: { schemaVersion: 1, requestId: req.v2RequestId || randomUUID() } });
  router.get(base, wrap(async (req, res) => { const { actor } = await req.v2Identity.authenticate(); send(req, res, service.read(actor)); }));
  router.get(base + '/sources/:source', wrap(async (req, res) => { const { actor } = await req.v2Identity.authenticate(); send(req, res, service.read(actor, req.params.source)); }));
  router.get(base + '/operations/:id', wrap(async (req, res) => { const { actor } = await req.v2Identity.authenticate(); send(req, res, service.getOperation(actor, req.params.id)); }));
  router.post(base + '/commands/:action', express.json({ limit: '12kb' }), wrap(async (req, res) => {
    const { actor } = await req.v2Identity.authenticate({ mutation: true }); fields(req.body, ['input']);
    send(req, res, await service.command(actor, req.params.action, req.body.input, req.get('Idempotency-Key'), { authenticate: () => req.v2Identity.authenticate({ mutation: true }) }));
  }));
  router.post(base + '/operations/:id/recover', wrap(async (req, res) => {
    const { actor } = await req.v2Identity.authenticate({ mutation: true });
    need(req.get('Idempotency-Key') === req.params.id, 'OPERATION_ID_REQUIRED');
    send(req, res, await service.recover(actor, req.params.id, { authenticate: () => req.v2Identity.authenticate({ mutation: true }) }));
  }));
  router.use(base, (error, req, res, next) => {
    if (!error) return next();
    const known = error instanceof SourceAdminError || typeof error?.errorCode === 'string';
    const code = known && /^[A-Z_]{1,80}$/.test(error.errorCode) ? error.errorCode : 'SOURCE_ADMIN_UNAVAILABLE';
    const status = known ? error.status || 503 : error.type === 'entity.too.large' ? 413 : error.type === 'entity.parse.failed' ? 400 : 503;
    res.status(status).set('Cache-Control', 'no-store').json({ error: { errorCode: code, messageKey: `sourceAdmin.${code}`, retryable: status >= 500 } });
  });
  return router;
}
