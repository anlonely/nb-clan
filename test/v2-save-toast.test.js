import test from 'node:test';
import assert from 'node:assert/strict';
import { createToastStore } from '../src/v2/toast-store.js';

test('save feedback expires after three seconds, deduplicates receipts and clears across identities', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = createToastStore();
  store.show('资料已保存', { id: 'receipt-1' });
  store.show('资料已保存', { id: 'receipt-1' });
  assert.equal(store.getSnapshot().length, 1);
  t.mock.timers.tick(2999); assert.equal(store.getSnapshot().length, 1);
  t.mock.timers.tick(1); assert.deepEqual(store.getSnapshot(), []);
  store.show('资料已保存', { id: 'receipt-1' }); assert.deepEqual(store.getSnapshot(), []);
  store.show('配置已保存', { id: 'receipt-2' });
  store.clear(); assert.deepEqual(store.getSnapshot(), []);
  store.show('资料已保存', { id: 'receipt-1' }); assert.equal(store.getSnapshot().length, 1);
});

test('consecutive saves have independent timers and can be dismissed without hiding newer feedback', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = createToastStore();
  store.show('A'); t.mock.timers.tick(1000);
  const second = store.show('B'); t.mock.timers.tick(2000);
  assert.deepEqual(store.getSnapshot().map(item => item.message), ['B']);
  store.dismiss(second); assert.deepEqual(store.getSnapshot(), []);
  for (const message of ['C','D','E','F']) store.show(message);
  assert.deepEqual(store.getSnapshot().map(item => item.message), ['D','E','F']);
  t.mock.timers.tick(3000); assert.deepEqual(store.getSnapshot(), []);
});
