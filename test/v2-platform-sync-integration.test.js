import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/v2-sync-center/fixture.mjs';
import { createPublishedPlatformAdapters } from '../server/v2/platform-admin/published-services.js';

test('platform sync result references the real durable sync job and preserves replay', async t => {
  const f = fixture();
  t.after(() => f.close());
  const { platform } = createPublishedPlatformAdapters({ identity: f.identity, sync: f.service });
  const args = { actor: f.actor(), input: { type: 'kda', scope: { kind: 'members', memberIds: ['g05_alpha'] } },
    operationId: 'platform-sync-integration', assertCurrent: () => f.actor() };
  const first = await platform.sync.request(args), replay = await platform.sync.request(args);
  assert.deepEqual(first, replay);
  assert.notEqual(first.reference, args.operationId);
  const job = f.service.detail(f.actor(), first.reference);
  assert.equal(first.items[0].id, job.id);
  assert.equal(first.items[0].status, job.status);
  assert.equal(job.counts.total, 1);
});
