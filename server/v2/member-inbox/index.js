import express from 'express';
import { randomUUID } from 'node:crypto';
import { IdentityError } from '../identity/errors.js';
import { need } from './repository.js';
export { installMemberInboxSchema, MemberInboxRepository } from './repository.js';
export { MemberInboxService, TEMPLATE_KEYS } from './service.js';

export function createMemberInboxDomainAdapters({ service, identity = service?.identity }) {
  need(service?.identity === identity && service.repo.db === identity?.repo?.db, 'INBOX_IDENTITY_MISMATCH', 503);
  const call = (args, fn) => {
    need(args.source === 'wechat' && typeof args.assertCurrent === 'function', 'INBOX_TRUSTED_SESSION_REQUIRED', 503);
    args.assertCurrent();
    return fn({ assertCurrent: args.assertCurrent, operationId: args.operationId });
  };
  return { mini: { notifications: {
    settings: args => call(args, options => service.settings(args.actor, args.input, options)),
    saveSettings: args => call(args, options => service.saveSettings(args.actor, args.input, options)),
    list: args => call(args, options => service.list(args.actor, args.input, options)),
    markRead: args => call(args, options => {
      need(args.input && Object.keys(args.input).every(k => ['notificationId', 'expectedRevision'].includes(k)), 'INBOX_FIELD_NOT_WRITABLE');
      return service.markRead(args.actor, args.input.notificationId, { expectedRevision: args.input.expectedRevision }, options);
    })
  } } };
}

export function createMemberInboxRouter({ getService }) {
  const router = express.Router();
  router.use('/member-inbox', express.json({ limit: '16kb' }));
  const handle = fn => async (req, res) => {
    const requestId = req.v2RequestId || randomUUID();
    res.set('Cache-Control', 'no-store');
    try {
      const identity = req.v2Identity?.service;
      need(identity && req.v2Identity.authenticate, 'AUTH_REQUIRED', 401);
      const { actor, session } = await req.v2Identity.authenticate({ mutation: req.method !== 'GET' });
      const service = getService(identity);
      need(service?.identity === identity && service.repo.db === identity.repo.db, 'INBOX_IDENTITY_MISMATCH', 503);
      const options = { operationId: req.get('Idempotency-Key'), assertCurrent: () => {
        // G03's async eligibility/CSRF check happened above; this synchronous
        // fence rechecks the actual session record, not just an actor snapshot.
        const current = identity.repo.get('sessions', session.id);
        need(current && current.accountId === actor.id && current.permissionVersion === actor.permissionVersion &&
          Date.parse(current.expiresAt) > identity.now(), 'AUTH_REQUIRED', 401);
        const a = identity.actorForAccount(actor.id);
        const account = identity.repo.get('accounts', actor.id);
        need(a.permissionVersion === actor.permissionVersion && current.scopeDigest === identity.scopeDigest(account), 'PERMISSIONS_CHANGED', 401);
        return a;
      } };
      const data = await fn(service, actor, req, options);
      res.json({ data, meta: { schemaVersion: 1, requestId, scopeVersion: actor.permissionVersion,
        serverTime: new Date(service.now()).toISOString() } });
    } catch (error) {
      const known = error instanceof IdentityError;
      res.status(known ? error.status : 503).json({ error: { errorCode: known ? error.errorCode : 'INBOX_UNAVAILABLE',
        messageKey: known ? error.errorCode : 'INBOX_UNAVAILABLE', requestId,
        operationId: req.get('Idempotency-Key') || null, retryable: known ? error.retryable : true } });
    }
  };
  router.get('/member-inbox/settings', handle((s,a,r,o) => s.settings(a,r.query,o)));
  router.put('/member-inbox/settings', handle((s,a,r,o) => s.saveSettings(a,r.body,o)));
  router.get('/member-inbox/notifications', handle((s,a,r,o) => s.list(a,r.query,o)));
  router.post('/member-inbox/notifications/:id/read', handle((s,a,r,o) => s.markRead(a,r.params.id,r.body,o)));
  return router;
}
