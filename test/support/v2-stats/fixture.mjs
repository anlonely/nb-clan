import { fixtureIdentity } from '../scoped-identity-fake.mjs';
import { DatabaseSync } from 'node:sqlite';
import { installIdentitySchema, IdentityRepository } from '../../../server/v2/identity/repository.js';
import { applyIdentityMigration, planIdentityMigration } from '../../../server/v2/identity/migration.js';
import { IdentityService } from '../../../server/v2/identity/service.js';
import { installSchedulingSchema, SchedulingRepository } from '../../../server/v2/scheduling/repository.js';
import { applySchedulingMigration, planSchedulingMigration } from '../../../server/v2/scheduling/migration.js';
import { upsertSqliteCollectionRecord } from '../../../server/storage/sqlite-migrate.js';
import { seedIdentities } from '../v2-member-space/fixtures.mjs';
import { StatsService } from '../../../server/v2/stats/service.js';
import { installStatsSchema } from '../../../server/v2/stats/repository.js';
import { createExportRenderer } from '../../../server/v2/stats/exports.js';
export function fixture(file = ':memory:', {
  renderBinary, scopeContract = false
} = {}) {
  if (file && typeof file === 'object') { scopeContract = file.scopeContract === true; renderBinary = file.renderBinary; file = file.file || ':memory:'; }
  const db = new DatabaseSync(file);
  installIdentitySchema(db);
  const ir = new IdentityRepository(db);
  applyIdentityMigration(ir, planIdentityMigration({}));
  installSchedulingSchema(db);
  const sr = new SchedulingRepository(db);
  applySchedulingMigration(sr, planSchedulingMigration({}));
  seedIdentities(ir);
  ir.put('accounts', { ...ir.get('accounts', 'g05_account_admin'), adminAssignedByOwner: true });
  installStatsSchema(db);
  const identity = fixtureIdentity(ir, {
      scopeContract, providers: {}
    }),
    put = (c, r) => upsertSqliteCollectionRecord(db, c, r.id, r);
  const at = new Date().toISOString();
  for (const [id, title, life] of [['g07_active', '北境主服 · 九月长档', 'active'], ['g07_history', '北境主服 · 上期结算', 'ended']]) {
    sr.put('wipes', {
      id,
      title,
      lifecycle: life,
      revision: 1,
      contentRevision: 1,
      archiveRevision: 0,
      serverProfileId: 'local-server-1',
      audience: {
        squadIds: ['g05_squad', 'g05_foreign_squad'],
        memberIds: [],
        includeUnassigned: false
      }
    });
    put('wipes', {
      id,
      name: title,
      status: life === 'active' ? 'active' : 'closed',
      kdaMemberScope: 'all_members'
    });
    for (const [i, m] of ir.all('members').entries()) put('kdaRows', {
      id: `${id}:${m.id}`,
      wipeId: id,
      memberId: m.id,
      displayName: m.displayName,
      steamId: m.steamId,
      source: 'vital',
      sourceId: 'vital',
      serverId: 'local-server-1',
      providerWipeId: 'period-9',
      sourceRevision: 3,
      capabilities: {
        assists: true
      },
      kills: i === 0 ? 0 : 20 + i * 10,
      deaths: i,
      assists: i === 1 ? null : i + 2,
      t3Kills: 10 + i,
      rockets: i * 7,
      sulfur: 10000 + i * 3300,
      metalOre: 8800 + i * 2100,
      building: 120 + i * 10,
      onlineTimeMinutes: 45 + i * 12,
      capturedAt: i === 2 ? new Date(Date.now() - 7200000).toISOString() : at,
      syncedAt: at,
      coverage: 'wipe'
    });
  }
  const syncJobs = new Map();
  let sourceCalls = 0;
  const queryResult = input => ({
    steamId: input.steamId,
    displayName: '构造玩家',
    fetchedAt: new Date().toISOString(),
    status: 'fresh',
    rows: [{
      id: 'query-row',
      sourceId: input.sourceId,
      serverId: input.serverId || 'official-lifetime',
      providerWipeId: input.providerWipeId || 'lifetime',
      kills: 38,
      deaths: 0,
      assists: null,
      capabilities: {
        assists: false
      },
      capturedAt: new Date().toISOString()
    }],
    fields: [{
      name: 'Rust 总游戏时长',
      value: '1280 小时',
      status: 'observed'
    }, {
      name: '身份匹配置信度',
      value: 'direct',
      status: 'observed'
    }]
  });
  const providers = Object.fromEntries(['official', 'vital', 'moose', 'member'].map(source => [source, async input => {
    sourceCalls++;
    return queryResult({
      ...input,
      sourceId: source
    });
  }]));
  providers.inventory = async input => {
    sourceCalls++;
    return {
      steamId: input.steamId,
      status: input.steamId.endsWith('505') ? 'private' : 'fresh',
      inventory: {
        status: input.steamId.endsWith('505') ? 'private' : 'fresh',
        currency: 'USD',
        total: 31.2,
        items: Array.from({
          length: 63
        }, (_, i) => ({
          name: i < 60 ? `构造皮肤 ${i + 1}` : `构造 DLC ${i - 59}`,
          quantity: 1,
          price: 0.5,
          tradable: i % 2 === 0,
          dlc: i >= 60
        }))
      }
    };
  };
  providers.catalog = async () => ({
    items: [{
      id: 'local-server-1',
      name: 'Vital 构造主服',
      serverId: 'local-server-1',
      providerWipeId: 'period-9',
      category: 'combat'
    }, {
      id: 'moose-local',
      name: 'Moose 构造服',
      serverId: 'moose-local',
      providerWipeId: '2026-09',
      category: 'raiding'
    }]
  });
  const options = {
    providers,
    renderExport: createExportRenderer({
      renderBinary
    }),
    authorizeWrite: (a, action) => a.id === 'g05_account_admin' && ['stats.import', 'stats.import.member', 'stats.sync', 'history.visibility'].includes(action),
    writeCurrent: apply => {
      db.exec('SAVEPOINT fixture_writer');
      try {
        const result = apply();
        if (!result.replayed) for (const row of result.upserts || []) {
          put('kdaRows', row);
          put('kdaSnapshots', {
            ...row,
            id: `${row.id}:${row.sourceRevision}`,
            capturedAt: row.syncedAt
          });
        }
        db.exec('RELEASE fixture_writer');
        return result;
      } catch (e) {
        db.exec('ROLLBACK TO fixture_writer');
        db.exec('RELEASE fixture_writer');
        throw e;
      }
    },
    enqueueSync: async ({
      actor,
      operationId,
      wipeId,
      sourceId
    }) => {
      const key = actor.id + ':' + operationId;
      if (!syncJobs.has(key)) syncJobs.set(key, {
        id: operationId,
        wipeId,
        sourceId,
        status: 'queued',
        counts: { total: 5, succeeded: 0, partial: 0, failed: 0, skipped: 0, pendingOrRunning: 5 }
      });
      return { job: structuredClone(syncJobs.get(key)) };
    },
    readSync: ({
      jobId
    }) => {
      const job = [...syncJobs.values()].find(j => j.id === jobId);
      if (!job) return null;
      // Controlled local progress exercises the production DTO and polling;
      // this fixture never calls an external source.
      if (job.status === 'queued') {
        job.status = 'running';
        job.counts = { ...job.counts, succeeded: 1, pendingOrRunning: 4 };
      } else if (job.status === 'running') {
        job.status = 'succeeded';
        job.counts = { ...job.counts, succeeded: 5, pendingOrRunning: 0 };
      }
      return structuredClone(job);
    }
  };
  const service = new StatsService(identity, options);
  return {
    db,
    ir,
    sr,
    identity,
    service,
    options,
    put,
    admin: () => identity.actorForAccount('g05_account_admin'),
    member: () => identity.actorForAccount('g05_account_alpha'),
    foreign: () => identity.actorForAccount('g05_account_foreign'),
    sourceCalls: () => sourceCalls
  };
}
