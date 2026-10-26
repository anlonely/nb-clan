import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './support/v2-sync-center/fixture.mjs';
import { TYPES, RETIRED_TYPES, supportedType } from '../server/v2/sync-center/model.js';

for (const type of ['hexaytron_profile', 'local_consistency']) {
  test(`${type} remains catalogued as historical data and cannot admit new sync work`, async t => {
    const f = fixture(); t.after(() => f.close());
    assert.ok(RETIRED_TYPES.includes(type)); assert.equal(supportedType(type), false);
    const before = f.db.prepare('SELECT total_changes() n').get().n;
    await assert.rejects(f.service.request(f.actor(), { type, scope: { kind: 'members', memberIds: ['g05_alpha'] } }, { operationId: randomUUID() }), { errorCode: 'SYNC_TYPE_RETIRED', status: 410 });
    await assert.rejects(f.service.saveSource(f.actor(), TYPES[type], { expectedRevision: 1, minIntervalMs: 0 }, { operationId: randomUUID() }), { errorCode: 'SYNC_TYPE_RETIRED', status: 410 });
    assert.equal(f.db.prepare('SELECT total_changes() n').get().n, before);
    assert.deepEqual(f.calls, []); assert.deepEqual(f.commits, []);
    assert.equal(f.service.sources(f.actor()).types.some(item => item.id === type), false);
  });
  test(`${type} retirement fences persisted rules and pending jobs without deleting history`, async t => {
    const f = fixture(); t.after(() => f.close());
    const { job } = await f.service.request(f.actor(), { type: 'kda', scope: { kind: 'members', memberIds: ['g05_alpha'] } }, { operationId: randomUUID() });
    const row = f.service.job(job.id); f.service.repo.put('job', { ...row, type, source: TYPES[type] });
    f.service.repo.put('rule', { id: `retired-${type}`, type, enabled: true, revision: 1, scope: row.scope });
    f.service.retireTypes();
    assert.equal(f.service.job(job.id).status, 'cancelled');
    assert.equal(f.service.job(job.id).reason, 'SYNC_TYPE_RETIRED');
    const rule = f.service.repo.get('rule', `retired-${type}`); assert.equal(rule.enabled, false); assert.equal(rule.deleted, true);
    for (const action of ['retry', 'continue', 'recover']) await assert.rejects(f.service.action(f.actor(), job.id, action, { expectedRevision: f.service.job(job.id).revision }, { operationId: randomUUID() }), { errorCode: 'SYNC_TYPE_RETIRED' });
    assert.equal(await f.worker.step(), null); assert.deepEqual(f.calls, []); assert.deepEqual(f.commits, []);
    assert.ok(f.service.detail(f.actor(), job.id));
  });
}
