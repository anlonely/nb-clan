import express from 'express';
import { randomUUID } from 'node:crypto';
import { sendError } from '../platform-admin/routes.js';
import { need, error } from './model.js';

/** Mount before both mini JSON parser (32KiB) and legacy /wechat catch-all.
 * authenticate must be the existing app-scoped mini.authenticate, not a body/cookie-derived actor.
 */
export function createPlatformMediaRouter({ owner, authenticate, legacy = false }) {
  need(owner && typeof authenticate === 'function', 'MEDIA_ROUTER_UNAVAILABLE', 503);
  const router = express.Router(), prefix = legacy ? '/wechat' : '/platform-media';
  router.post(`${prefix}/avatar`, express.json({ limit: '1400kb', strict: true }));
  const wrap = (method, bytes = false) => async (req, res) => {
    const id = randomUUID(), controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort);
    const closed = () => { if (!res.writableEnded) abort(); }; res.once('close', closed);
    res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' });
    try {
      const raw = legacy ? req.get('x-nb-wechat-session') : /^Bearer ([A-Za-z0-9_-]{30,100})$/.exec(req.get('Authorization') || '')?.[1];
      need(typeof raw === 'string' && /^[A-Za-z0-9_-]{30,100}$/.test(raw), 'MINI_SESSION_INVALID', 401);
      const envelope = { token: raw }, initial = authenticate(envelope);
      need(initial?.actor && initial.session?.appId && initial.session?.externalId, 'MEDIA_SUBJECT_INVALID', 403);
      const assertCurrent = () => authenticate(envelope).actor;
      const subject = () => {
        const { session, actor } = authenticate(envelope);
        return { verified: true, appId: session.appId, externalId: session.externalId, accountId: actor.id };
      };
      const result = await owner[method]({ actor: initial.actor, subject, assertCurrent,
        input: req.method === 'GET' ? { ...req.query } : req.body, operationId: req.get('Idempotency-Key'), signal: controller.signal });
      assertCurrent();
      if (bytes) { res.set('Content-Type', result.contentType); res.set('Content-Length', String(result.bytes.length)); res.send(result.bytes); }
      else res.json({ data: result, meta: { schemaVersion: 1, requestId: id } });
    } catch (e) { if (!res.destroyed) sendError(res, e, id, req.get('Idempotency-Key')); }
    finally { req.removeListener('aborted', abort); res.removeListener('close', closed); }
  };
  router.get(`${prefix}/avatar`, wrap('avatarState'));
  router.post(`${prefix}/avatar`, wrap('avatar'));
  router.get(`${prefix}/avatar-image`, wrap('avatarImage', true));
  router.get(`${prefix}/share-code`, wrap('shareCode', true));
  router.use((err, req, res, next) => { if (!req.path.startsWith(prefix + '/')) return next(err); sendError(res, error('MEDIA_INPUT_INVALID', err.status === 413 ? 413 : 422), randomUUID()); });
  return router;
}
