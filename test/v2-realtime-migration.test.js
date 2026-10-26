import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/v2-realtime/fixture.mjs';
import { migrateLegacyRelay } from '../server/v2/realtime/migration.js';
test('offline legacy migration preserves stable IDs, checkpoint/replay, provenance, and original input', t => {
  const f = fixture({});
  t.after(() => f.db.close());
  const store = {
      rustplusRelay: {
        chatMessages: Array.from({
          length: 63
        }, (_, i) => ({
          id: 'legacy-' + i,
          clientId: 'collector-a',
          serverKey: 'collector-a:server-a',
          sentAt: new Date(f.now() + i).toISOString(),
          receivedAt: new Date(f.now()).toISOString(),
          message: '历史原文 ' + i,
          translatedMessage: 'Legacy ' + i,
          secret: 'PRIVATE'
        }))
      }
    },
    before = JSON.stringify(store),
    count = () => f.db.prepare('SELECT COUNT(*) n FROM v2_realtime_records').get().n,
    start = count();
  const dry = migrateLegacyRelay(f.repo, store, {
    limit: 25
  });
  assert.equal(count(), start);
  let offset = 0,
    inserted = 0;
  do {
    const r = migrateLegacyRelay(f.repo, store, {
      dryRun: false,
      after: offset,
      limit: 25,
      sourceHash: dry.sourceHash
    });
    inserted += r.inserted;
    offset = r.next;
  } while (offset !== null);
  assert.equal(inserted, 63);
  assert.equal(count(), start + 63);
  assert.equal(migrateLegacyRelay(f.repo, store, {
    dryRun: false,
    limit: 100
  }).inserted, 0);
  assert.equal(before, JSON.stringify(store));
  assert.equal(f.db.prepare("SELECT payload FROM v2_realtime_records WHERE id='legacy-0'").get().payload.includes('PRIVATE'), false);
  assert.throws(() => migrateLegacyRelay(f.repo, store, {
    sourceHash: 'changed'
  }), e => e.errorCode === 'MIGRATION_SOURCE_CHANGED');
});
test('unmapped legacy source fails before any mutation', t => {
  const f = fixture({});
  t.after(() => f.db.close());
  const store = {
    rustplusRelay: {
      chatMessages: [{
        id: 'x',
        clientId: 'foreign-source',
        serverKey: 'unknown',
        sentAt: new Date().toISOString(),
        message: 'hidden'
      }]
    }
  };
  assert.equal(migrateLegacyRelay(f.repo, store).unmapped.length, 1);
  assert.throws(() => migrateLegacyRelay(f.repo, store, {
    dryRun: false
  }), e => e.errorCode === 'MIGRATION_SOURCE_UNMAPPED');
});
