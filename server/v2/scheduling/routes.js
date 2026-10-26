import express from 'express';
import { IdentityError } from '../identity/errors.js';
import { SchedulingRepository } from './repository.js';
import { SchedulingService } from './service.js';

export function createSchedulingRouter({ getService } = {}) {
  const router = express.Router(), services = new WeakMap();
  const wrap = fn => async (req, res) => {
    try {
      const identity = req.v2Identity?.service;
      if (!identity) throw new IdentityError('AUTH_REQUIRED', 401);
      let service = getService ? getService(identity) : services.get(identity);
      if (!service) {
        const repo = new SchedulingRepository(identity.repo.db);
        service = new SchedulingService(repo, identity); services.set(identity, service);
      }
      if (service.identity !== identity || service.repo?.db !== identity.repo.db)
        throw new IdentityError('SCHEDULING_SETUP_REQUIRED', 503);
      if (!service.repo.scalar('v2SchedulingMigration')) throw new IdentityError('SCHEDULING_MIGRATION_REQUIRED', 503);
      const { actor } = await req.v2Identity.authenticate(req.method === 'GET' ? undefined : { mutation: true });
      const options = { operationId: req.get('Idempotency-Key'), source: 'web' };
      const data = await fn(service, actor, req, options, res);
      res.json({ data, meta: { schemaVersion: 1, requestId: req.v2RequestId,
        serverTime: new Date(service.now()).toISOString(), scopeVersion: actor.permissionVersion } });
    } catch (e) {
      const known = e instanceof IdentityError || typeof e.errorCode === 'string';
      res.status(known ? e.status || 500 : 500).json({ error: { errorCode: known ? e.errorCode : 'SCHEDULING_UNAVAILABLE',
        messageKey: known ? e.errorCode : 'SCHEDULING_UNAVAILABLE', fieldErrors: e.fieldErrors || {}, requestId: req.v2RequestId,
        operationId: req.get('Idempotency-Key') || null, retryable: known ? Boolean(e.retryable) : false,
        ...(e.current ? { current: e.current } : {}), ...(e.candidates ? { candidates: e.candidates } : {}) } });
    }
  };
  router.get('/wipes', wrap((s,a,r) => s.listWipes(a,r.query)));
  router.post('/wipes', wrap((s,a,r,o,res) => { res.status(201); return s.createWipe(a,r.body,o); }));
  router.get('/wipes/:id/summary', wrap((s,a,r) => s.summary(a,r.params.id)));
  router.get('/wipes/:id/signups', wrap((s,a,r) => s.listSignups(a,r.params.id,r.query)));
  router.get('/wipes/:id/my-signup', wrap((s,a,r) => s.getSignup(a,r.params.id,a.memberId)));
  router.get('/wipes/:id/signups/:memberId', wrap((s,a,r) => s.getSignup(a,r.params.id,r.params.memberId)));
  router.get('/wipes/:id/archives/:revision', wrap((s,a,r) => s.getArchive(a,r.params.id,r.params.revision)));
  router.get('/wipes/:id', wrap((s,a,r) => s.getWipe(a,r.params.id)));
  router.patch('/wipes/:id', wrap((s,a,r,o) => s.updateWipe(a,r.params.id,r.body,o)));
  router.post('/wipes/:id/commands/:command', wrap((s,a,r,o) => s.transition(a,r.params.id,r.params.command,r.body,o)));
  router.put('/wipes/:id/my-signup', wrap(async (s,a,r,o) => { await s.prepareSignupTarget(a,r.params.id,a.memberId,o); return s.saveSignup(a,r.params.id,a.memberId,r.body,o); }));
  router.put('/wipes/:id/signups/:memberId', wrap(async (s,a,r,o) => { const options = { ...o,delegate: true };
    await s.prepareSignupTarget(a,r.params.id,r.params.memberId,options); return s.saveSignup(a,r.params.id,r.params.memberId,r.body,options); }));
  router.get('/operations/:id', wrap((s,a,r) => s.getOperation(a,r.params.id)));
  return router;
}
