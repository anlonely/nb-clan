import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

function uniqueImport(file) {
  return import(`${file}?member-profile-backfill-sqlite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function queryCount(status, name) {
  return status.sqlite?.queries?.byName?.[name]?.total || 0;
}

test('sqlite-primary visible member profile backfill direct-write failure avoids full store fallback', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-profile-backfill-sqlite-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS
  };
  const originalFetch = globalThis.fetch;
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';
  process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS = '0';

  let server = null;
  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();

    const steamId = '76561198009100001';
    globalThis.fetch = async (url, options) => {
      const href = String(url || '');
      if (href === `https://steamcommunity.com/profiles/${steamId}?xml=1`) {
        return new Response([
          '<profile>',
          `<steamID64>${steamId}</steamID64>`,
          '<steamID><![CDATA[Backfilled Nickname]]></steamID>',
          '<avatarFull><![CDATA[https://example.com/backfilled-avatar.png]]></avatarFull>',
          '<privacyState>public</privacyState>',
          '<visibilityState>3</visibilityState>',
          '</profile>'
        ].join(''), { status: 200, headers: { 'Content-Type': 'text/xml' } });
      }
      return originalFetch(url, options);
    };

    const createdAt = '2026-07-09T00:00:00.000Z';
    await storeModule.updateStore((store) => {
      store.members.push({
        id: 'member_profile_backfill_sqlite',
        steamId,
        rawInput: steamId,
        customName: '',
        steamNickname: '',
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
      });
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    const beforeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteQueryFailureForTests('list_members_id', 1);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ steamInput: steamId })
    });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.isMember, true);
    const afterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(afterStatus.metrics.writes.total, beforeStatus.metrics.writes.total);
    assert.equal(queryCount(afterStatus, 'read_store_full'), queryCount(beforeStatus, 'read_store_full'));

    const member = await repositoryModule.getSqliteRecord('members', 'member_profile_backfill_sqlite');
    assert.equal(member.avatar, '');
    assert.equal(member.steamNickname, '');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    globalThis.fetch = originalFetch;
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
