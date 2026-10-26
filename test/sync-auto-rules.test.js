import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SYNC_AUTO_RULE_MAX_INTERVAL_MINUTES,
  SYNC_AUTO_RULE_MIN_INTERVAL_MINUTES,
  ensureSyncAutoRules,
  normalizeSyncAutoRuleInput,
  publicSyncAutoRule,
  syncAutoRuleDue,
  syncAutoRuleRuntimeDefaults,
  syncAutoRulesPayload
} from '../server/sync-auto-rules.js';

const runtimeOptions = {
  battlemetricsMemberSyncIntervalMs: 30 * 60 * 1000,
  kdaAutoSyncIntervalMs: 15 * 60 * 1000,
  memberProfileSyncIntervalMs: 12 * 60 * 60 * 1000
};

test('sync auto rule helpers normalize defaults, payloads, and due checks', () => {
  assert.deepEqual(syncAutoRuleRuntimeDefaults('kda', runtimeOptions), {
    intervalMinutes: 15,
    scope: 'current_wipe'
  });
  assert.deepEqual(syncAutoRuleRuntimeDefaults('member_profile', runtimeOptions), {
    intervalMinutes: 720,
    scope: 'all_members'
  });

  const createdAt = '2026-07-07T00:00:00.000Z';
  const publicRule = publicSyncAutoRule({
    id: 'rule_kda',
    type: 'kda',
    createdAt,
    updatedAt: createdAt,
    lastRunAt: createdAt
  }, runtimeOptions);
  assert.equal(publicRule.name, 'KDA 自动同步');
  assert.equal(publicRule.intervalMinutes, 15);
  assert.equal(publicRule.scope, 'current_wipe');
  assert.equal(publicRule.nextRunAt, '2026-07-07T00:15:00.000Z');

  assert.equal(syncAutoRuleDue({ ...publicRule, lastRunAt: '' }, Date.parse(createdAt), runtimeOptions), true);
  assert.equal(syncAutoRuleDue(publicRule, Date.parse('2026-07-07T00:14:59.000Z'), runtimeOptions), false);
  assert.equal(syncAutoRuleDue(publicRule, Date.parse('2026-07-07T00:15:00.000Z'), runtimeOptions), true);
  assert.equal(syncAutoRuleDue({ ...publicRule, enabled: false }, Date.parse('2026-07-08T00:00:00.000Z'), runtimeOptions), false);

  const store = {
    syncAutoRules: [
      { id: 'later', type: 'member_profile', createdAt: '2026-07-07T01:00:00.000Z' },
      { id: 'earlier', type: 'battlemetrics_playtime', createdAt }
    ]
  };
  const payload = syncAutoRulesPayload(store, runtimeOptions);
  assert.deepEqual(payload.rules.map((rule) => rule.id), ['earlier', 'later']);
  assert.equal(payload.options.minIntervalMinutes, SYNC_AUTO_RULE_MIN_INTERVAL_MINUTES);
  assert.equal(payload.options.maxIntervalMinutes, SYNC_AUTO_RULE_MAX_INTERVAL_MINUTES);
  assert.equal(payload.options.types.some((item) => item.value === 'battlemetrics_identity'), true);
  assert.equal(payload.options.scopes.some((item) => item.value === 'missing_only'), true);
});

test('sync auto rule input validation preserves existing fields and rejects invalid bounds', () => {
  const existing = {
    name: 'Old rule',
    type: 'member_profile',
    enabled: false,
    intervalMinutes: 120,
    scope: 'all_members',
    notes: 'old'
  };
  assert.deepEqual(normalizeSyncAutoRuleInput({ notes: 'new' }, existing, runtimeOptions), {
    name: 'Old rule',
    type: 'member_profile',
    enabled: false,
    intervalMinutes: 120,
    scope: 'all_members',
    notes: 'new'
  });
  assert.deepEqual(normalizeSyncAutoRuleInput({
    type: 'battlemetrics_playtime',
    intervalMinutes: '30',
    scope: 'missing_only',
    enabled: true
  }, null, runtimeOptions), {
    name: 'BM 在线时间自动同步',
    type: 'battlemetrics_playtime',
    enabled: true,
    intervalMinutes: 30,
    scope: 'missing_only',
    notes: ''
  });

  assert.throws(() => normalizeSyncAutoRuleInput({ type: 'unknown' }, null, runtimeOptions), /自动任务类型无效/);
  assert.throws(() => normalizeSyncAutoRuleInput({ type: 'kda', intervalMinutes: 1 }, null, runtimeOptions), /自动任务间隔需要/);
  assert.throws(() => normalizeSyncAutoRuleInput({ type: 'kda', intervalMinutes: 30, scope: 'bad_scope' }, null, runtimeOptions), /自动任务范围无效/);
});

test('ensureSyncAutoRules initializes missing collection without replacing existing arrays', () => {
  const emptyStore = {};
  const initialized = ensureSyncAutoRules(emptyStore);
  assert.equal(Array.isArray(initialized), true);
  assert.equal(emptyStore.syncAutoRules, initialized);

  const existing = [];
  const store = { syncAutoRules: existing };
  assert.equal(ensureSyncAutoRules(store), existing);
});
