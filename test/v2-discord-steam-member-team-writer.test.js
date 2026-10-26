import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { IdentityRepository, installIdentitySchema } from '../server/v2/identity/repository.js';
import { installMemberAdminSchema } from '../server/v2/member-admin/repository.js';
import { createDiscordSteamMemberTeamWriter } from '../server/v2/discord-steam-links/member-team-writer.js';

function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  installIdentitySchema(db); installMemberAdminSchema(db);
  const repo = new IdentityRepository(db), store = { members: [{ id: 'unrelated', customName: 'Keep me' }], squadMembers: [] };
  const calls = []; let tail = Promise.resolve(), queued = false, patchCalls = 0;
  const queue = task => {
    const operation = tail.then(async () => { assert.equal(queued, false); queued = true; calls.push('queue:begin');
      try { return await task(); } finally { queued = false; calls.push('queue:end'); } });
    tail = operation.catch(() => {}); return operation;
  };
  const patch = async mutator => {
    patchCalls++; assert.equal(queued, true); assert.equal(db.isTransaction, false);
    calls.push('cache'); await options.beforePatch?.({ store, repo, patchCalls }); mutator(store);
  };
  const writer = createDiscordSteamMemberTeamWriter({ identity: { repo }, runStoreWriteTask: queue, patchStoreCache: patch });
  let seq = 0;
  const outbox = changes => db.prepare('INSERT INTO v2_member_admin_outbox(operation_id,payload,created_at) VALUES(?,?,?)')
    .run(`fixture-${++seq}`, JSON.stringify({ schemaVersion: 1, actorId: 'fixture', events: [], changes }), '2026-10-15T00:00:00Z');
  const commit = (changes, work = () => {}) => repo.transaction(() => {
    calls.push('write'); work();
    for (const change of changes) {
      if (change.record) repo.put(change.collection, change.record);
      else if (change.deleted) repo.remove(change.collection, change.id);
    }
    outbox(changes); return { content: 'Steam link saved', changes: undefined };
  });
  return { db, repo, store, writer, queue, commit, outbox, calls, patchCalls: () => patchCalls };
}
test('committed website changes refresh from DB inside the shared queue and preserve unrelated cache rows', async t => {
  const f = fixture(t);
  const changes = [{ collection: 'members', id: 'm', record: { id: 'm', steamId: '', customName: 'Discord member' } },
    { collection: 'squadMembers', id: 'sm', record: { id: 'sm', memberId: 'm', squadId: 'cn' } }];
  const result = await f.writer(() => f.commit(changes));
  assert.equal(result.content, 'Steam link saved');
  assert.deepEqual(f.store.members.find(row => row.id === 'm'), f.repo.get('members', 'm'));
  assert.deepEqual(f.store.members.find(row => row.id === 'unrelated'), { id: 'unrelated', customName: 'Keep me' });
  assert.deepEqual(f.store.squadMembers, [f.repo.get('squadMembers', 'sm')]);
  assert.deepEqual(f.calls, ['queue:begin', 'write', 'cache', 'queue:end']);
});
test('rollback and rolled-back savepoint rows never contaminate the cache', async t => {
  const f = fixture(t), before = structuredClone(f.store), failure = new Error('rolled back');
  await assert.rejects(f.writer(() => f.repo.transaction(() => {
    f.repo.put('members', { id: 'bad' }); f.outbox([{ collection: 'members', id: 'bad' }]); throw failure;
  })), error => error === failure);
  assert.equal(f.patchCalls(), 0); assert.deepEqual(f.store, before); assert.equal(f.repo.get('members', 'bad'), null);
  await f.writer(() => f.repo.transaction(() => {
    f.repo.setScalar('savedBotLink', true); f.db.exec('SAVEPOINT website');
    f.repo.put('members', { id: 'bad' }); f.outbox([{ collection: 'members', id: 'bad' }]);
    f.db.exec('ROLLBACK TO website'); f.db.exec('RELEASE website'); return { saved: true };
  }));
  assert.equal(f.repo.scalar('savedBotLink'), true); assert.equal(f.patchCalls(), 0); assert.deepEqual(f.store, before);
});
test('a commit followed by a lost acknowledgement still refreshes cache and preserves the original write error', async t => {
  const f = fixture(t), unknown = new Error('commit result unknown');
  await assert.rejects(f.writer(() => {
    f.commit([{ collection: 'members', id: 'm', record: { id: 'm', revision: 1 } }]);
    throw unknown;
  }), error => error === unknown);
  assert.equal(f.store.members.find(row => row.id === 'm').revision, 1); assert.equal(f.patchCalls(), 1);
});
test('cache failure cannot change a committed success into failure; next call retries current DB values', async t => {
  const f = fixture(t, { beforePatch({ patchCalls }) { if (patchCalls === 1) throw new Error('cache unavailable'); } });
  const first = await f.writer(() => f.commit([{ collection: 'members', id: 'm', record: { id: 'm', revision: 1 } }]));
  assert.equal(first.content, 'Steam link saved'); assert.equal(f.repo.get('members', 'm').revision, 1);
  assert.equal(f.store.members.some(row => row.id === 'm'), false);
  // Another real store writer may advance the same row before the retry.
  await f.queue(() => f.repo.put('members', { id: 'm', revision: 2 }));
  const second = await f.writer(() => ({ content: 'Already linked' }));
  assert.equal(second.content, 'Already linked'); assert.equal(f.store.members.find(row => row.id === 'm').revision, 2);
  assert.equal(f.patchCalls(), 2);
});
test('cache failure never masks the original uncertain commit error', async t => {
  const f = fixture(t, { beforePatch() { throw new Error('cache error'); } }), unknown = new Error('unknown commit');
  await assert.rejects(f.writer(() => {
    f.commit([{ collection: 'members', id: 'm', record: { id: 'm' } }]); throw unknown;
  }), error => error === unknown);
  assert.equal(f.repo.get('members', 'm').id, 'm');
});
test('removed relationships are deleted and duplicate outbox entries read the current DB row only', async t => {
  const f = fixture(t); f.repo.put('squadMembers', { id: 'old', memberId: 'm', squadId: 'cn' });
  f.store.squadMembers.push(f.repo.get('squadMembers', 'old'));
  await f.writer(() => f.repo.transaction(() => {
    f.repo.remove('squadMembers', 'old');
    f.repo.put('squadMembers', { id: 'new', memberId: 'm', squadId: 'eu' });
    f.outbox([{ collection: 'squadMembers', id: 'old', deleted: true }, { collection: 'squadMembers', id: 'new' }]);
    f.repo.put('members', { id: 'm', revision: 2 });
    f.outbox([{ collection: 'members', id: 'm', record: { id: 'm', revision: 1 } }, { collection: 'members', id: 'm' }]);
    return { content: 'saved' };
  }));
  assert.deepEqual(f.store.squadMembers, [{ id: 'new', memberId: 'm', squadId: 'eu' }]);
  assert.equal(f.store.members.find(row => row.id === 'm').revision, 2);
});
test('missing optional outbox and unsupported outbox collections do not block or corrupt Steam saves', async t => {
  const f = fixture(t);
  await f.writer(() => f.repo.transaction(() => {
    f.outbox([{ collection: '__proto__', id: 'x' }, { collection: 'settings', id: 'ignored' }]); return { saved: true };
  }));
  assert.equal(f.patchCalls(), 0); assert.equal(Object.hasOwn(f.store, 'settings'), false);
  f.db.exec('DROP TABLE v2_member_admin_outbox');
  assert.deepEqual(await f.writer(() => f.repo.transaction(() => { f.repo.setScalar('botSaved', true); return { saved: true }; })), { saved: true });
  assert.equal(f.repo.scalar('botSaved'), true);
});
