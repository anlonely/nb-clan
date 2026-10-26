import { rateLimit } from './rate-limit.js';
import { syncJobsPayload } from './sync-jobs.js';
import { readRecentSyncJobsStore } from './sync-job-store.js';
import { normalizeText } from './store.js';

function sendOk(res, data = {}) {
  res.json({ ok: true, ...data });
}

function sendFail(res, status, error) {
  res.status(status).json({ ok: false, error });
}

function requiredDependency(name, value) {
  if (typeof value !== 'function') {
    throw new TypeError(`registerSyncJobManagementRoutes requires ${name}`);
  }
  return value;
}

export function registerSyncJobManagementRoutes(router, {
  requireModuleEdit,
  rootOnly,
  cancelSyncJobById,
  deleteSyncJobById
} = {}) {
  const requireSyncEdit = requiredDependency('requireModuleEdit', requireModuleEdit)('sync');
  const ensureRoot = requiredDependency('rootOnly', rootOnly);
  const cancelJob = requiredDependency('cancelSyncJobById', cancelSyncJobById);
  const deleteJob = requiredDependency('deleteSyncJobById', deleteSyncJobById);

  router.post('/sync/jobs/:id/cancel', requireSyncEdit, rateLimit({ name: 'sync_job_cancel', windowMs: 10_000, max: 20 }), async (req, res, next) => {
    try {
      if (!ensureRoot(req, res)) return;
      const id = normalizeText(req.params.id, 120);
      if (!id) {
        sendFail(res, 400, '同步任务 ID 无效');
        return;
      }
      const job = await cancelJob(id, req);
      const store = await readRecentSyncJobsStore(16);
      sendOk(res, {
        job,
        ...syncJobsPayload(store, { limit: 16 })
      });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/sync/jobs/:id', requireSyncEdit, async (req, res, next) => {
    try {
      if (!ensureRoot(req, res)) return;
      const id = normalizeText(req.params.id, 120);
      if (!id) {
        sendFail(res, 400, '同步任务 ID 无效');
        return;
      }
      const deleteResult = await deleteJob(req, id);
      const deleted = deleteResult.deleted;
      const active = deleteResult.active;
      if (active) {
        sendFail(res, 400, '运行中的同步任务不能删除');
        return;
      }
      if (!deleted) {
        sendFail(res, 404, '同步任务不存在');
        return;
      }
      const store = await readRecentSyncJobsStore(16);
      sendOk(res, { deleted, ...syncJobsPayload(store, { limit: 16 }) });
    } catch (error) {
      next(error);
    }
  });
}
