import test from 'node:test';
import assert from 'node:assert/strict';
import { probe } from './support/v2-g07-migration-audit/probe.mjs';
test('diagnostic migration comparisons execute against actual services; deny remains enforced', async () => {
  const result = await probe();
  assert.equal(result.observations.length, 7);
  assert.equal(result.sqliteClosed, true); assert.equal(result.externalRequests, 0);
  assert.equal(result.observations.find(x => x.id === 'P01-explicit-deny-scope').ownSquadDenied, true);
  // The six difference results are recorded in probe-report.json; a passing diagnostic
  // run means reproducible observation, never that compatibility has been accepted.
});
