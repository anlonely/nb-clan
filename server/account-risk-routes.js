import { appendLog } from './audit-logs.js';
import {
  readSettingsRuntimeStore,
  updateSettingsLogStore
} from './settings-store.js';
import { normalizeText, nowIso } from './store.js';

function sendOk(res, data = {}) {
  res.json({ ok: true, ...data });
}

function requiredDependency(name, value) {
  if (typeof value !== 'function') {
    throw new TypeError(`registerAccountRiskSettingsRoutes requires ${name}`);
  }
  return value;
}

export function registerAccountRiskSettingsRoutes(router, {
  requireModuleView,
  requireModuleEdit,
  rootOnly,
  publicAccountRiskSettings,
  accountRiskRulesForStore,
  normalizeAccountRiskRuleInput,
  normalizeAccountRiskSquadFilter
} = {}) {
  const requireRiskView = requiredDependency('requireModuleView', requireModuleView)('riskAlerts');
  const requireRiskEdit = requiredDependency('requireModuleEdit', requireModuleEdit)('riskAlerts');
  const ensureRoot = requiredDependency('rootOnly', rootOnly);
  const toPublicAccountRiskSettings = requiredDependency('publicAccountRiskSettings', publicAccountRiskSettings);
  const rulesForStore = requiredDependency('accountRiskRulesForStore', accountRiskRulesForStore);
  const normalizeRuleInput = requiredDependency('normalizeAccountRiskRuleInput', normalizeAccountRiskRuleInput);
  const normalizeSquadFilter = requiredDependency('normalizeAccountRiskSquadFilter', normalizeAccountRiskSquadFilter);

  router.get('/settings/account-risk', requireRiskView, async (_req, res, next) => {
    try {
      const store = await readSettingsRuntimeStore();
      sendOk(res, { accountRisk: toPublicAccountRiskSettings(store) });
    } catch (error) {
      next(error);
    }
  });

  router.put('/settings/account-risk', requireRiskEdit, async (req, res, next) => {
    try {
      if (!ensureRoot(req, res)) return;
      const bodyRules = Array.isArray(req.body?.rules) ? req.body.rules : [];
      await updateSettingsLogStore((store) => {
        const existingById = new Map(rulesForStore(store).map((rule) => [rule.id, rule]));
        const rules = bodyRules
          .map((item) => normalizeRuleInput(item, existingById.get(normalizeText(item?.id, 100))))
          .filter(Boolean)
          .slice(0, 50);
        store.settings ||= {};
        store.settings.accountRisk ||= {};
        store.settings.accountRisk.squadFilter = normalizeSquadFilter(req.body?.squadFilter);
        store.settings.accountRisk.rules = rules;
        store.settings.accountRisk.configured = true;
        store.settings.accountRisk.updatedAt = nowIso();
        appendLog(store, req, 'account_risk_settings_edit', `更新账号风险规则 ${rules.length} 条`);
      }, 'account_risk_settings_edit');
      const store = await readSettingsRuntimeStore();
      sendOk(res, { accountRisk: toPublicAccountRiskSettings(store) });
    } catch (error) {
      next(error);
    }
  });
}
