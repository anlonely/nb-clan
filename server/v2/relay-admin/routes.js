import express from 'express';
import { randomUUID } from 'node:crypto';
import { need, fields, safeError } from './model.js';
export function createRelayAdminRouter({ service } = {}) {
  need(service?.identity, 'RELAY_ADMIN_HOST_REQUIRED', 503); const router = express.Router(), base = '/relay-admin';
  const wrap = fn => (req, res, next) => Promise.resolve().then(() => { need(req.v2Identity?.service === service.identity, 'IDENTITY_CONTEXT_REQUIRED', 503); res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); return fn(req, res); }).catch(next);
  const send = (req, res, data) => res.json({ data, meta: { schemaVersion: 1, requestId: req.v2RequestId || randomUUID() } });
  router.get(base, wrap(async (req, res) => { const { actor } = await req.v2Identity.authenticate(); send(req, res, service.read(actor)); }));
  router.get(base + '/web-api', wrap(async (req, res) => { const { actor } = await req.v2Identity.authenticate(); send(req, res, service.webApi.read(actor)); }));
  router.get(base + '/web-api/operations/:id', wrap(async (req, res) => { const { actor } = await req.v2Identity.authenticate(); send(req, res, service.webApi.getOperation(actor, req.params.id)); }));
  for (const action of ['servers', 'config']) router.post(base + '/web-api/' + action, express.json({ limit: '16kb' }), wrap(async (req, res) => {
    const authenticate = () => req.v2Identity.authenticate({ mutation: true });
    const { actor } = await authenticate(); fields(req.body, ['input']);
    need(Buffer.byteLength(JSON.stringify(req.body)) <= 16384, 'PAYLOAD_TOO_LARGE', 413);
    send(req, res, action === 'servers' ? await service.webApi.servers(actor, req.body.input, { authenticate }) :
      await service.webApi.save(actor, req.body.input, req.get('Idempotency-Key'), { authenticate }));
  }));
  router.get(base + '/operations/:id', wrap(async (req, res) => { const { actor } = await req.v2Identity.authenticate(); send(req, res, service.getOperation(actor, req.params.id)); }));
  router.post(base + '/commands/:action', express.json({ limit: '4kb' }), wrap(async (req, res) => {
    const { actor } = await req.v2Identity.authenticate({ mutation: true }); fields(req.body, ['input']); need(Buffer.byteLength(JSON.stringify(req.body)) <= 4096, 'PAYLOAD_TOO_LARGE', 413);
    send(req, res, await service.command(actor, req.params.action, req.body.input, req.get('Idempotency-Key'), { authenticate: () => req.v2Identity.authenticate({ mutation: true }) }));
  }));
  router.post(base + '/operations/:id/recover', wrap(async (req, res) => { const { actor } = await req.v2Identity.authenticate({ mutation: true }); need(req.get('Idempotency-Key') === req.params.id, 'OPERATION_ID_REQUIRED'); send(req, res, await service.recover(actor, req.params.id, { authenticate: () => req.v2Identity.authenticate({ mutation: true }) })); }));
  router.use(base, (error, req, res, next) => {
    if (!error) return next(); const e = safeError(error), status = error.type === 'entity.too.large' ? 413 : error.type === 'entity.parse.failed' ? 400 : e.status;
    res.status(status).set('Cache-Control', 'no-store').json({ error: { errorCode: e.errorCode, messageKey: `relayAdmin.${e.errorCode}`, retryable: status >= 500 } });
  });
  return router;
}
