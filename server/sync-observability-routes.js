import { operationRunsPayload, readOperationRunsHealthStore } from './operation-runs.js';
import { syncJobsPayload } from './sync-jobs.js';
import {
  readCurrentSyncJobsStore,
  readRecentSyncJobsStore
} from './sync-job-store.js';

function sendOk(res, data = {}) {
  res.json({ ok: true, ...data });
}

function queryLimit(req, fallback = 20, max = 100) {
  return Math.max(1, Math.min(max, Number(req.query?.limit || fallback)));
}

export function registerSyncObservabilityRoutes(router, { requireModuleView } = {}) {
  if (typeof requireModuleView !== 'function') {
    throw new TypeError('registerSyncObservabilityRoutes requires requireModuleView');
  }
  const requireSyncView = requireModuleView('sync');

  router.get('/sync/jobs/current', requireSyncView, async (_req, res, next) => {
    try {
      const store = await readCurrentSyncJobsStore();
      const payload = syncJobsPayload(store);
      sendOk(res, {
        jobs: payload.current,
        partial: payload.partial,
        readError: payload.readError,
        updatedAt: payload.updatedAt
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/sync/jobs/recent', requireSyncView, async (req, res, next) => {
    try {
      const limit = queryLimit(req);
      const store = await readRecentSyncJobsStore(limit);
      sendOk(res, syncJobsPayload(store, { limit }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/sync/operation-runs/recent', requireSyncView, async (req, res, next) => {
    try {
      const limit = queryLimit(req);
      const store = await readOperationRunsHealthStore(limit);
      sendOk(res, operationRunsPayload(store, { limit }));
    } catch (error) {
      next(error);
    }
  });
}
