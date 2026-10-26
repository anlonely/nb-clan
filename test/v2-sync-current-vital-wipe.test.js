import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './support/v2-sync-center/fixture.mjs';

const operation = () => ({ operationId: randomUUID() });
const current = { kind: 'current_wipe' };
function setup(t) {
  let time = Date.parse('2026-10-26T12:00:00Z');
  const f = fixture({ now: () => time });
  t.after(() => f.close());
  f.advance = ms => { time += ms; };
  f.putWipe = row => f.repo.put('schedulingWipes', row);
  f.wipe = { ...f.repo.get('schedulingWipes', 'fixture-wipe'), serverProfileId: '19',
    serverSnapshot: { provider: 'vital', kdaProvider: 'vital', vitalServerId: '19', vitalWipeId: 'period-current' },
    audience: { allMembers: true, memberIds: [], squadIds: [], includeUnassigned: true } };
  f.putWipe(f.wipe);
  f.resolve = (type = 'kda', scope = current) => f.service.resolve(f.actor(), type, scope);
  return f;
}
const atlas = (base, id = 'atlas-wipe') => ({ ...base, id, serverProfileId: 'atlas-eu-2x-monthly',
  musterAt: '2026-10-22T16:00:00Z', serverSnapshot: { provider: 'atlas', kdaProvider: 'manual' } });

test('hourly dynamic KDA selects Vital among Atlas wipes and includes every member without signup', async t => {
  const f = setup(t);
  // Non-Vital candidates precede Vital chronologically, so filter before LIMIT 2.
  f.putWipe(atlas(f.wipe));
  f.putWipe({ ...atlas(f.wipe, 'atlas-scheduled'), lifecycle: 'scheduled' });
  const selected = f.resolve();
  const members = f.repo.all('members').map(row => row.id).sort();
  assert.equal(selected.scope.wipeId, f.wipe.id);
  assert.deepEqual(selected.targets.map(row => row.memberId).sort(), members);
  assert.equal(f.db.prepare("SELECT count(*) n FROM json_records WHERE collection='v2Signups'").get().n, 0);
  const { rule } = await f.service.saveRule(f.actor(), null, { expectedRevision: 0, name: 'Hourly current Vital',
    type: 'kda', scope: current, intervalMinutes: 60, enabled: true }, operation());
  assert.deepEqual(rule.scope, current);
  f.advance(3600001);
  const [run] = await f.service.tick();
  const job = f.service.job(run.job.id);
  assert.equal(job.trigger, 'auto');
  assert.equal(job.scope.wipeId, f.wipe.id);
  assert.deepEqual(job.items.map(row => row.memberId).sort(), members);
  assert.equal(f.service.repo.get('rule', rule.id).enabled, true);
  for (const _member of members) { await f.worker.step(); f.advance(1001); }
  assert.equal(f.service.detail(f.actor(), job.id).counts.succeeded, members.length);

  f.putWipe({ ...f.wipe, lifecycle: 'ended' });
  const next = { ...f.wipe, id: 'next-vital-wipe', musterAt: '2026-10-29T17:00:00Z' };
  f.putWipe(next);
  f.repo.put('members', { ...f.repo.all('members')[0], id: 'new-unregistered-member', steamId: '76561198000000999' });
  f.advance(3600001);
  const [nextRun] = await f.service.tick();
  const nextJob = f.service.job(nextRun.job.id);
  assert.equal(nextJob.scope.wipeId, next.id);
  assert.ok(nextJob.items.some(row => row.memberId === 'new-unregistered-member'));
  assert.equal(nextJob.items.length, members.length + 1);
});

test('multiple Vital candidates still fail explicitly; other sync types and explicit scopes retain their selection', t => {
  const f = setup(t);
  const second = { ...f.wipe, id: 'another-vital', lifecycle: 'scheduled', musterAt: '2026-10-29T17:00:00Z' };
  f.putWipe(second);
  assert.throws(() => f.resolve(), { errorCode: 'SYNC_WIPE_SELECTION_REQUIRED' });
  f.db.prepare("DELETE FROM json_records WHERE collection='v2Wipes' AND id=?").run(second.id);
  f.putWipe(atlas(f.wipe));
  assert.throws(() => f.resolve('battlemetrics_playtime'), { errorCode: 'SYNC_WIPE_SELECTION_REQUIRED' });
  assert.equal(f.resolve('kda', { kind: 'current_wipe', id: f.wipe.id }).scope.wipeId, f.wipe.id);
  assert.equal(f.resolve('battlemetrics_playtime', { kind: 'current_wipe', id: 'atlas-wipe' }).scope.wipeId, 'atlas-wipe');
  f.putWipe({ ...f.wipe, lifecycle: 'ended' });
  assert.throws(() => f.resolve(), { errorCode: 'SYNC_WIPE_REQUIRED' });
});

test('dynamic Vital collection honors frozen metadata precedence and legacy source hints', t => {
  const f = setup(t);
  const base = { ...f.wipe, serverSnapshot: undefined };
  for (const metadata of [
    { serverSnapshot: { provider: ' VITAL ' } },
    { serverSnapshot: { serverProvider: 'vital' } },
    { provider: 'vital' },
    { serverSnapshot: { kdaProvider: 'vital' } },
    { vitalServerId: '19' },
    { legacyRaw: { kdaProvider: 'vital', vitalServerId: '19' } }
  ]) {
    f.putWipe({ ...base, ...metadata });
    assert.equal(f.resolve().scope.wipeId, base.id, JSON.stringify(metadata));
  }
  for (const metadata of [
    {},
    { serverSnapshot: { provider: 'atlas', kdaProvider: 'vital', vitalServerId: '19' } },
    { serverSnapshot: { provider: 'moose' }, provider: 'vital' },
    { serverSnapshot: { kdaProvider: 'manual', vitalServerId: '19' } },
    { serverSnapshot: { kdaProvider: 'none' }, legacyRaw: { kdaProvider: 'vital', vitalServerId: '19' } }
  ]) {
    f.putWipe({ ...base, ...metadata });
    assert.throws(() => f.resolve(), { errorCode: 'SYNC_WIPE_REQUIRED' }, JSON.stringify(metadata));
  }
});

test('saving a recovered rule clears its stale error only after scope validation succeeds', async t => {
  const f = setup(t);
  const input = { expectedRevision: 0, name: 'Hourly current Vital', type: 'kda', scope: current,
    intervalMinutes: 60, enabled: true };
  const { rule } = await f.service.saveRule(f.actor(), null, input, operation());
  const second = { ...f.wipe, id: 'ambiguous-vital', lifecycle: 'scheduled' };
  f.putWipe(second);
  f.advance(3600001);
  assert.deepEqual(await f.service.tick(), []);
  const failed = f.service.repo.get('rule', rule.id);
  assert.equal(failed.enabled, false);
  assert.equal(failed.errorCode, 'SYNC_WIPE_SELECTION_REQUIRED');
  await assert.rejects(f.service.saveRule(f.actor(), rule.id, { ...input, expectedRevision: failed.revision }, operation()),
    { errorCode: 'SYNC_WIPE_SELECTION_REQUIRED' });
  assert.deepEqual(f.service.repo.get('rule', rule.id), failed);
  f.putWipe({ ...second, lifecycle: 'ended' });
  f.putWipe(atlas(f.wipe));
  const { rule: recovered } = await f.service.saveRule(f.actor(), rule.id,
    { ...input, expectedRevision: failed.revision }, operation());
  assert.equal(recovered.enabled, true);
  assert.equal(recovered.errorCode, null);
  assert.deepEqual(recovered.scope, current);
  assert.equal(recovered.nextRunAt, f.service.now() + 3600000);
});
