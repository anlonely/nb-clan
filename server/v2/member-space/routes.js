import express from 'express';
import { randomUUID } from 'node:crypto';
import { IdentityError } from '../identity/errors.js';
import { MemberSpaceService } from './service.js';

function csrfCookie(req) {
  const pair = String(req.get('cookie') || '').split(';').map(value => value.trim()).find(value => value.startsWith('nb_v2_csrf='));
  return pair ? pair.slice('nb_v2_csrf='.length) : null;
}

/** Mount after the G03 exact-origin middleware at /api/v2; use its real cookie authentication and CSRF gate. */
export function createMemberSpaceRouter({ getService } = {}) {
  const router = express.Router(), services = new WeakMap();
  router.use((req, res, next) => {
    req.v2RequestId ||= randomUUID();
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    next();
  });
  const wrap = (fn, image = false) => async (req, res) => {
    try {
      const identity = req.v2Identity?.service;
      if (!identity || !req.v2Identity.authenticate) throw new IdentityError('AUTH_REQUIRED', 401);
      const { actor } = await req.v2Identity.authenticate(req.method === 'GET' ? undefined : { mutation: true });
      let service = getService ? getService(identity) : services.get(identity);
      if (!service) { service = new MemberSpaceService(identity); services.set(identity, service); }
      if (service.identity !== identity) throw new IdentityError('MEMBER_SPACE_IDENTITY_MISMATCH', 503);
      const data = await fn(service, actor, req);
      if (image) res.type(data.contentType).send(data.bytes);
      else res.json({ data, meta: { schemaVersion: 1, requestId: req.v2RequestId, serverTime: new Date(service.now()).toISOString(), scopeVersion: actor.permissionVersion } });
    } catch (error) {
      const known = error instanceof IdentityError;
      res.status(known ? error.status : 503).json({ error: { errorCode: known ? error.errorCode : 'MEMBER_SPACE_UNAVAILABLE',
        messageKey: known ? error.errorCode : 'MEMBER_SPACE_UNAVAILABLE', fieldErrors: error.fieldErrors || {}, requestId: req.v2RequestId,
        operationId: req.get('Idempotency-Key') || null, retryable: known ? error.retryable : true, current: error.current || null } });
    }
  };
  router.get('/bootstrap', wrap((s, a, r) => s.bootstrap(a, csrfCookie(r))));
  router.get('/me/home', wrap((s, a) => s.home(a)));
  router.get('/me/team', wrap((s, a, r) => s.team(a, r.query)));
  router.get('/me/team/avatar/:memberId', wrap((s, a, r) => s.teamAvatar(a, r.params.memberId), true));
  router.get('/me/history', wrap((s, a, r) => s.history(a, r.query)));
  router.get('/me', wrap((s, a) => s.me(a)));
  router.patch('/me', wrap((s, a, r) => {
    const write = () => s.patchMe(a, r.body, { operationId: r.get('Idempotency-Key') });
    // The normal server serializes this transaction with legacy store writes and refreshes its existing cache.
    // The isolated runtime has no legacy store cache and uses the same SQLite transaction directly.
    return r.v2Identity.writeMember ? r.v2Identity.writeMember(write) : write();
  }));
  return router;
}
