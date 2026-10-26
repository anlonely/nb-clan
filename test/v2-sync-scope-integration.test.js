import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/v2-sync-center/fixture.mjs';
import { readSqliteCollectionRecord, upsertSqliteCollectionRecord } from '../server/storage/sqlite-migrate.js';

test('sync squad and wipe scopes share canonical empty-string membership semantics', async t => {
  const f = fixture();
  t.after(() => f.close());
  const link = f.repo.all('squadMembers').find(row => row.memberId === 'g05_alpha' && !row.validTo);
  assert.ok(link);
  f.repo.put('squadMembers', { ...link, validTo: '' });
  const resolve = scope => f.authority.resolveScope({ actor: f.actor(), type: 'kda', scope }).targets.map(row => row.memberId);
  assert.ok(resolve({ kind: 'squad', id: link.squadId }).includes(link.memberId));
  assert.ok(resolve({ kind: 'current_wipe', id: 'fixture-wipe' }).includes(link.memberId));
  const wipe = readSqliteCollectionRecord(f.db, 'v2Wipes', 'fixture-wipe');
  upsertSqliteCollectionRecord(f.db, 'v2Wipes', wipe.id, { ...wipe, audience: { squadIds: [], memberIds: [], includeUnassigned: true } });
  assert.equal(resolve({ kind: 'current_wipe', id: wipe.id }).includes(link.memberId), false);
  f.repo.put('squadMembers', { ...link, validTo: '2026-09-08T00:00:00Z' });
  assert.equal(resolve({ kind: 'squad', id: link.squadId }).includes(link.memberId), false);
  assert.ok(resolve({ kind: 'current_wipe', id: wipe.id }).includes(link.memberId));
});
