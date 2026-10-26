import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyStoreCollectionCachePatch,
  cloneRecordsForPatch,
  collectionDeletePatch,
  collectionFullPatchFromBeforeAfter,
  diffStoreCollections,
  patchCachedScopedRecords,
  recordPatchById,
  replaceCachedRecord,
  sqliteRecordDeltaById,
  snapshotStoreCollections,
  storeRecordPatchSignature
} from '../server/storage/store-patch-diff.js';

test('store patch diff tracks upserts and deletes by id', () => {
  const beforeStore = {
    members: [
      { id: 'member_1', steamId: '76561190000000001', nickname: 'Old' },
      { id: 'member_2', steamId: '76561190000000002', nickname: 'Delete me' },
      { steamId: 'missing-id', nickname: 'Ignored' }
    ],
    logs: [{ id: 'log_1', type: 'member_edit' }]
  };
  const afterStore = {
    members: [
      { id: 'member_1', steamId: '76561190000000001', nickname: 'New' },
      { id: 'member_3', steamId: '76561190000000003', nickname: 'Added' },
      { steamId: 'still-missing-id', nickname: 'Ignored too' }
    ],
    logs: [{ id: 'log_1', type: 'member_edit' }]
  };

  const before = snapshotStoreCollections(beforeStore, ['members', 'logs']);
  const diff = diffStoreCollections(before, afterStore, ['members', 'logs']);

  assert.equal(diff.changed, true);
  assert.deepEqual(diff.upserts, {
    members: [
      { id: 'member_1', steamId: '76561190000000001', nickname: 'New' },
      { id: 'member_3', steamId: '76561190000000003', nickname: 'Added' }
    ]
  });
  assert.deepEqual(diff.deletes, {
    members: ['member_2']
  });
});

test('store patch diff returns unchanged when signatures match', () => {
  const store = {
    syncJobs: [
      { id: 'sync_job_1', status: 'running', updatedAt: '2026-07-08T00:00:00.000Z' }
    ]
  };
  const signature = (record = {}) => storeRecordPatchSignature({
    id: record.id,
    status: record.status
  });
  const before = snapshotStoreCollections(store, ['syncJobs'], signature);
  const after = {
    syncJobs: [
      { id: 'sync_job_1', status: 'running', updatedAt: '2026-07-08T00:01:00.000Z' }
    ]
  };

  const diff = diffStoreCollections(before, after, ['syncJobs'], signature);

  assert.deepEqual(diff, { upserts: {}, deletes: {}, changed: false });
});

test('recordPatchById upserts the full after set and deletes missing ids', () => {
  const before = [
    { id: 'squad_member_1', memberId: 'member_1', squadId: 'squad_a' },
    { id: 'squad_member_2', memberId: 'member_2', squadId: 'squad_a' }
  ];
  const after = [
    { id: 'squad_member_1', memberId: 'member_1', squadId: 'squad_a' },
    { id: 'squad_member_3', memberId: 'member_3', squadId: 'squad_b' },
    { memberId: 'member_without_id', squadId: 'ignored' }
  ];

  assert.deepEqual(recordPatchById(before, after), {
    upserts: [
      { id: 'squad_member_1', memberId: 'member_1', squadId: 'squad_a' },
      { id: 'squad_member_3', memberId: 'member_3', squadId: 'squad_b' }
    ],
    deletes: ['squad_member_2']
  });
});

test('collectionFullPatchFromBeforeAfter only upserts changed records', () => {
  const before = [
    { id: 'wipe_participant_1', status: 'attending' },
    { id: 'wipe_participant_2', status: 'attending' }
  ];
  const after = [
    { id: 'wipe_participant_1', status: 'attending' },
    { id: 'wipe_participant_2', status: 'not_attending' },
    { id: 'wipe_participant_3', status: 'attending' }
  ];

  assert.deepEqual(collectionFullPatchFromBeforeAfter(before, after), {
    upserts: [
      { id: 'wipe_participant_2', status: 'not_attending' },
      { id: 'wipe_participant_3', status: 'attending' }
    ],
    deletes: []
  });
});

test('sqliteRecordDeltaById preserves changed-record delta semantics', () => {
  const before = [
    { id: 'rule_1', enabled: true },
    { id: 'rule_2', enabled: true }
  ];
  const after = [
    { id: 'rule_1', enabled: true },
    { id: 'rule_2', enabled: false },
    { id: 'rule_3', enabled: true }
  ];

  assert.deepEqual(sqliteRecordDeltaById(before, after), {
    upserts: [
      { id: 'rule_2', enabled: false },
      { id: 'rule_3', enabled: true }
    ],
    deletes: []
  });
});

test('collectionDeletePatch returns removed id or key values', () => {
  const before = [
    { id: 'member_1' },
    { key: 'dismissal_1' },
    { id: 'member_2' },
    { nickname: 'ignored' }
  ];
  const after = [
    { id: 'member_1' },
    { key: 'dismissal_2' }
  ];

  assert.deepEqual(collectionDeletePatch(before, after), ['dismissal_1', 'member_2']);
});

test('replaceCachedRecord updates existing records, appends new records, and ignores missing ids', () => {
  const records = [
    { id: 'member_1', nickname: 'Old' }
  ];

  assert.equal(replaceCachedRecord(records, { id: 'member_1', nickname: 'New' }), records);
  assert.deepEqual(records, [{ id: 'member_1', nickname: 'New' }]);

  replaceCachedRecord(records, { id: 'member_2', nickname: 'Added' });
  replaceCachedRecord(records, { nickname: 'Ignored' });

  assert.deepEqual(records, [
    { id: 'member_1', nickname: 'New' },
    { id: 'member_2', nickname: 'Added' }
  ]);
});

test('cloneRecordsForPatch returns deep-cloned records', () => {
  const records = [
    { id: 'kda_row_1', stats: { kills: 1 } }
  ];

  const cloned = cloneRecordsForPatch(records);
  cloned[0].stats.kills = 3;

  assert.deepEqual(records, [
    { id: 'kda_row_1', stats: { kills: 1 } }
  ]);
  assert.deepEqual(cloned, [
    { id: 'kda_row_1', stats: { kills: 3 } }
  ]);
});

test('patchCachedScopedRecords removes missing scoped ids and upserts after records', () => {
  const cache = {
    kdaRows: [
      { id: 'row_1', kills: 1 },
      { id: 'row_2', kills: 2 },
      { id: 'row_outside_scope', kills: 9 }
    ]
  };
  const before = [
    { id: 'row_1', kills: 1 },
    { id: 'row_2', kills: 2 }
  ];
  const after = [
    { id: 'row_1', kills: 3 },
    { id: 'row_3', kills: 4 }
  ];

  patchCachedScopedRecords(cache, 'kdaRows', before, after);

  assert.deepEqual(cache.kdaRows, [
    { id: 'row_1', kills: 3 },
    { id: 'row_outside_scope', kills: 9 },
    { id: 'row_3', kills: 4 }
  ]);
});

test('applyStoreCollectionCachePatch applies collection updates and keeps logs newest first', () => {
  const cache = {
    members: [
      { id: 'member_1', nickname: 'Old' },
      { id: 'member_2', nickname: 'Delete' }
    ],
    logs: [
      { id: 'log_old', createdAt: '2026-07-08T00:00:00.000Z' }
    ]
  };

  applyStoreCollectionCachePatch(cache, ['members', 'logs'], {
    members: [
      { id: 'member_1', nickname: 'New' },
      { id: 'member_3', nickname: 'Added' }
    ],
    logs: [
      { id: 'log_new', createdAt: '2026-07-08T01:00:00.000Z' }
    ]
  }, {
    members: ['member_2']
  });

  assert.deepEqual(cache.members, [
    { id: 'member_1', nickname: 'New' },
    { id: 'member_3', nickname: 'Added' }
  ]);
  assert.deepEqual(cache.logs.map((log) => log.id), ['log_new', 'log_old']);
});

test('applyStoreCollectionCachePatch caps logs and syncJobs at one thousand records', () => {
  const cache = {
    logs: Array.from({ length: 1000 }, (_, index) => ({
      id: `log_${index}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
    })),
    syncJobs: Array.from({ length: 1000 }, (_, index) => ({
      id: `sync_job_${index}`,
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
    }))
  };

  applyStoreCollectionCachePatch(cache, ['logs', 'syncJobs'], {
    logs: [{ id: 'log_latest', createdAt: '2026-01-01T01:00:00.000Z' }],
    syncJobs: [{ id: 'sync_job_latest', updatedAt: '2026-01-01T01:00:00.000Z' }]
  });

  assert.equal(cache.logs.length, 1000);
  assert.equal(cache.syncJobs.length, 1000);
  assert.equal(cache.logs[0].id, 'log_latest');
  assert.equal(cache.syncJobs[0].id, 'sync_job_latest');
});
