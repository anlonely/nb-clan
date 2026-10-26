import { setUiLocale } from '../src/v2/i18n.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleHistory, historyDescription } from '../src/v2/member-admin/history.js';
import { groupRiskAlerts } from '../src/v2/member-admin/risk-view.js';

test('risk rules sharing a category appear once while retaining every actionable rule', () => {
  const groups = groupRiskAlerts([
    { id: 'low-inventory', type: 'inventory_value', state: 'read', observedAt: '2026-09-22T10:00:00Z' },
    { id: 'private-inventory', type: 'private_inventory', state: 'unread', observedAt: '2026-09-23T09:00:00Z' },
    { id: 'low-hours', type: 'playtime_hours', state: 'done', observedAt: null }
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].type, 'inventory');
  assert.deepEqual(groups[0].alerts.map(alert => alert.id), ['low-inventory', 'private-inventory']);
  assert.equal(groups[0].latest.id, 'private-inventory');
  assert.equal(groups[0].unread, 1);
});

test('member history omits legacy no-op moves and describes cleared fields', () => {
  setUiLocale('zh');
  const rows = visibleHistory([
    { seq: 3, action: 'member.moveMany', actorId: 'admin', createdAt: '2026-09-23T10:00:00Z', payload: { reason: '管理员确认批量调整小队' } },
    { seq: 2, action: 'member.edit:m1', actorId: 'admin', createdAt: '2026-09-22T10:00:00Z', payload: { before: { customName: 'A', notes: 'old' }, after: { customName: '', notes: '' } } },
    { seq: 1, action: 'member.moveMany', actorId: 'admin', createdAt: '2026-09-21T10:00:00Z', payload: { fromSquadId: null, toSquadId: 's1' }, toSquadName: 'CN' }
  ]);
  assert.deepEqual(rows.map(row => row.seq), [2, 1]);
  assert.deepEqual(historyDescription(rows[0]), { title: '编辑成员资料', detail: '清空: 站内名称, 内部备注' });
  assert.deepEqual(historyDescription(rows[1]), { title: '调整队伍', detail: '未分队 → CN' });
});
