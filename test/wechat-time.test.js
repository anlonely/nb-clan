import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { formatUtc8DateWeekTime } = require('../wechat-miniprogram/miniprogram/utils/time.js');

test('wechat wipe time uses 24-hour UTC+8 display at midnight', () => {
  const result = formatUtc8DateWeekTime('2026-07-30T16:00:00.000Z');

  assert.deepEqual(result, {
    dateText: '2026-07-31 星期五',
    timeText: '00:00:00'
  });
});

test('wechat wipe time keeps noon and evening in 24-hour format', () => {
  assert.equal(
    formatUtc8DateWeekTime('2026-07-31T04:00:00.000Z').timeText,
    '12:00:00'
  );
  assert.equal(
    formatUtc8DateWeekTime('2026-07-31T15:59:59.000Z').timeText,
    '23:59:59'
  );
});
