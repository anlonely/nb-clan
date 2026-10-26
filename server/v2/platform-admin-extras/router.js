import express from 'express';
import { need } from './model.js';
// Mount under an authenticated V2 namespace; authenticate is the host's session authority.
export function createPlatformAdminExtrasRouter({ service, authenticate }) {
  need(service && typeof authenticate === 'function', 'AUTHENTICATOR_REQUIRED', 503);
  const router = express.Router(); router.use(express.json({ limit: '16kb' }));
  const route = fn => async (req, res, next) => { try {
    const actor = await authenticate(req); need(actor?.id, 'AUTH_REQUIRED', 401);
    res.json(await fn(req, actor));
  } catch (error) { next(error); } };
  router.get('/summary', route((req, actor) => service.summary(actor, req.query)));
  router.get('/servers', route((req, actor) => service.servers(actor)));
  router.put('/servers/:serverProfileId', route((req, actor) => {
    need(!req.body?.serverProfileId || req.body.serverProfileId === req.params.serverProfileId, 'SERVER_PROFILE_MISMATCH');
    return service.saveServer(actor, { ...req.body, serverProfileId: req.params.serverProfileId }, req.get('Idempotency-Key'),
      { assertCurrent: () => { const current = authenticate(req); need(!current?.then, 'SYNCHRONOUS_REAUTH_REQUIRED', 503); return current; } });
  }));
  return router;
}
