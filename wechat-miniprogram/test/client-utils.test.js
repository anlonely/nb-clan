const test = require('node:test');
const assert = require('node:assert/strict');

const {
  canViewPrivateMemberFields,
  compactDetailSections,
  hasDisplayValue,
  privateDetailRow
} = require('../miniprogram/utils/member-privacy');
const { addDaysDate, todayUtc8Date } = require('../miniprogram/utils/time');
const { isActiveVip, vipState } = require('../miniprogram/utils/vip');

test('VIP 有效性只认 active 且未 expired', () => {
  assert.equal(isActiveVip({ active: true, expired: false }), true);
  assert.equal(isActiveVip({ active: true }), true);
  assert.equal(isActiveVip({ active: true, expired: true }), false);
  assert.equal(isActiveVip({ active: false, expired: false }), false);

  assert.equal(vipState({ vitalVipType: 'priority', vitalVip: {} }).active, false);
  const staleActiveState = vipState({
    vitalVipType: 'priority',
    vitalVipExpiresAt: '2000-01-01',
    vitalVip: { active: true, expired: false }
  });
  assert.equal(staleActiveState.active, false);
  assert.equal(staleActiveState.expired, true);
});

test('各 VIP provider 独立读取各自状态', () => {
  const member = {
    vitalVipType: 'priority',
    vitalVip: { active: false, expired: false },
    rustinityVipType: 'queue_skip',
    rustinityVip: { active: true, expired: false },
    atlasVipType: 'priority',
    atlasVip: { active: true, expired: true }
  };

  assert.equal(vipState(member, { mode: 'vital' }).active, false);
  assert.equal(vipState(member, { mode: 'rustinity' }).active, true);
  assert.equal(vipState(member, { mode: 'atlas' }).active, false);
  assert.equal(vipState(member, { mode: 'atlas' }).expired, true);
});

test('过期 VIP 不生成任何展示内容', () => {
  const state = vipState({
    vitalVipType: 'queue_skip',
    vitalVipPurchasedAt: '2026-01-01',
    vitalVipExpiresAt: '2026-01-29',
    vitalVip: { type: 'queue_skip', active: false, expired: true }
  });

  assert.equal(state.active, false);
  assert.equal(state.visible, false);
  assert.equal(state.label, '');
  assert.equal(state.text, '');
  assert.equal(state.summary, '');
  assert.equal(state.expiresText, '');
  assert.equal(state.badgeText, '');
  assert.equal(state.className, 'none');
  assert.equal(state.valueClass, '');
});

test('VIP 到期日已过时即使上游仍标 active 也不展示', () => {
  const state = vipState({
    vitalVipType: 'priority',
    vitalVipExpiresAt: '2000-01-01',
    vitalVip: { type: 'priority', active: true, expired: false }
  });

  assert.equal(state.active, false);
  assert.equal(state.expired, true);
  assert.equal(state.visible, false);
});

test('VIP 到期日按 UTC+8 自然日判断', () => {
  const today = todayUtc8Date();
  const activeVip = { type: 'priority', active: true, expired: false };
  const stateFor = (expiresAt) => vipState({
    vitalVipType: 'priority',
    vitalVipExpiresAt: expiresAt,
    vitalVip: activeVip
  });

  assert.equal(stateFor(addDaysDate(today, -1)).active, false);
  assert.equal(stateFor(today).active, true);
  assert.equal(stateFor(addDaysDate(today, 1)).active, true);
});

test('脱敏 DTO 不伪造 VIP 日期缺失提示', () => {
  const safeState = vipState({
    vitalVipType: 'priority',
    vitalVip: { type: 'priority', active: true, expired: false }
  });
  const ownState = vipState({
    vitalVipType: 'priority',
    vitalVipPurchasedAt: '',
    vitalVipExpiresAt: '',
    vitalVip: { type: 'priority', active: true, expired: false }
  });

  assert.equal(safeState.text, '优先队列');
  assert.equal(safeState.expiresText, '');
  assert.equal(ownState.text, '优先队列 · 到期未更新');
});

test('私密字段仅对管理角色或真实值开放', () => {
  const row = { key: 'phone', label: '电话', value: '-' };
  assert.equal(canViewPrivateMemberFields({ role: 'member' }), false);
  assert.equal(canViewPrivateMemberFields({ role: 'admin' }), true);
  assert.equal(canViewPrivateMemberFields({ role: 'member_manager' }), true);
  assert.equal(canViewPrivateMemberFields({ role: 'member' }, { role: 'admin' }), false);
  assert.equal(canViewPrivateMemberFields({ role: 'member' }, { canManage: true }), true);
  assert.equal(privateDetailRow(false, '', row), null);
  assert.equal(privateDetailRow(false, '13800000000', row), row);
  assert.equal(privateDetailRow(true, '', row), row);
});

test('空私密章节被移除，公开章节保留', () => {
  const sections = compactDetailSections([
    { title: '联系方式', rows: [null, null] },
    { title: '基础信息', rows: [{ key: 'steamId', value: '7656' }, null] }
  ]);

  assert.deepEqual(sections, [
    { title: '基础信息', rows: [{ key: 'steamId', value: '7656' }] }
  ]);
  assert.equal(hasDisplayValue(['', null, 'value']), true);
  assert.equal(hasDisplayValue(['', null]), false);
});
