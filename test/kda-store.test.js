import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function queryCount(status, name) {
  return status.sqlite?.queries?.byName?.[name]?.total || 0;
}

test('sqlite-primary empty KDA runtime stores avoid full store fallback', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-kda-store-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE
  };
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');

  try {
    const storeModule = await import('../server/store.js');
    const kdaStoreModule = await import('../server/kda-store.js');
    await storeModule.ensureStore();

    const before = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const runtimeStore = await kdaStoreModule.readKdaRuntimeStore({ reference: 'current' });
    const rankingStore = await kdaStoreModule.readMemberRankingRuntimeStore({ reference: 'wechatRanking' });
    const after = await storeModule.storeRuntimeStatus({ sqliteSummary: false });

    assert.equal(after.metrics.reads.total, before.metrics.reads.total);
    assert.equal(after.metrics.clones.total, before.metrics.clones.total);
    assert.deepEqual(runtimeStore.members, []);
    assert.deepEqual(runtimeStore.wipes, []);
    assert.deepEqual(runtimeStore.kdaRows, []);
    assert.deepEqual(rankingStore.members, []);
    assert.deepEqual(rankingStore.wipes, []);
    assert.deepEqual(rankingStore.kdaRows, []);
  } finally {
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('sqlite-primary KDA stores fail closed on scoped read failures', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-kda-store-fallback-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE
  };
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');

  try {
    const storeModule = await import('../server/store.js');
    const kdaStoreModule = await import('../server/kda-store.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();

    const beforeRuntimeFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteQueryFailureForTests('list_wipes', 1);
    await assert.rejects(
      () => kdaStoreModule.readKdaRuntimeStore({ reference: 'current' }),
      (error) => error?.status === 503 && /KDA 数据读取暂不可用/.test(error.message)
    );
    const afterRuntimeFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(afterRuntimeFailure.metrics.reads.total, beforeRuntimeFailure.metrics.reads.total);
    assert.equal(afterRuntimeFailure.metrics.clones.total, beforeRuntimeFailure.metrics.clones.total);
    assert.equal(queryCount(afterRuntimeFailure, 'read_store_full'), queryCount(beforeRuntimeFailure, 'read_store_full'));

    const beforeWriteFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteQueryFailureForTests('list_logs', 1);
    await assert.rejects(
      () => kdaStoreModule.readKdaWriteStore({ reference: 'current' }),
      (error) => error?.status === 503 && /KDA 写入前置读取暂不可用/.test(error.message)
    );
    const afterWriteFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(afterWriteFailure.metrics.reads.total, beforeWriteFailure.metrics.reads.total);
    assert.equal(afterWriteFailure.metrics.clones.total, beforeWriteFailure.metrics.clones.total);
    assert.equal(queryCount(afterWriteFailure, 'read_store_full'), queryCount(beforeWriteFailure, 'read_store_full'));

    const beforeMemberSyncFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteQueryFailureForTests('list_members_steamId', 1);
    await assert.rejects(
      () => kdaStoreModule.readMemberKdaSyncRequestStore('member_kda_sync_failure', '76561198001112223'),
      (error) => error?.status === 503 && /成员 KDA 同步前置读取暂不可用/.test(error.message)
    );
    const afterMemberSyncFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(afterMemberSyncFailure.metrics.reads.total, beforeMemberSyncFailure.metrics.reads.total);
    assert.equal(afterMemberSyncFailure.metrics.clones.total, beforeMemberSyncFailure.metrics.clones.total);
    assert.equal(queryCount(afterMemberSyncFailure, 'read_store_full'), queryCount(beforeMemberSyncFailure, 'read_store_full'));

    const beforeRankingFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteQueryFailureForTests('list_wipes', 1);
    await assert.rejects(
      () => kdaStoreModule.readMemberRankingRuntimeStore({ reference: 'wechatRanking', scopeMembersToRows: true }),
      (error) => error?.status === 503 && /成员排名读取暂不可用/.test(error.message)
    );
    const afterRankingFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(afterRankingFailure.metrics.reads.total, beforeRankingFailure.metrics.reads.total);
    assert.equal(afterRankingFailure.metrics.clones.total, beforeRankingFailure.metrics.clones.total);
    assert.equal(queryCount(afterRankingFailure, 'read_store_full'), queryCount(beforeRankingFailure, 'read_store_full'));
  } finally {
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('sqlite-primary KDA runtime store scopes concrete wipe member reads', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-kda-runtime-scope-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE
  };
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');

  try {
    const storeModule = await import('../server/store.js');
    const kdaStoreModule = await import('../server/kda-store.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();
    const createdAt = '2026-07-08T00:00:00.000Z';
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_kda_runtime_scope_seed',
      upserts: {
        wipes: [{
          id: 'wipe_kda_runtime_scope',
          name: 'KDA Runtime Scope',
          status: 'closed',
          startedAt: createdAt,
          closedAt: createdAt,
          createdAt,
          updatedAt: createdAt
        }],
        squads: [
          { id: 'squad_kda_runtime_scope', name: 'KDA Scope Squad', createdAt, updatedAt: createdAt },
          { id: 'squad_kda_runtime_other', name: 'KDA Other Squad', createdAt, updatedAt: createdAt }
        ],
        members: [
          {
            id: 'member_kda_runtime_scope',
            steamId: '76561198008880001',
            rawInput: '76561198008880001',
            customName: 'KDA Runtime Scope',
            steamNickname: 'KdaRuntimeScope',
            avatar: '',
            discordId: '',
            wechatId: '',
            wechatUserId: '',
            notes: '',
            specialty: [],
            memberStatus: 'active',
            invitedByUserId: '',
            createdAt,
            updatedAt: createdAt
          },
          {
            id: 'member_kda_runtime_other',
            steamId: '76561198008880002',
            rawInput: '76561198008880002',
            customName: 'KDA Runtime Other',
            steamNickname: 'KdaRuntimeOther',
            avatar: '',
            discordId: '',
            wechatId: '',
            wechatUserId: '',
            notes: '',
            specialty: [],
            memberStatus: 'active',
            invitedByUserId: '',
            createdAt,
            updatedAt: createdAt
          }
        ],
        squadMembers: [
          {
            id: 'squad_member_kda_runtime_scope',
            squadId: 'squad_kda_runtime_scope',
            memberId: 'member_kda_runtime_scope',
            role: 'member',
            createdAt,
            updatedAt: createdAt
          },
          {
            id: 'squad_member_kda_runtime_other',
            squadId: 'squad_kda_runtime_other',
            memberId: 'member_kda_runtime_other',
            role: 'member',
            createdAt,
            updatedAt: createdAt
          }
        ],
        wipeParticipants: [{
          id: 'participant_kda_runtime_scope',
          wipeId: 'wipe_kda_runtime_scope',
          memberId: 'member_kda_runtime_scope',
          squadId: 'squad_kda_runtime_scope',
          status: 'on_time',
          source: 'test',
          createdAt,
          updatedAt: createdAt
        }],
        kdaRows: [{
          id: 'kda_row_runtime_scope',
          wipeId: 'wipe_kda_runtime_scope',
          memberId: 'member_kda_runtime_scope',
          steamId: '76561198008880001',
          squadId: 'squad_kda_runtime_scope',
          kills: 12,
          deaths: 3,
          kda: 4,
          createdAt,
          updatedAt: createdAt
        }]
      }
    });

    const before = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const runtimeStore = await kdaStoreModule.readKdaRuntimeStore({
      wipeIds: ['wipe_kda_runtime_scope'],
      scopeMembersToRows: true
    });
    const after = await storeModule.storeRuntimeStatus({ sqliteSummary: false });

    assert.deepEqual(runtimeStore.wipes.map((wipe) => wipe.id), ['wipe_kda_runtime_scope']);
    assert.deepEqual(runtimeStore.members.map((member) => member.id), ['member_kda_runtime_scope']);
    assert.deepEqual(runtimeStore.squadMembers.map((item) => item.memberId), ['member_kda_runtime_scope']);
    assert.deepEqual(runtimeStore.squads.map((squad) => squad.id), ['squad_kda_runtime_scope']);
    assert.deepEqual(runtimeStore.kdaRows.map((row) => row.id), ['kda_row_runtime_scope']);
    assert.equal(queryCount(after, 'list_users'), queryCount(before, 'list_users'));
    assert.equal(queryCount(after, 'list_members'), queryCount(before, 'list_members'));
    assert.equal(queryCount(after, 'list_squads'), queryCount(before, 'list_squads'));
    assert.equal(queryCount(after, 'list_squadMembers'), queryCount(before, 'list_squadMembers'));
    assert.equal(queryCount(after, 'list_permissionRoles'), queryCount(before, 'list_permissionRoles'));
    assert.equal(queryCount(after, 'list_wipes'), queryCount(before, 'list_wipes'));
    assert.equal(queryCount(after, 'list_wipes_id') > queryCount(before, 'list_wipes_id'), true);
    assert.equal(queryCount(after, 'list_kdaRows_wipeId') > queryCount(before, 'list_kdaRows_wipeId'), true);
    assert.equal(queryCount(after, 'list_members_id') > queryCount(before, 'list_members_id'), true);
    assert.equal(queryCount(after, 'list_squadMembers_memberId') > queryCount(before, 'list_squadMembers_memberId'), true);
    assert.equal(queryCount(after, 'list_squads_id') > queryCount(before, 'list_squads_id'), true);
  } finally {
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('sqlite-primary generated KDA write store reads only the target wipe', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-kda-generated-store-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE
  };
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');

  try {
    const storeModule = await import('../server/store.js');
    const kdaStoreModule = await import('../server/kda-store.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_generated_kda_store_seed',
      upserts: {
        wipes: [
          {
            id: 'wipe_generated_kda_target',
            name: 'Generated KDA Target',
            status: 'active',
            startedAt: '2026-07-08T00:00:00.000Z',
            createdAt: '2026-07-08T00:00:00.000Z',
            updatedAt: '2026-07-08T00:00:00.000Z'
          },
          {
            id: 'wipe_generated_kda_other',
            name: 'Generated KDA Other',
            status: 'closed',
            startedAt: '2026-06-08T00:00:00.000Z',
            closedAt: '2026-06-15T00:00:00.000Z',
            createdAt: '2026-06-08T00:00:00.000Z',
            updatedAt: '2026-06-15T00:00:00.000Z'
          },
          {
            id: 'wipe_generated_kda_closed_all_members',
            name: 'Generated KDA Closed All Members',
            status: 'closed',
            kdaMemberScope: 'all_members',
            startedAt: '2026-06-20T00:00:00.000Z',
            closedAt: '2026-06-27T00:00:00.000Z',
            createdAt: '2026-06-20T00:00:00.000Z',
            updatedAt: '2026-06-27T00:00:00.000Z'
          }
        ],
        members: [
          {
            id: 'member_generated_kda_steam',
            steamId: '76561198007770001',
            rawInput: '76561198007770001',
            customName: 'Generated KDA Steam',
            steamNickname: 'GeneratedKdaSteam',
            avatar: '',
            discordId: '',
            wechatId: '',
            wechatUserId: '',
            notes: '',
            specialty: [],
            memberStatus: 'active',
            invitedByUserId: '',
            createdAt: '2026-07-08T00:00:00.000Z',
            updatedAt: '2026-07-08T00:00:00.000Z'
          },
          {
            id: 'member_generated_kda_no_steam',
            steamId: '',
            rawInput: '',
            customName: 'Generated KDA No Steam',
            steamNickname: '',
            avatar: '',
            discordId: '',
            wechatId: '',
            wechatUserId: '',
            notes: '',
            specialty: [],
            memberStatus: 'active',
            invitedByUserId: '',
            createdAt: '2026-07-08T00:00:00.000Z',
            updatedAt: '2026-07-08T00:00:00.000Z'
          }
        ],
        wipeParticipants: [{
          id: 'participant_generated_kda_steam',
          wipeId: 'wipe_generated_kda_target',
          memberId: 'member_generated_kda_steam',
          squadId: '',
          status: 'on_time',
          source: 'test',
          createdAt: '2026-07-08T00:00:00.000Z',
          updatedAt: '2026-07-08T00:00:00.000Z'
        }, {
          id: 'participant_generated_kda_other',
          wipeId: 'wipe_generated_kda_other',
          memberId: 'member_generated_kda_steam',
          squadId: '',
          status: 'on_time',
          source: 'test',
          createdAt: '2026-06-08T00:00:00.000Z',
          updatedAt: '2026-06-08T00:00:00.000Z'
        }, {
          id: 'participant_generated_kda_no_steam',
          wipeId: 'wipe_generated_kda_closed_all_members',
          memberId: 'member_generated_kda_no_steam',
          squadId: '',
          status: 'on_time',
          source: 'test',
          createdAt: '2026-06-20T00:00:00.000Z',
          updatedAt: '2026-06-20T00:00:00.000Z'
        }]
      }
    });

    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const before = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const store = await kdaStoreModule.readGeneratedKdaRowsWriteStore('wipe_generated_kda_target');
    const after = await storeModule.storeRuntimeStatus({ sqliteSummary: false });

    assert.deepEqual(store.wipes.map((wipe) => wipe.id), ['wipe_generated_kda_target']);
    assert.deepEqual(store.members.map((member) => member.id), ['member_generated_kda_steam']);
    assert.equal(queryCount(after, 'list_wipes'), queryCount(before, 'list_wipes'));
    assert.equal(queryCount(after, 'list_members'), queryCount(before, 'list_members'));
    assert.equal(queryCount(after, 'get_wipes'), queryCount(before, 'get_wipes') + 1);
    assert.equal(queryCount(after, 'list_members_steamId_present'), queryCount(before, 'list_members_steamId_present') + 1);

    const beforeClosedParticipant = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const closedParticipantStore = await kdaStoreModule.readGeneratedKdaRowsWriteStore('wipe_generated_kda_other');
    const afterClosedParticipant = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.deepEqual(closedParticipantStore.wipes.map((wipe) => wipe.id), ['wipe_generated_kda_other']);
    assert.deepEqual(closedParticipantStore.members.map((member) => member.id), ['member_generated_kda_steam']);
    assert.equal(queryCount(afterClosedParticipant, 'list_members'), queryCount(beforeClosedParticipant, 'list_members'));
    assert.equal(queryCount(afterClosedParticipant, 'list_members_steamId_present'), queryCount(beforeClosedParticipant, 'list_members_steamId_present'));
    assert.equal(queryCount(afterClosedParticipant, 'list_members_id') > queryCount(beforeClosedParticipant, 'list_members_id'), true);

    const beforeClosedAllMembers = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const closedAllMembersStore = await kdaStoreModule.readGeneratedKdaRowsWriteStore('wipe_generated_kda_closed_all_members', {
      refreshSettlement: true
    });
    const afterClosedAllMembers = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.deepEqual(closedAllMembersStore.wipes.map((wipe) => wipe.id), ['wipe_generated_kda_closed_all_members']);
    assert.equal(closedAllMembersStore.members.some((member) => member.id === 'member_generated_kda_steam'), true);
    assert.equal(closedAllMembersStore.members.some((member) => member.id === 'member_generated_kda_no_steam'), true);
    assert.equal(queryCount(afterClosedAllMembers, 'list_members'), queryCount(beforeClosedAllMembers, 'list_members'));
    assert.equal(queryCount(afterClosedAllMembers, 'list_members_steamId_present'), queryCount(beforeClosedAllMembers, 'list_members_steamId_present') + 1);
    assert.equal(queryCount(afterClosedAllMembers, 'list_members_id') > queryCount(beforeClosedAllMembers, 'list_members_id'), true);
  } finally {
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('sqlite-primary KDA write store loads all member profiles for scoped writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-kda-write-profile-scope-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE
  };
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');

  try {
    const storeModule = await import('../server/store.js');
    const kdaStoreModule = await import('../server/kda-store.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();
    const createdAt = '2026-08-01T00:00:00.000Z';
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_kda_write_profile_scope_seed',
      upserts: {
        wipes: [{
          id: 'wipe_kda_write_profile_scope',
          name: 'KDA Write Profile Scope',
          status: 'active',
          startedAt: createdAt,
          createdAt,
          updatedAt: createdAt
        }],
        members: [
          { id: 'member_kda_write_profile_in_scope', steamId: '76561198008880101', createdAt, updatedAt: createdAt },
          { id: 'member_kda_write_profile_out_of_scope', steamId: '76561198008880102', createdAt, updatedAt: createdAt }
        ],
        wipeParticipants: [{
          id: 'participant_kda_write_profile_scope',
          wipeId: 'wipe_kda_write_profile_scope',
          memberId: 'member_kda_write_profile_in_scope',
          createdAt,
          updatedAt: createdAt
        }],
        kdaRows: [{
          id: 'kda_row_kda_write_profile_scope',
          wipeId: 'wipe_kda_write_profile_scope',
          memberId: 'member_kda_write_profile_in_scope',
          steamId: '76561198008880101',
          createdAt,
          updatedAt: createdAt
        }],
        memberProfiles: [
          { id: 'member_profile_kda_write_profile_in_scope', memberId: 'member_kda_write_profile_in_scope', steamId: '76561198008880101', fetchedAt: createdAt },
          { id: 'member_profile_kda_write_profile_out_of_scope', memberId: 'member_kda_write_profile_out_of_scope', steamId: '76561198008880102', fetchedAt: createdAt }
        ]
      }
    });

    const scopedRuntimeStore = await kdaStoreModule.readKdaRuntimeStore({ wipeIds: ['wipe_kda_write_profile_scope'] });
    assert.deepEqual(scopedRuntimeStore.memberProfiles.map((profile) => profile.memberId), ['member_kda_write_profile_in_scope']);

    const writeStore = await kdaStoreModule.readKdaWriteStore({
      wipeIds: ['wipe_kda_write_profile_scope'],
      includeLogs: false
    });
    assert.deepEqual(
      writeStore.memberProfiles.map((profile) => profile.memberId).toSorted(),
      ['member_kda_write_profile_in_scope', 'member_kda_write_profile_out_of_scope']
    );

    await assert.doesNotReject(() => kdaStoreModule.updateKdaWriteStore((store) => {
      const member = store.members.find((item) => item.id === 'member_kda_write_profile_out_of_scope');
      const existing = store.memberProfiles.find((profile) => profile.memberId === member?.id);
      if (existing) existing.displayName = 'Updated from scoped writer';
      else {
        store.memberProfiles.push({
          id: 'member_profile_kda_write_profile_out_of_scope_new',
          memberId: member.id,
          steamId: member.steamId,
          displayName: 'Updated from scoped writer'
        });
      }
    }, 'sqlite_test_kda_write_profile_scope_update', {
      wipeIds: ['wipe_kda_write_profile_scope'],
      includeLogs: false,
      syncJobs: false
    }));
    const persistedProfiles = await repositoryModule.getSqliteRecordsByJsonField(
      'memberProfiles',
      'memberId',
      ['member_kda_write_profile_out_of_scope'],
      { limit: 0 }
    );
    assert.equal(persistedProfiles.length, 1);
    assert.equal(persistedProfiles[0].id, 'member_profile_kda_write_profile_out_of_scope');
    assert.equal(persistedProfiles[0].displayName, 'Updated from scoped writer');
  } finally {
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
