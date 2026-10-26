import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function queryCount(status, name) {
  return status.sqlite?.queries?.byName?.[name]?.total || 0;
}

test('sqlite-primary wipe runtime reads fail closed without full store fallback', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-wipe-store-fallback-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS
  };
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';
  process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS = '0';

  try {
    const storeModule = await import('../server/store.js');
    const wipeStoreModule = await import('../server/wipe-store.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();

    const before = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteQueryFailureForTests('list_permissionRoles', 1);
    await assert.rejects(
      () => wipeStoreModule.readWipeAccessCheckStore({
        id: 'user_wipe_custom_role',
        username: 'wipe-custom-role',
        role: 'sqlite_wipe_viewer'
      }),
      (error) => error?.status === 503 && /档期权限读取暂不可用/.test(error.message)
    );
    const after = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(after.metrics.reads.total, before.metrics.reads.total);
    assert.equal(after.metrics.clones.total, before.metrics.clones.total);
    assert.equal(queryCount(after, 'read_store_full'), queryCount(before, 'read_store_full'));

    const beforeRuntime = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteQueryFailureForTests('list_members', 1);
    await assert.rejects(
      () => wipeStoreModule.readWipeRuntimeStore({
        includeSettings: true,
        includePermissionRoles: true
      }),
      (error) => error?.status === 503 && /档期数据读取暂不可用/.test(error.message)
    );
    const afterRuntime = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(afterRuntime.metrics.reads.total, beforeRuntime.metrics.reads.total);
    assert.equal(afterRuntime.metrics.clones.total, beforeRuntime.metrics.clones.total);
    assert.equal(queryCount(afterRuntime, 'read_store_full'), queryCount(beforeRuntime, 'read_store_full'));

    const beforeCurrent = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteQueryFailureForTests('list_wipes_status', 1);
    await assert.rejects(
      () => wipeStoreModule.readCurrentWipeRuntimeStore({
        includeUploads: true,
        includePermissionRoles: true,
        includeWipeSettlements: true
      }),
      (error) => error?.status === 503 && /当前档期数据读取暂不可用/.test(error.message)
    );
    const afterCurrent = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(afterCurrent.metrics.reads.total, beforeCurrent.metrics.reads.total);
    assert.equal(afterCurrent.metrics.clones.total, beforeCurrent.metrics.clones.total);
    assert.equal(queryCount(afterCurrent, 'read_store_full'), queryCount(beforeCurrent, 'read_store_full'));

    const beforeParticipantResponse = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteQueryFailureForTests('get_wipes', 1);
    await assert.rejects(
      () => wipeStoreModule.readWipeParticipantResponseStore('wipe_sqlite_failure', {
        includeUploads: true,
        includeWipeSettlements: true
      }),
      (error) => error?.status === 503 && /档期报名读取暂不可用/.test(error.message)
    );
    const afterParticipantResponse = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(afterParticipantResponse.metrics.reads.total, beforeParticipantResponse.metrics.reads.total);
    assert.equal(afterParticipantResponse.metrics.clones.total, beforeParticipantResponse.metrics.clones.total);
    assert.equal(queryCount(afterParticipantResponse, 'read_store_full'), queryCount(beforeParticipantResponse, 'read_store_full'));

    const beforeParticipantCandidates = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteQueryFailureForTests('list_members', 1);
    await assert.rejects(
      () => wipeStoreModule.readWipeParticipantCandidatesStore('current'),
      (error) => error?.status === 503 && /档期候选成员读取暂不可用/.test(error.message)
    );
    const afterParticipantCandidates = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(afterParticipantCandidates.metrics.reads.total, beforeParticipantCandidates.metrics.reads.total);
    assert.equal(afterParticipantCandidates.metrics.clones.total, beforeParticipantCandidates.metrics.clones.total);
    assert.equal(queryCount(afterParticipantCandidates, 'read_store_full'), queryCount(beforeParticipantCandidates, 'read_store_full'));
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
