import express from 'express';
import { randomUUID } from 'node:crypto';
import { IdentityError } from '../identity/errors.js';
import { StatsService } from './service.js';
/** Public boundary: mount at /api/v2 after G03 middleware. All dependencies are trusted server adapters. */
export function createStatsRouter(options = {}, { getService } = {}) {
  const router = express.Router(),
    services = new WeakMap();
  router.use('/stats', express.json({
    limit: '300kb'
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
      const {
        actor
      } = await runtime.authenticate({
        mutation: !['GET', 'HEAD'].includes(req.method)
      });
      let s = getService ? getService(runtime.service) : services.get(runtime.service);
      if (!s && !getService) {
        s = new StatsService(runtime.service, typeof options === 'function' ? options(runtime.service) : options);
        services.set(runtime.service, s);
      }
      if (!(s instanceof StatsService) || s.identity !== runtime.service || s.repo.db !== runtime.service.repo.db) throw new IdentityError('STATS_RUNTIME_IDENTITY_MISMATCH', 503);
      const data = await fn(s, actor, req, res);
      if (res.headersSent) return;
      res.json({
        data,
        meta: {
          schemaVersion: 1,
          requestId,
          serverTime: new Date(s.now()).toISOString(),
          scopeVersion: actor.permissionVersion
        }
      });
    } catch (e) {
      const known = e instanceof IdentityError;
      res.status(known ? e.status : 503).json({
        error: {
          errorCode: known ? e.errorCode : 'STATS_UNAVAILABLE',
          messageKey: known ? e.errorCode : 'STATS_UNAVAILABLE',
          requestId,
          operationId: req.get('Idempotency-Key') || null,
          retryable: known ? e.retryable : true,
          fieldErrors: {}
        }
      });
    }
  };
  router.get('/stats/query-capabilities', handle((s, a, r) => s.queryCapabilities(a, r.query)));
  router.get('/stats/wipes', handle((s, a, r) => s.catalog(a, r.query)));
  router.get('/stats/wipes/:id/sources', handle((s, a, r) => s.sources(a, r.params.id)));
  router.get('/stats/rows', handle((s, a, r) => s.list(a, r.query)));
  router.get('/stats/wipes/:id/history', handle((s, a, r) => s.history(a, r.params.id, r.query)));
  router.get('/stats/wipes/:id/history/:revision/participants', handle((s, a, r) => s.archiveRoster(a, r.params.id, r.params.revision, r.query)));
  router.get('/stats/wipes/:id/audit', handle((s, a, r) => s.audit(a, r.params.id, r.query)));
  router.post('/stats/import/preview', handle((s, a, r) => s.importPreview(a, r.body)));
  router.post('/stats/import', handle(async (s, a, r) => {
    const result = await s.import(a, r.body, r.get('Idempotency-Key'));
    const {
      upserts,
      ...dto
    } = result;
    return dto;
  }));
  router.post('/stats/archives', handle((s, a, r) => s.archive(a, r.body, r.get('Idempotency-Key'))));
  router.post('/stats/visibility', handle((s, a, r) => s.visibility(a, r.body, r.get('Idempotency-Key'))));
  router.post('/stats/interval', handle((s, a, r) => s.interval(a, r.body)));
  router.post('/stats/sync', handle((s, a, r) => s.sync(a, r.body, r.get('Idempotency-Key'))));
  router.get('/stats/sync/:id', handle((s, a, r) => {
    if (!s.readSync) throw new IdentityError('SYNC_ADAPTER_REQUIRED', 503);
    return s.readSync({
      actor: a,
      jobId: r.params.id
    });
  }));
  router.post('/stats/queries', handle((s, a, r) => s.createJob(a, 'query', r.body, r.get('Idempotency-Key'))));
  router.post('/stats/exports', handle((s, a, r) => s.createJob(a, 'export', r.body, r.get('Idempotency-Key'))));
  router.get('/stats/jobs/:id', handle((s, a, r) => {
    const job = s.readJob(a, r.params.id);
    if (job.kind === 'export' && job.result?.base64) {
      const {
        base64,
        ...file
      } = job.result;
      job.result = file;
    }
    return job;
  }));
  router.get('/stats/jobs/:id/file', handle((s, a, r, res) => {
    const job = s.readJob(a, r.params.id);
    if (job.kind !== 'export' || job.status !== 'succeeded' || !job.result?.base64) throw new IdentityError('FILE_NOT_READY', 409);
    res.set({
      'Content-Disposition': `attachment; filename="${job.result.fileName.replace(/[^A-Za-z0-9_.-]/g, '_')}"`,
      'Content-Type': job.result.mime,
      'Content-Security-Policy': "default-src 'none'; sandbox"
    });
    res.send(Buffer.from(job.result.base64, 'base64'));
  }));
  return router;
}
