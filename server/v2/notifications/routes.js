import express from 'express';
import { randomUUID } from 'node:crypto';
import { IdentityError } from '../identity/errors.js';

export function createNotificationRouter({ getSystem }) {
  if (typeof getSystem !== 'function') throw new TypeError('Notification getSystem is required');
  const router = express.Router();
  const wrap = (fn, status = 200) => async (req, res) => {
    const requestId = req.v2RequestId || randomUUID();
    res.set('Cache-Control', 'no-store');
    try {
      if (typeof req.v2Identity?.authenticate !== 'function') throw new IdentityError('AUTH_REQUIRED', 401);
      const { actor } = await req.v2Identity.authenticate(req.method === 'GET' || req.method === 'HEAD' ? undefined : { mutation: true });
      if (!actor) throw new IdentityError('AUTH_REQUIRED', 401);
      const system = await getSystem(req);
      if (!system?.service) throw new IdentityError('NOTIFICATION_SETUP_REQUIRED', 503);
      const data = await fn(system.service, actor, req, { operationId: req.get('Idempotency-Key') });
      res.status(status).json({ data, meta: { schemaVersion: 1, requestId,
        serverTime: new Date(typeof system.service.now === 'function' ? system.service.now() : Date.now()).toISOString(),
        scopeVersion: actor.permissionVersion } });
    } catch (error) {
      const known = error instanceof IdentityError;
      const errorCode = known ? error.errorCode : 'NOTIFICATION_SETUP_REQUIRED';
      res.status(known ? error.status : 503).json({ error: {
        errorCode, messageKey: errorCode, fieldErrors: known ? error.fieldErrors || {} : {}, requestId,
        operationId: req.get('Idempotency-Key') || null, retryable: known ? Boolean(error.retryable) : true,
        current: known ? error.current ?? null : null
      } });
    }
  };

  router.get('/admin/wipes', wrap((service, actor, req) => service.listAdminWipes(actor, req.query)));
  router.get('/admin/wipe-options', wrap(async (service, actor, req) => {
    if (req.query.kind === 'servers' && service.catalog?.prepareOptions) {
      await service.listWipeOptions(actor, req.query);
      await service.catalog.prepareOptions('servers');
    }
    return service.listWipeOptions(actor, req.query);
  }));
  router.get('/wipes/:id/notification-options', wrap((service, actor, req) => service.getOptions(actor, req.params.id)));
  router.post('/wipes/:id/notification-previews', wrap((service, actor, req, options) => service.createPreview(actor, req.params.id, req.body, options), 201));
  router.post('/wipes/:id/publish-intents', wrap((service, actor, req, options) => service.createIntent(actor, req.params.id, req.body, options), 202));
  router.get('/wipes/:id/publish-intents', wrap((service, actor, req) => service.listIntents(actor, req.params.id, req.query)));
  router.get('/reviews/:id/notification-intents', wrap((service, actor, req) => service.listReviewIntents(actor, req.params.id, req.query)));
  router.get('/publish-intents/:id', wrap((service, actor, req) => service.getIntent(actor, req.params.id, req.query)));
  router.get('/deliveries/:id', wrap((service, actor, req) => service.getDelivery(actor, req.params.id)));
  router.post('/publish-intents/:id/retry-failed', wrap((service, actor, req, options) => service.retryFailed(actor, req.params.id, req.body, options)));
  for (const command of ['retry', 'cancel', 'reconcile']) {
    router.post(`/deliveries/:id/commands/${command}`, wrap((service, actor, req, options) =>
      service.commandDelivery(actor, req.params.id, command, req.body, options)));
  }
  router.post('/message-operations/:id/commands/reconcile',wrap((service,actor,req,options)=>service.reconcileEditOperation(actor,req.params.id,req.body,options)));
  router.get('/notifications/operations/:operationId', wrap((service, actor, req) => service.getOperation(actor, req.params.operationId)));
  return router;
}
