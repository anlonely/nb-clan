import express from 'express';
import { randomUUID } from 'node:crypto';
import { IdentityError } from '../identity/errors.js';
import { MemberAdminService } from './service.js';
import { requireValue } from './repository.js';
/** Mandatory writeDomain serializes with legacy writes and repairs only changed
 * cache records after commit; adapters are trusted runtime dependencies. */
export function createMemberAdminRouter({
  writeDomain,
  adapters = {},
  afterCommit,
  getService
} = {}) {
  const router = express.Router(),
    services = new WeakMap();
  router.use('/member-admin', express.json({
    limit: '160kb'
  }), (req, res, next) => {
    req.v2RequestId ||= randomUUID();
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    next();
  });
  const wrap = (fn, {
    write = false,
    external = false
  } = {}) => async (req, res) => {
    try {
      const identity = req.v2Identity?.service;
      requireValue(identity && req.v2Identity.authenticate, 'AUTH_REQUIRED', 401);
      const {
        actor
      } = await req.v2Identity.authenticate(write ? {
        mutation: true
      } : undefined);
      let service = getService ? getService(identity) : services.get(identity);
      if (!service && !getService) {
        service = new MemberAdminService(identity, adapters);
        services.set(identity, service);
      }
      requireValue(service instanceof MemberAdminService && service.identity === identity && service.repo.db === identity.repo.db, 'MEMBER_RUNTIME_IDENTITY_MISMATCH', 503);
      const operationId = req.get('Idempotency-Key');
      let result;
      if (write && !external) {
        requireValue(typeof writeDomain === 'function', 'MEMBER_WRITE_ADAPTER_REQUIRED', 503);
        result = await writeDomain(() => fn(service, actor, req, operationId), {
          identity,
          actor
        });
        if (afterCommit) await afterCommit(result, {
          identity,
          actor
        });
      } else result = await fn(service, actor, req, operationId);
      // Internal cache patches, full member snapshots and outbox events never enter HTTP receipts.
      const data = write && !external ? {
        operationId: result.operationId,
        ...result.data,
        revision: result.data?.revision ?? result.revision,
        replayed: result.replayed
      } : result;
      res.json({
        data,
        meta: {
          schemaVersion: 1,
          scopeVersion: actor.permissionVersion,
          requestId: req.v2RequestId,
          serverTime: service.stamp()
        }
      });
    } catch (e) {
      const known = e instanceof IdentityError;
      res.status(known ? e.status : 503).json({
        error: {
          errorCode: known ? e.errorCode : 'MEMBER_ADMIN_UNAVAILABLE',
          messageKey: known ? e.errorCode : 'MEMBER_ADMIN_UNAVAILABLE',
          retryable: known ? e.retryable : true,
          operationId: req.get('Idempotency-Key') || null,
          current: e.current || null,
          requestId: req.v2RequestId
        }
      });
    }
  };
  const get = (path, fn) => router.get('/member-admin' + path, wrap(fn));
  const post = (path, fn, external = false) => router.post('/member-admin' + path, wrap(fn, {
    write: true,
    external
  }));
  get('/options', (s, a) => s.options(a));
  get('/members', (s, a, r) => s.members(a, r.query));
  post('/members/departure-scan', (s, a, r) => s.scanDeparture(a, r.body), true);
  get('/members/export', (s, a, r) => s.export(a, r.query));
  get('/members/:id', (s, a, r) => s.detail(a, r.params.id));
  post('/members', (s, a, r, op) => s.create(a, r.body, op));
  post('/members/import/preview', (s, a, r) => s.previewImport(a, r.body), true);
  post('/members/import', (s, a, r, op) => s.importMembers(a, r.body, op));
  post('/members/assign', (s, a, r, op) => s.moveMany(a, r.body, op));
  post('/resolve-steam', (s, a, r, op) => s.resolveSteam(a, r.body, op), true);
  post('/members/delete', (s, a, r, op) => s.deleteMembers(a, r.body, op));
  router.patch('/member-admin/members/:id', wrap((s, a, r, op) => s.edit(a, r.params.id, {
    ...r.body,
    targetId: r.params.id
  }, op), {
    write: true
  }));
  for (const [path, method] of [['status', 'status'], ['squad', 'move'], ['unlink', 'unlink']]) post('/members/:id/' + path, (s, a, r, op) => s[method](a, r.params.id, {
    ...r.body,
    targetId: r.params.id
  }, op));
  get('/squads', (s, a, r) => s.squads(a, r.query));
  get('/leaders', (s, a, r) => s.leaders(a, r.query));
  post('/squads', (s, a, r, op) => s.saveSquad(a, null, r.body, op));
  post('/squads/:id', (s, a, r, op) => s.saveSquad(a, r.params.id, {
    ...r.body,
    targetId: r.params.id
  }, op));
  post('/squads/:id/archive', (s, a, r, op) => s.archiveSquad(a, r.params.id, {
    ...r.body,
    targetId: r.params.id
  }, op));
  // Retired modules: explicit tombstones prevent legacy fallback handlers from serving them.
  router.use(['/member-admin/reviews', '/member-admin/archive'], (_req, res) => res.status(410).json({
    error: { errorCode: 'MEMBER_APPLICATION_MODULE_REMOVED', retryable: false }
  }));
  get('/history/:kind/:id', (s, a, r) => s.audit(a, r.params.kind, r.params.id, r.query));
  get('/operations/:id', (s, a, r) => s.operation(a, r.params.id));
  get('/risks', (s, a, r) => s.risks(a, r.query));
  get('/risk-rules', (s, a) => s.rules(a));
  post('/risk-rules', (s, a, r, op) => s.saveRules(a, r.body, op));
  post('/risks/:id/state', (s, a, r, op) => s.riskState(a, r.params.id, {
    ...r.body,
    targetId: r.params.id
  }, op));
  post('/risks/clear-confirmations', (s, a, r, op) => s.clearLegacyRiskConfirmations(a, r.body, op));
  post('/risks/reset', (s, a, r, op) => s.clearRiskStates(a, r.body, op));
  for (const action of ['request', 'cancel', 'status']) post('/sync/' + action, (s, a, r, op) => s.sync(a, r.body, op, action), true);
  return router;
}
