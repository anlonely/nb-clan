const assert = require('node:assert/strict');
const test = require('node:test');
const {
  managedWipeOptionIndex,
  managedWipeOptionLabel
} = require('../miniprogram/utils/wipe-options');

const options = [
  { id: 'current', type: 'current', startedAt: '2026-07-30T15:59:00.000Z' },
  { id: 'next', type: 'next', startedAt: '2026-08-06T18:00:00.000Z' }
];

test('WeChat Wipe forms default new records to next and preserve existing modes', () => {
  assert.equal(managedWipeOptionIndex(options, {}, { preferNext: true }), 1);
  assert.equal(managedWipeOptionIndex(options, { wipeMode: 'current' }, { preferNext: true }), 0);
  assert.equal(managedWipeOptionIndex(options, { wipeMode: 'next' }), 1);
  assert.equal(managedWipeOptionIndex(options, {
    wipeMode: 'all',
    startedAt: '2026-08-06T18:00:00.000Z'
  }, { nowMs: Date.parse('2026-08-06T08:00:00.000Z') }), 1);
});

test('WeChat Wipe labels use China time with the full year', () => {
  assert.equal(managedWipeOptionLabel(options[0]), '当前 · 2026-07-30 23:59');
  assert.equal(managedWipeOptionLabel(options[1]), '下一个 Wipe · 2026-08-07 02:00');
});
