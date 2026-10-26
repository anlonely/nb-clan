import assert from 'node:assert/strict';
import test from 'node:test';
import { managedWipeOptionForForm } from '../src/shared/wipes.js';

const options = [
  { type: 'current', startedAt: '2026-07-30T15:59:00.000Z' },
  { type: 'next', startedAt: '2026-08-06T18:00:00.000Z' }
];

test('managed Wipe option keeps valid choices and repairs legacy all for a future Wipe', () => {
  const now = Date.parse('2026-08-06T08:00:00.000Z');

  assert.equal(managedWipeOptionForForm(options, {
    wipeMode: 'current',
    startedAt: '2026-07-30T15:59:00.000Z'
  }, now)?.type, 'current');
  assert.equal(managedWipeOptionForForm(options, {
    wipeMode: 'next',
    startedAt: '2026-08-06T18:00:00.000Z'
  }, now)?.type, 'next');
  assert.equal(managedWipeOptionForForm(options, {
    wipeMode: 'all',
    startedAt: '2026-08-06T18:00:00.000Z'
  }, now)?.type, 'next');
  assert.equal(managedWipeOptionForForm(options, {
    wipeMode: 'all',
    startedAt: '2026-07-30T15:59:00.000Z'
  }, now)?.type, 'current');
  assert.equal(managedWipeOptionForForm(options, {
    wipeMode: 'archived',
    startedAt: '2026-08-06T18:00:00.000Z'
  }, now)?.type, 'next');
  assert.equal(managedWipeOptionForForm(options, {
    wipeMode: '',
    startedAt: '2026-08-06T08:00:00.000Z'
  }, now)?.type, 'current');
});
