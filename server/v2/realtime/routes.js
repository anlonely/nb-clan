import express from 'express';
import { randomUUID } from 'node:crypto';
import { IdentityError } from '../identity/errors.js';
import { RealtimeService } from './service.js';
export function createRealtimeRouter(options = {}) {
  const router = express.Router(),
    services = new WeakMap();
  router.use('/realtime', express.json({
    limit: '16kb'
  }));
  const handle = fn => async (req, res) => {
    const requestId = req.v2RequestId || randomUUID();
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    try {
      const runtime = req.v2Identity;
      if (!runtime?.service || !runtime.authenticate) throw new IdentityError('AUTH_REQUIRED', 401);
      const authenticate = () => runtime.authenticate({
          mutation: !['GET', 'HEAD'].includes(req.method)
        }),
        {
          actor
        } = await authenticate();
      let service = services.get(runtime.service);
      if (!service) {
        service = new RealtimeService(runtime.service, typeof options === 'function' ? options(runtime.service) : options);
        services.set(runtime.service, service);
      }
      const data = await fn(service, actor, req, res, authenticate);
      if (res.headersSent) return;
      service.current(actor);
      res.json({
        data,
        meta: {
          schemaVersion: 1,
          requestId,
          serverTime: new Date(service.now()).toISOString(),
          scopeVersion: actor.permissionVersion
        }
      });
    } catch (e) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const known = e instanceof IdentityError;
      res.status(known ? e.status : 503).json({
        error: {
          errorCode: known ? e.errorCode : 'REALTIME_UNAVAILABLE',
          messageKey: known ? e.errorCode : 'REALTIME_UNAVAILABLE',
          retryable: known ? e.retryable : true,
          requestId,
          operationId: req.get('Idempotency-Key') || null,
          fieldErrors: {}
        }
      });
    }
  };
  router.get('/realtime/scopes', handle((s, a, r) => s.catalog(a, r.query.mode)));
  router.get('/realtime/:id/summary', handle((s, a, r) => s.summary(a, r.params.id)));
  router.get('/realtime/:id/chats', handle((s, a, r) => s.page(a, r.params.id, {
    ...r.query,
    kind: 'chat'
  })));
  router.get('/realtime/:id/invites', handle((s, a, r) => s.page(a, r.params.id, {
    ...r.query,
    kind: 'invite'
  })));
  router.get('/realtime/:id/events', handle((s, a, r) => s.events(a, r.params.id, r.query.after)));
  router.get('/realtime/:id/member-options', handle((s, a, r) => s.memberOptions(a, r.params.id)));
  router.get('/realtime/:id/stream', handle((s, a, r, res, authenticate) => {
    const config = typeof options === 'function' ? options(s.identity) : options;
    if (!config.streamOwner) throw new IdentityError('STREAM_OWNER_REQUIRED', 503);
    return config.streamOwner.open({
      req: r,
      res,
      service: s,
      authenticate,
      scopeId: r.params.id,
      cursor: r.get('Last-Event-ID') || r.query.after
    });
  }));
  router.post('/realtime/:id/commands/:action', handle((s, a, r) => {
    const config = typeof options === 'function' ? options(s.identity) : options;
    const command = () => s.command(a, r.params.id, r.params.action, r.body, r.get('Idempotency-Key'));
    // Member import owns its member-domain queue/cache transaction. Nesting that
    // queue inside itself would deadlock; source commands use the host queue.
    return config.writeCommand && r.params.action !== 'import-member' ? config.writeCommand(command) : command();
  }));
  return router;
}
