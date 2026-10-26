import test from 'node:test';
import assert from 'node:assert/strict';
import { vipSnapshot, vipDate, vipType } from '../server/v2/vip-notifications/model.js';

const member = { id: 'constructed-member', vitalVipType: 'priority', vitalVipPurchasedAt: '2030-08-11', vitalVipExpiresAt: '2030-09-08' };
const at = value => Date.parse(value);
test('legacy fixed 0..3 UTC-day window also respects UTC+8 expiry day', () => {
  assert.equal(vipSnapshot(member, 'vital', at('2030-09-04T23:59:59Z')).due, false);
  assert.equal(vipSnapshot(member, 'vital', at('2030-09-05T00:00:00Z')).due, true);
  assert.equal(vipSnapshot(member, 'vital', at('2030-09-08T15:59:59Z')).due, true);
  assert.equal(vipSnapshot(member, 'vital', at('2030-09-08T16:00:00Z')).due, false);
  assert.equal(vipSnapshot(member, 'vital', at('2030-09-09T00:00:00Z')).expired, true);
});
test('all three source models keep their actual type allowlists and 28-day fallback', () => {
  const now = at('2030-09-05T00:00:00Z');
  assert.equal(vipType('vital', 'vip'), 'priority'); assert.equal(vipType('atlas', 'atlas_vip'), 'priority');
  assert.equal(vipType('rustinity', 'vip'), 'queue_skip'); assert.equal(vipType('rustinity', 'priority'), 'none');
  const purchase = vipSnapshot({ id: 'x', atlasVipType: 'priority', atlasVipPurchasedAt: '2030-08-11' }, 'atlas', now);
  assert.equal(purchase.expiresAt, '2030-09-08');
  const expiry = vipSnapshot({ id: 'x', rustinityVipType: 'queue_skip', rustinityVipExpiresAt: '2030-09-08' }, 'rustinity', now);
  assert.equal(expiry.purchasedAt, '2030-08-11'); assert.equal(expiry.due, true);
});
test('legacy sent marker and stable expiry key suppress same-period type/recipient churn, renewal has a new key', () => {
  const now = at('2030-09-05T00:00:00Z'), initial = vipSnapshot(member, 'vital', now);
  assert.equal(vipSnapshot({ ...member, vitalVipReminderExpiresAt: '2030/9/8' }, 'vital', now).legacySent, true);
  const changed = vipSnapshot({ ...member, vitalVipType: 'queue_skip', discordId: 'changed' }, 'vital', now);
  assert.equal(changed.periodKey, initial.periodKey); assert.notEqual(changed.fingerprint, initial.fingerprint);
  const renewal = vipSnapshot({ ...member, vitalVipExpiresAt: '2030-10-06' }, 'vital', now);
  assert.notEqual(renewal.periodKey, initial.periodKey); assert.equal(renewal.due, false);
});
test('date normalization rejects invalid calendar values and handles leap days deterministically', () => {
  const now = at('2030-01-01T00:00:00Z');
  assert.equal(vipDate('2030-02-30', now), ''); assert.equal(vipDate('2032/2/29', now), '2032-02-29');
  assert.equal(vipDate('02/29', now), ''); assert.equal(vipDate('9/8', now), '2030-09-08');
  assert.equal(vipSnapshot({ id: 'x', vitalVipType: 'priority' }, 'vital', now).due, false);
});
