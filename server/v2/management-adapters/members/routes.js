import express from 'express';
import { randomUUID } from 'node:crypto';
import { IdentityError } from '../../identity/errors.js';
import { requireValue as need } from '../../member-admin/repository.js';

// Read-only observation; no session creation, migration, queue or platform I/O.
export function createMemberAdapterObservationRouter({ getRuntime }) {
  const router = express.Router();
  router.get('/member-adapters/members/:id/unlink-observation', async (req, res) => {
    const requestId = req.v2RequestId || randomUUID();
    res.set('Cache-Control', 'no-store');
    try {
      need(req.v2Identity?.authenticate, 'AUTH_REQUIRED', 401);
      const { actor } = await req.v2Identity.authenticate();
      const runtime = getRuntime(req.v2Identity.service);
      need(runtime?.identity === req.v2Identity.service, 'MEMBER_RUNTIME_IDENTITY_MISMATCH', 503);
      const data = runtime.lifecycle.observeUnlink(actor, req.params.id, req.query.provider);
      res.json({ data, meta: { schemaVersion: 1, requestId, scopeVersion: actor.permissionVersion,
        serverTime: new Date(runtime.identity.now()).toISOString() } });
    } catch (e) {
      const known = e instanceof IdentityError;
      res.status(known ? e.status : 503).json({ error: { errorCode: known ? e.errorCode : 'MEMBER_ADAPTER_UNAVAILABLE',
        messageKey: known ? e.errorCode : 'MEMBER_ADAPTER_UNAVAILABLE', requestId, retryable: known ? e.retryable : true } });
    }
  });
  return router;
}
