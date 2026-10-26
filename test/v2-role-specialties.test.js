import { setUiLocale } from '../src/v2/i18n.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { installPlatformAdminSchema, PlatformAdminRepository } from '../server/v2/platform-admin/repository.js';
import { normalizeConfig } from '../server/v2/platform-admin/model.js';
import { applyRoleSpecialties } from '../server/v2/identity/role-specialties.js';
import { visibleHistory, historyDescription } from '../src/v2/member-admin/history.js';
import { fixture } from './support/v2-member-admin/fixtures.mjs';

test('platform role mappings default to empty and validate one role per rule', () => {
  const config = normalizeConfig('kook', { enabled: true, targets: [], commands: [] });
  assert.deepEqual(config.roleSpecialtyMappings, []);
  assert.deepEqual(normalizeConfig('kook', { ...config, roleSpecialtyMappings: [
    { id: 'rule_1', roleName: 'RSC·管道工', specialty: 'pipe' },
    { id: 'rule_2', roleName: 'RSG·枪男', specialty: 'gunman' }
  ] }).roleSpecialtyMappings.map(rule => rule.specialty), ['pipe', 'gunman']);
  assert.throws(() => normalizeConfig('kook', { ...config, roleSpecialtyMappings: [{ id: 'bad', roleName: '', specialty: 'pipe' }] }));
});

test('successful guild role evidence updates mapped values and preserves manually set specialties', () => {
  const db = new DatabaseSync(':memory:');
  try {
    installPlatformAdminSchema(db);
    const platform = new PlatformAdminRepository(db);
    platform.put('config', 'kook', 'kook', 'admin', 1, { roleSpecialtyMappings: [
      { id: 'rule_1', roleName: 'RSC·管道工', specialty: 'pipe' },
      { id: 'rule_2', roleName: 'RSG·枪男', specialty: 'gunman' }
    ] });
    let member = { id: 'm1', specialty: ['building'], revision: 1 };
    const repo = { db, put(_name, next) { member = next; } };
    const evidence = roles => ({ provider: 'kook', guildId: 'guild', community: { available: true, roles } });
    applyRoleSpecialties(repo, member, evidence([{ name: 'RSC·管道工' }, { name: 'RSG·枪男' }]), () => 1);
    assert.deepEqual(member.specialty, ['building', 'pipe', 'gunman']);
    applyRoleSpecialties(repo, member, evidence([{ name: 'RSG·枪男' }]), () => 2);
    assert.deepEqual(member.specialty, ['building', 'gunman']);
    applyRoleSpecialties(repo, member, { ...evidence([]), community: { available: false } }, () => 3);
    assert.deepEqual(member.specialty, ['building', 'gunman']);
  } finally { db.close(); }
});

test('old paired movement records render once with names instead of internal IDs', () => {
  setUiLocale('zh');
  const rows = [
    { seq: 2, action: 'member.moveMany', actorId: 'user_1', actorName: '管理员甲', createdAt: '2026-09-23T04:40:43Z', payload: { reason: '管理员确认批量调整小队' } },
    { seq: 1, action: 'member.moveMany', actorId: 'user_1', actorName: '管理员甲', createdAt: '2026-09-23T04:40:43Z', toSquadName: '先锋一队', payload: { fromSquadId: null, toSquadId: 'squad_1' } }
  ];
  const shown = visibleHistory(rows);
  assert.equal(shown.length, 1);
  assert.deepEqual(historyDescription(shown[0]), { title: '调整队伍', detail: '未分队 → 先锋一队' });
  assert.deepEqual(historyDescription({ action: 'member.moveMany', payload: { reason: '管理员确认批量调整小队' } }),
    { title: '确认队伍归属', detail: '成员归属未变更' });
  assert.deepEqual(historyDescription({ action: 'member.edit:m1', payload: { before: { customName: '旧名' }, after: { customName: '新名' } } }),
    { title: '编辑成员资料', detail: '更新: 站内名称' });
});

test('member history returns newest first with resolved squad names and no duplicate new move event', t => {
  setUiLocale('zh');
  const x = fixture({}); t.after(() => x.db.close());
  const account = x.ir.get('accounts', 'admin');
  x.ir.put('accounts', { ...account, roleId: 'admin', adminAssignedByOwner: true });
  const actor = x.actor('admin');
  x.service.moveMany(actor, { targets: [{ id: 'm001', expectedRevision: 1 }], squadId: 's2' }, 'operation_12345678');
  const page = x.service.audit(actor, 'member', 'm001', { before: '0' });
  assert.equal(page.items.filter(row => row.action === 'member.moveMany').length, 1);
  assert.equal(page.items[0].action, 'member.moveMany');
  assert.equal(page.items[0].fromSquadName, '先锋一队');
  assert.equal(page.items[0].toSquadName, '后勤二队');
  assert.equal(page.items[0].payload.reason, '管理员确认批量调整队伍');
  assert.deepEqual(historyDescription(page.items[0]), { title: '调整队伍', detail: '先锋一队 → 后勤二队' });
});
