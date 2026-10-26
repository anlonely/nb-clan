import { appendLog } from './audit-logs.js';
import {
  ensureSyncAutoRules,
  normalizeSyncAutoRuleInput,
  syncAutoRulesPayload
} from './sync-auto-rules.js';
import {
  readSyncAutoRulesStore,
  updateSyncAutoRulesLogStore
} from './sync-auto-rule-store.js';
import { createId, normalizeText, nowIso } from './store.js';

function sendOk(res, data = {}) {
  res.json({ ok: true, ...data });
}

function sendFail(res, status, error) {
  res.status(status).json({ ok: false, error });
}

function requiredDependency(name, value) {
  if (typeof value !== 'function') {
    throw new TypeError(`registerSyncAutoRuleRoutes requires ${name}`);
  }
  return value;
}

export function registerSyncAutoRuleRoutes(router, {
  requireModuleView,
  requireModuleEdit,
  rootOnly,
  runtimeOptions = {}
} = {}) {
  const requireSyncView = requiredDependency('requireModuleView', requireModuleView)('sync');
  const requireSyncEdit = requiredDependency('requireModuleEdit', requireModuleEdit)('sync');
  const ensureRoot = requiredDependency('rootOnly', rootOnly);

  router.get('/sync/auto-rules', requireSyncView, async (_req, res, next) => {
    try {
      const store = await readSyncAutoRulesStore();
      sendOk(res, syncAutoRulesPayload(store, runtimeOptions));
    } catch (error) {
      next(error);
    }
  });

  router.post('/sync/auto-rules', requireSyncEdit, async (req, res, next) => {
    try {
      if (!ensureRoot(req, res)) return;
      const ruleInput = normalizeSyncAutoRuleInput(req.body || {}, null, runtimeOptions);
      await updateSyncAutoRulesLogStore((store) => {
        const now = nowIso();
        const rule = {
          id: createId('sync_auto_rule'),
          ...ruleInput,
          lastRunAt: '',
          createdAt: now,
          updatedAt: now
        };
        ensureSyncAutoRules(store).unshift(rule);
        appendLog(store, req, 'sync_auto_rule_add', `新增自动任务规则 ${rule.name}`, {
          targetId: rule.id,
          metadata: { type: rule.type, intervalMinutes: rule.intervalMinutes, enabled: rule.enabled }
        });
      }, 'sync_auto_rule_add');
      const store = await readSyncAutoRulesStore();
      sendOk(res, syncAutoRulesPayload(store, runtimeOptions));
    } catch (error) {
      next(error);
    }
  });

  router.put('/sync/auto-rules/:id', requireSyncEdit, async (req, res, next) => {
    try {
      if (!ensureRoot(req, res)) return;
      const id = normalizeText(req.params.id, 120);
      await updateSyncAutoRulesLogStore((store) => {
        const rules = ensureSyncAutoRules(store);
        const index = rules.findIndex((rule) => rule.id === id);
        if (index < 0) throw Object.assign(new Error('自动任务规则不存在'), { status: 404 });
        const nextRule = {
          ...rules[index],
          ...normalizeSyncAutoRuleInput(req.body || {}, rules[index], runtimeOptions),
          updatedAt: nowIso()
        };
        rules[index] = nextRule;
        appendLog(store, req, 'sync_auto_rule_edit', `更新自动任务规则 ${nextRule.name}`, {
          targetId: nextRule.id,
          metadata: { type: nextRule.type, intervalMinutes: nextRule.intervalMinutes, enabled: nextRule.enabled }
        });
      }, 'sync_auto_rule_edit');
      const store = await readSyncAutoRulesStore();
      sendOk(res, syncAutoRulesPayload(store, runtimeOptions));
    } catch (error) {
      next(error);
    }
  });

  router.delete('/sync/auto-rules/:id', requireSyncEdit, async (req, res, next) => {
    try {
      if (!ensureRoot(req, res)) return;
      const id = normalizeText(req.params.id, 120);
      let deleted = 0;
      await updateSyncAutoRulesLogStore((store) => {
        const rules = ensureSyncAutoRules(store);
        const index = rules.findIndex((rule) => rule.id === id);
        if (index < 0) return;
        const [rule] = rules.splice(index, 1);
        deleted = 1;
        appendLog(store, req, 'sync_auto_rule_delete', `删除自动任务规则 ${rule.name}`, {
          targetId: rule.id,
          metadata: { type: rule.type }
        });
      }, 'sync_auto_rule_delete');
      if (!deleted) {
        sendFail(res, 404, '自动任务规则不存在');
        return;
      }
      const store = await readSyncAutoRulesStore();
      sendOk(res, { deleted, ...syncAutoRulesPayload(store, runtimeOptions) });
    } catch (error) {
      next(error);
    }
  });
}
