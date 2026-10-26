import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

function uniqueImport(file) {
  return import(`${file}?wechat-directory-sqlite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function queryCount(status, name) {
  return status.sqlite?.queries?.byName?.[name]?.total || 0;
}

test('sqlite-primary wechat member directory squad filters avoid full member reads', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-wechat-directory-sqlite-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_WECHAT_DEV_LOGIN: process.env.NB_WECHAT_DEV_LOGIN,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS
  };
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_WECHAT_DEV_LOGIN = '1';
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';
  process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS = '0';

  let server = null;
  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    await storeModule.ensureStore();

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

    const loginResponse = await fetch(`${baseUrl}/wechat/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: 'wechat-directory-scoped-login',
        profile: { nickname: 'Directory Scoped' }
      })
    });
    assert.equal(loginResponse.status, 200);
    const loginPayload = await loginResponse.json();
    const wechatUserId = loginPayload.wechatUser.id;
    const token = loginPayload.sessionToken;
    const createdAt = '2026-07-09T00:00:00.000Z';

    await storeModule.updateStore((store) => {
      store.squads.push(
        {
          id: 'squad_wechat_directory_alpha',
          name: 'Wechat Directory Alpha',
          leaderUserIds: [],
          archivedAt: '',
          createdAt,
          updatedAt: createdAt
        },
        {
          id: 'squad_wechat_directory_beta',
          name: 'Wechat Directory Beta',
          leaderUserIds: [],
          archivedAt: '',
          createdAt,
          updatedAt: createdAt
        }
      );
      store.members.push(
        {
          id: 'member_wechat_directory_alpha_a',
          steamId: '76561198009000001',
          rawInput: '76561198009000001',
          customName: 'Alpha A',
          steamNickname: 'Alpha A',
          avatar: '',
          discordId: '',
          wechatId: wechatUserId,
          wechatUserId,
          notes: '',
          specialty: [],
          memberStatus: 'active',
          invitedByUserId: '',
          createdAt,
          updatedAt: createdAt
        },
        {
          id: 'member_wechat_directory_alpha_b',
          steamId: '76561198009000002',
          rawInput: '76561198009000002',
          customName: 'Alpha B',
          steamNickname: 'Alpha B',
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
          id: 'member_wechat_directory_beta',
          steamId: '76561198009000003',
          rawInput: '76561198009000003',
          customName: 'Beta Member',
          steamNickname: 'Beta Member',
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
          id: 'member_wechat_directory_unassigned',
          steamId: '76561198009000004',
          rawInput: '76561198009000004',
          customName: 'Unassigned Member',
          steamNickname: 'Unassigned Member',
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
      );
      store.squadMembers.push(
        { id: 'squad_member_wechat_directory_alpha_a', squadId: 'squad_wechat_directory_alpha', memberId: 'member_wechat_directory_alpha_a', addedByUserId: 'user_root', createdAt },
        { id: 'squad_member_wechat_directory_alpha_b', squadId: 'squad_wechat_directory_alpha', memberId: 'member_wechat_directory_alpha_b', addedByUserId: 'user_root', createdAt },
        { id: 'squad_member_wechat_directory_beta', squadId: 'squad_wechat_directory_beta', memberId: 'member_wechat_directory_beta', addedByUserId: 'user_root', createdAt }
      );
      const wechatUser = store.wechatUsers.find((item) => item.id === wechatUserId);
      wechatUser.status = 'approved';
      wechatUser.role = 'member';
      wechatUser.memberId = 'member_wechat_directory_alpha_a';
      wechatUser.updatedAt = createdAt;
    });

    const beforeSquadStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeListMembers = queryCount(beforeSquadStatus, 'list_members');
    const beforeListSquadMembers = queryCount(beforeSquadStatus, 'list_squadMembers');
    const beforeReadStoreFull = queryCount(beforeSquadStatus, 'read_store_full');
    const squadResponse = await fetch(`${baseUrl}/wechat/members?limit=10&squadId=squad_wechat_directory_alpha`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const squadPayload = await squadResponse.json();
    assert.equal(squadResponse.status, 200, JSON.stringify(squadPayload));
    assert.equal(squadPayload.total, 2);
    assert.deepEqual(squadPayload.members.map((member) => member.id), [
      'member_wechat_directory_alpha_a',
      'member_wechat_directory_alpha_b'
    ]);
    assert.equal(squadPayload.squads.find((squad) => squad.id === 'squad_wechat_directory_alpha')?.memberCount, 2);
    assert.equal(squadPayload.hasNoSquad, true);
    const afterSquadStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterSquadStatus, 'list_members'), beforeListMembers);
    assert.equal(queryCount(afterSquadStatus, 'list_squadMembers'), beforeListSquadMembers);
    assert.equal(queryCount(afterSquadStatus, 'read_store_full'), beforeReadStoreFull);

    const beforeUnassignedStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeUnassignedListMembers = queryCount(beforeUnassignedStatus, 'list_members');
    const beforeUnassignedListSquadMembers = queryCount(beforeUnassignedStatus, 'list_squadMembers');
    const beforeUnassignedReadStoreFull = queryCount(beforeUnassignedStatus, 'read_store_full');
    const unassignedResponse = await fetch(`${baseUrl}/wechat/members?limit=10&squadId=__none__`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const unassignedPayload = await unassignedResponse.json();
    assert.equal(unassignedResponse.status, 200, JSON.stringify(unassignedPayload));
    assert.equal(unassignedPayload.total, 1);
    assert.equal(unassignedPayload.members[0].id, 'member_wechat_directory_unassigned');
    assert.equal(unassignedPayload.hasNoSquad, true);
    const afterUnassignedStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterUnassignedStatus, 'list_members'), beforeUnassignedListMembers);
    assert.equal(queryCount(afterUnassignedStatus, 'list_squadMembers'), beforeUnassignedListSquadMembers);
    assert.equal(queryCount(afterUnassignedStatus, 'read_store_full'), beforeUnassignedReadStoreFull);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
