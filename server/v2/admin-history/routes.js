import express from 'express';
import { randomUUID } from 'node:crypto';
import { IdentityError } from '../identity/errors.js';
import { AdminHistoryService } from './service.js';

/** Mount at /api/v2 after the G03 identity middleware. No background tasks or migrations. */
export function createAdminHistoryRouter() {
  const router = express.Router(), services = new WeakMap();
  router.get('/wipes/:id/history', async (req, res) => {
    req.v2RequestId ||= randomUUID();
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    try {
      const runtime = req.v2Identity;
      if (!runtime?.service || typeof runtime.authenticate !== 'function') throw new IdentityError('AUTH_REQUIRED', 401);
      const { actor } = await runtime.authenticate();
      let service = services.get(runtime.service);
      if (!service) { service = new AdminHistoryService(runtime.service); services.set(runtime.service, service); }
      const data = service.list(actor, req.params.id, req.query);
      res.json({ data, meta: { schemaVersion: 1, requestId: req.v2RequestId,
        serverTime: new Date(service.now()).toISOString(), scopeVersion: actor.permissionVersion } });
    } catch (error) {
      const known = error instanceof IdentityError;
      res.status(known ? error.status : 503).json({ error: { errorCode: known ? error.errorCode : 'ADMIN_HISTORY_UNAVAILABLE',
        messageKey: known ? error.errorCode : 'ADMIN_HISTORY_UNAVAILABLE', fieldErrors: {}, requestId: req.v2RequestId,
        retryable: known ? error.retryable : true } });
    }
  });
  return router;
}
