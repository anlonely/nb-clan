import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-member-profile-sync-'));
process.env.NB_DATA_DIR = dataDir;
process.env.NB_ROOT_PASSWORD = 'RootPass123!';
process.env.NB_STORAGE_MODE = 'sqlite-primary';
process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
process.env.NB_DISABLE_EXTERNAL_VITAL = '0';
process.env.NB_RUST_KDA_PROVIDER = 'http';
process.env.NB_RUST_KDA_BASE_URL = 'http://mock-rust-kda.local';
process.env.NB_RUST_KDA_REQUEST_TIMEOUT_MS = '1000';
process.env.NB_RUST_KDA_INVENTORY_REQUEST_TIMEOUT_MS = '1000';
process.env.NB_MEMBER_PROFILE_QUEUE_DELAY_MS = '0';
process.env.NB_STEAM_BROADCAST_REQUEST_INTERVAL_MS = '0';

const originalFetch = globalThis.fetch;
const sqliteModule = await import('../server/storage/sqlite.js');
try {
  const storeModule = await import('../server/store.js');
  const apiModule = await import('../server/api.js');
  const repositoryModule = await import('../server/storage/repository.js');
  await storeModule.ensureStore();
  const createdAt = '2026-08-16T00:00:00.000Z';
  const justBeforeDue = new Date(Date.now() - 24 * 60 * 60 * 1000 + 25).toISOString();
  const members = [
    { id: 'member_profile_initial_batch', steamId: '76561198009990101', createdAt, updatedAt: createdAt },
    { id: 'member_profile_follow_up_batch', steamId: '76561198009990102', createdAt, updatedAt: createdAt }
  ];
  await repositoryModule.writeSqliteStorePatch({
      reason: 'member_profile_sync_follow_up_seed',
      upserts: {
        members,
        memberProfiles: [{
          id: 'member_profile_follow_up_batch_cache',
          memberId: 'member_profile_follow_up_batch',
          steamId: '76561198009990102',
          fetchedAt: justBeforeDue
        }],
      syncJobs: [{
        id: 'sync_job_member_profile_initial_batch',
        type: 'member_profile',
        source: 'auto',
        scope: 'member_profile',
        status: 'queued',
        totalCount: 1,
        doneCount: 0,
        failedCount: 0,
        skippedCount: 0,
        percent: 0,
        createdAt,
        updatedAt: createdAt,
        metadata: {
          runner: 'sync_center',
          requestedMemberIds: ['member_profile_initial_batch'],
          statusKey: 'memberProfiles'
        }
      }]
    },
    scalars: { syncState: {} }
  });

  globalThis.fetch = async (url) => {
    const href = String(url);
    const playerMatch = href.match(/\/api\/player\/(\d+)/);
    const inventoryMatch = href.match(/\/api\/inventory\/(\d+)/);
    const kdaMatch = href.match(/\/api\/kda\/(\d+)/);
    const profileMatch = href.match(/\/profiles\/(\d+)\?xml=1/);
    if (playerMatch) {
      return new Response(JSON.stringify({
        name: `Rust ${playerMatch[1].slice(-4)}`,
        playTimeMinutes: 120,
        playTimeKnown: true,
        profilePublic: true
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (inventoryMatch) {
      return new Response(JSON.stringify({ totalSummary: { value: 10, currency: 'USD' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (kdaMatch) {
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (profileMatch) {
      const steamId = profileMatch[1];
      return new Response(`<?xml version="1.0"?><profile><steamID64>${steamId}</steamID64><steamID>Fresh ${steamId.slice(-4)}</steamID><privacyState>public</privacyState><visibilityState>3</visibilityState><avatarFull>https://avatar.test/${steamId}.jpg</avatarFull></profile>`, {
        status: 200,
        headers: { 'content-type': 'text/xml' }
      });
    }
    if (href.includes('/broadcast/getbroadcastmpd/')) {
      return new Response(JSON.stringify({ success: 'OK' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    throw new Error(`unexpected test request: ${href}`);
  };

  await new Promise((resolve) => setTimeout(resolve, 100));
  await apiModule.runQueuedSerialSyncJobsForTests();

  const persistedMembers = await repositoryModule.getSqliteCollection('members', { limit: 0 });
  const persistedProfiles = await repositoryModule.getSqliteCollection('memberProfiles', { limit: 0 });
  const persistedJobs = await repositoryModule.getSqliteCollection('syncJobs', { limit: 0 });
  assert.equal(persistedMembers.find((member) => member.id === 'member_profile_initial_batch')?.steamNickname, 'Fresh 0101');
  assert.equal(persistedMembers.find((member) => member.id === 'member_profile_follow_up_batch')?.steamNickname, 'Fresh 0102');
    assert.deepEqual(
      persistedProfiles.map((profile) => profile.memberId).toSorted(),
      ['member_profile_follow_up_batch', 'member_profile_initial_batch']
    );
    assert.equal(persistedJobs.filter((job) => job.type === 'member_profile' && job.status === 'completed').length, 2);
    assert.equal(persistedJobs.some((job) => job.type === 'member_profile' && ['queued', 'running'].includes(job.status)), false);

    const manualCreatedAt = new Date().toISOString();
    await repositoryModule.writeSqliteStorePatch({
      reason: 'member_profile_manual_follow_up_guard_seed',
      upserts: {
        members: [
          { id: 'member_profile_manual_target', steamId: '76561198009990103', createdAt: manualCreatedAt, updatedAt: manualCreatedAt },
          { id: 'member_profile_manual_untouched', steamId: '76561198009990104', createdAt: manualCreatedAt, updatedAt: manualCreatedAt }
        ],
        syncJobs: [{
          id: 'sync_job_member_profile_manual_guard',
          type: 'member_profile',
          source: 'manual',
          scope: 'member_profile',
          status: 'queued',
          totalCount: 1,
          doneCount: 0,
          failedCount: 0,
          skippedCount: 0,
          percent: 0,
          createdAt: manualCreatedAt,
          updatedAt: manualCreatedAt,
          metadata: {
            runner: 'sync_center',
            requestedMemberIds: ['member_profile_manual_target'],
            statusKey: 'memberProfiles'
          }
        }]
      }
    });
    await apiModule.runQueuedSerialSyncJobsForTests();
    const afterManualProfiles = await repositoryModule.getSqliteCollection('memberProfiles', { limit: 0 });
    const afterManualJobs = await repositoryModule.getSqliteCollection('syncJobs', { limit: 0 });
    assert.equal(afterManualProfiles.some((profile) => profile.memberId === 'member_profile_manual_target'), true);
    assert.equal(afterManualProfiles.some((profile) => profile.memberId === 'member_profile_manual_untouched'), false);
    assert.equal(afterManualJobs.filter((job) => job.type === 'member_profile' && job.status === 'completed').length, 3);
    assert.equal(afterManualJobs.some((job) => job.type === 'member_profile' && ['queued', 'running'].includes(job.status)), false);
  } finally {
  globalThis.fetch = originalFetch;
  await sqliteModule.closeSqliteDatabasesForTests();
  await rm(dataDir, { recursive: true, force: true });
}
