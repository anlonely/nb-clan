import test from 'node:test';
import assert from 'node:assert/strict';
import { realtimeScopeLabel } from '../server/v2/realtime/service.js';

test('unassigned relay scope displays the reported account and server names', () => {
  const scope = { source: 'account-1', sourceName: 'Collector', label: '未分配 · Atlas - US 2X Monthly', resource: { kind: 'system', id: 'relay_unassigned' } };
  assert.equal(realtimeScopeLabel(scope), 'Collector · Atlas - US 2X Monthly');
  assert.equal(realtimeScopeLabel({ ...scope, sourceName: null }), 'account-1 · Atlas - US 2X Monthly');
  assert.equal(realtimeScopeLabel({ ...scope, resource: { kind: 'squad', id: 'squad-1' } }), scope.label);
});
