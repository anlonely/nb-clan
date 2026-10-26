import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/v2-member-followups/fixture.mjs';

test('real G03/CSRF member creation HTTP -> original outbox -> canonical automatic source writes', async t => {
  const f = await fixture(); t.after(() => f.close());
  const url = f.origin + '/api/v2/member-admin/members', body = { steamInput: '76561198999999191', fields: { customName: 'HTTP 录入成员' } };
  let response = await fetch(url, { method: 'POST', headers: { Origin: f.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 401); assert.equal(f.jobs().length, 0);
  const headers = f.headers();
  response = await fetch(url, { method: 'POST', headers: { ...headers, 'X-CSRF-Token': 'wrong' }, body: JSON.stringify(body) });
  assert.equal(response.status, 403); assert.equal(f.latestSeq(), null);
  response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) }); assert.equal(response.status, 200);
  const created = (await response.json()).data;
  assert.equal(f.jobs().length, 0); assert.equal(f.calls.length, 0); assert.equal(f.db.isTransaction, false);
  await f.consumer.drain(); await f.drain();
  assert.equal(f.ir.get('members', created.id).steamNickname, 'Loopback 已采集昵称');
  assert.equal(f.jobs().filter(j => j.items.some(i => i.memberId === created.id)).length, 2);
  response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) }); assert.equal(response.status, 200);
  assert.equal((await response.json()).data.replayed, true); assert.equal(f.latestSeq(), 1);
  assert.equal((await f.consumer.drain()).processed, 0); assert.equal(f.jobs().length, 2);
});

test('retired review HTTP cannot approve a member or enqueue source collection', async t => {
  const f = await fixture(); t.after(() => f.close());
  const before = f.members.repo.get('joinApplications', 'review1');
  const response = await fetch(f.origin + '/api/v2/member-admin/reviews/review1', { method: 'POST', headers: f.headers(),
    body: JSON.stringify({ expectedRevision: 1, status: 'approved', reason: '隔离 HTTP 审核' }) });
  assert.equal(response.status, 410);
  assert.deepEqual(f.members.repo.get('joinApplications', 'review1'), before);
  await f.consumer.drain(); await f.drain();
  assert.equal(f.jobs().length, 0);
});
