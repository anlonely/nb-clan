import test from 'node:test';
import assert from 'node:assert/strict';
import { activeVitalVipType, isVitalVipActive } from '../src/shared/member/vip.js';

const nowMs = Date.parse('2026-08-06T00:00:00+08:00');

test('expired no-queue VIP is hidden from display and avatar state', () => {
  const member = {
    vitalVipType: 'queue_skip',
    vitalVipPurchasedAt: '2026-06-16',
    vitalVipExpiresAt: '2026-07-14'
  };

  assert.equal(isVitalVipActive(member, nowMs), false);
  assert.equal(activeVitalVipType(member, nowMs), 'none');
});

test('VIP remains active through its expiry date', () => {
  const member = {
    vitalVipType: 'queue_skip',
    vitalVipPurchasedAt: '2026-06-16',
    vitalVipExpiresAt: '2026-08-06'
  };

  assert.equal(isVitalVipActive(member, nowMs), true);
  assert.equal(activeVitalVipType(member, nowMs), 'queue_skip');
});

test('server active flag is honored when available', () => {
  const member = {
    vitalVipType: 'queue_skip',
    vitalVip: { type: 'queue_skip', active: false },
    vitalVipExpiresAt: '2099-07-14'
  };

  assert.equal(activeVitalVipType(member, nowMs), 'none');
});
