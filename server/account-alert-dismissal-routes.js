import {
  clearAccountAlertDismissals,
  normalizeAccountAlertDismissalInput,
  publicAccountAlertDismissals,
  readAccountAlertDismissalsRuntimeStore,
  upsertAccountAlertDismissal
} from './account-alert-dismissal-store.js';

function sendOk(res, data = {}) {
  res.json({ ok: true, ...data });
}

function sendFail(res, status, error) {
  res.status(status).json({ ok: false, error });
}

function requiredDependency(name, value) {
  if (typeof value !== 'function') {
    throw new TypeError(`registerAccountAlertDismissalRoutes requires ${name}`);
  }
  return value;
}

export function registerAccountAlertDismissalRoutes(router, {
  requireModuleView,
  requireModuleEdit
} = {}) {
  const requireRiskView = requiredDependency('requireModuleView', requireModuleView)('riskAlerts');
  const requireRiskEdit = requiredDependency('requireModuleEdit', requireModuleEdit)('riskAlerts');

  router.get('/account-alert-dismissals', requireRiskView, async (_req, res, next) => {
    try {
      const store = await readAccountAlertDismissalsRuntimeStore();
      sendOk(res, { dismissals: publicAccountAlertDismissals(store) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/account-alert-dismissals', requireRiskEdit, async (req, res, next) => {
    try {
      const dismissal = normalizeAccountAlertDismissalInput(req.body || {});
      if (!dismissal) {
        sendFail(res, 400, '提醒类型无效');
        return;
      }
      await upsertAccountAlertDismissal(req, dismissal);
      const store = await readAccountAlertDismissalsRuntimeStore();
      sendOk(res, { dismissals: publicAccountAlertDismissals(store) });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/account-alert-dismissals', requireRiskEdit, async (req, res, next) => {
    try {
      const cleared = await clearAccountAlertDismissals(req);
      const store = await readAccountAlertDismissalsRuntimeStore();
      sendOk(res, { dismissals: publicAccountAlertDismissals(store), cleared });
    } catch (error) {
      next(error);
    }
  });
}
